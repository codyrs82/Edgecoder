// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { spawn } from "node:child_process";
import vm from "node:vm";
import { Language, RunResult } from "../common/types.js";
import { checkSubset } from "./subset.js";
import { ensureSandboxImages, isDockerAvailable, runInDockerSandbox, type DockerSandboxOptions } from "./docker-sandbox.js";
import { log } from "../common/logger.js";
import { PYTHON_NOT_FOUND, resolvePython } from "./python-interpreter.js";

function baseResult(language: Language, durationMs: number): RunResult {
  return {
    language,
    ok: false,
    stdout: "",
    stderr: "",
    exitCode: 1,
    durationMs,
    queueForCloud: false
  };
}

/**
 * Opt-in for running the local user's code on the host when Docker is not available.
 * The subset validators are a filter, not a sandbox: node:vm is not a security boundary and
 * `python3 -c` runs with the user's privileges and environment. So local code runs in the Docker
 * sandbox, and on the host only when EDGECODER_UNSAFE_HOST_EXECUTION=1 is set (or a caller passes
 * sandbox "host" with origin "local" explicitly). Remote-origin work never runs on the host.
 */
export function unsafeHostExecutionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EDGECODER_UNSAFE_HOST_EXECUTION === "1";
}

export async function runCode(
  language: Language,
  code: string,
  timeoutMs = 4_000,
  sandbox: "host" | "docker" = "docker",
  dockerOptions?: DockerSandboxOptions,
  origin: "local" | "remote" = "remote"
): Promise<RunResult> {
  const start = Date.now();
  // #45: host execution is only for the local user's own code (IDE/interactive).
  // Anything that came from the swarm, a mesh peer or BLE must run in Docker.
  if (origin === "remote" && sandbox === "host") {
    return { ...baseResult(language, 0), ok: false, stderr: "sandbox_required_for_remote_task" };
  }
  const subset = await checkSubset(language, code);
  if (!subset.supported) {
    return {
      ...baseResult(language, Date.now() - start),
      stderr: subset.reason ?? "outside subset",
      queueForCloud: true,
      queueReason: "outside_subset"
    };
  }

  if (sandbox === "docker") {
    const dockerOk = await isDockerAvailable();
    if (dockerOk) {
      if (origin === "local") {
        // The worker builds the images at startup; an IDE-only install may not have them yet.
        const images = await ensureSandboxImages();
        if (!images.ok) {
          return { ...baseResult(language, Date.now() - start), stderr: `sandbox_unavailable: ${images.error}` };
        }
      }
      return runInDockerSandbox(language, code, timeoutMs, dockerOptions);
    }
    if (origin !== "local" || !unsafeHostExecutionAllowed()) {
      log.error("Docker sandbox required but Docker is not available — rejecting task");
      return {
        ...baseResult(language, Date.now() - start),
        stderr: origin === "local"
          ? "sandbox_unavailable: Docker is required to run code. Start Docker, or set EDGECODER_UNSAFE_HOST_EXECUTION=1 to run it unsandboxed on this machine"
          : "sandbox_unavailable: Docker is required for swarm task execution but is not running",
        ok: false,
      };
    }
    log.warn("Docker is not available; running local code on the host (EDGECODER_UNSAFE_HOST_EXECUTION=1)");
  }

  if (language === "python") {
    return runPython(code, timeoutMs, start);
  }

  return runJavaScript(code, timeoutMs, start);
}

async function runPython(code: string, timeoutMs: number, start: number): Promise<RunResult> {
  const python = await resolvePython();
  if (!python) return { ...baseResult("python", Date.now() - start), stderr: PYTHON_NOT_FOUND };
  return new Promise<RunResult>((resolve) => {
    const proc = spawn(python.command, [...python.args, "-c", code], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // A spawn failure is an 'error' event; unhandled, it would kill the process.
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...baseResult("python", Date.now() - start), stderr: `could not run ${python.command}: ${err.message}` });
    });

    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill("SIGKILL");
        settled = true;
        resolve({
          language: "python",
          ok: false,
          stdout,
          stderr: `${stderr}\nExecution timed out`,
          exitCode: 124,
          durationMs: Date.now() - start,
          queueForCloud: true,
          queueReason: "timeout",
          // A timeout before any output can't be told apart from a stalled runner: the agent's.
          executed: stdout.length > 0
        });
      }
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (codeValue) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      const exitCode = codeValue ?? 1;
      resolve({
        language: "python",
        ok: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - start,
        queueForCloud: false,
        executed: true
      });
    });
  });
}

async function runJavaScript(code: string, timeoutMs: number, start: number): Promise<RunResult> {
  const captured: string[] = [];
  const sandbox = {
    console: {
      log: (...args: unknown[]) => captured.push(args.join(" "))
    }
  };

  try {
    vm.createContext(sandbox);
    const script = new vm.Script(code);
    script.runInContext(sandbox, { timeout: timeoutMs });
    return {
      language: "javascript",
      ok: true,
      stdout: captured.join("\n"),
      stderr: "",
      exitCode: 0,
      durationMs: Date.now() - start,
      queueForCloud: false,
      executed: true
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = message.toLowerCase().includes("script execution timed out");
    return {
      language: "javascript",
      ok: false,
      stdout: captured.join("\n"),
      stderr: message,
      exitCode: timeout ? 124 : 1,
      durationMs: Date.now() - start,
      queueForCloud: timeout,
      queueReason: timeout ? "timeout" : undefined,
      // The script threw (or did not parse): the program failed. A silent timeout is the runner's.
      executed: !timeout || captured.length > 0
    };
  }
}

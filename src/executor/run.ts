import { spawn } from "node:child_process";
import vm from "node:vm";
import { Language, RunResult } from "../common/types.js";
import { checkSubset } from "./subset.js";
import { isDockerAvailable, runInDockerSandbox } from "./docker-sandbox.js";
import { log } from "../common/logger.js";

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

export async function runCode(
  language: Language,
  code: string,
  timeoutMs = 4_000,
  sandbox: "host" | "docker" = "host"
): Promise<RunResult> {
  const start = Date.now();
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
      return runInDockerSandbox(language, code, timeoutMs);
    }
    log.error("Docker sandbox required but Docker is not available — rejecting task");
    return {
      ...baseResult(language, Date.now() - start),
      stderr: "sandbox_unavailable: Docker is required for swarm task execution but is not running",
      ok: false,
    };
  }

  if (language === "python") {
    return runPython(code, timeoutMs, start);
  }

  return runJavaScript(code, timeoutMs, start);
}

async function runPython(code: string, timeoutMs: number, start: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const proc = spawn("python3", ["-c", code], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

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
          queueReason: "timeout"
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
        queueForCloud: false
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
      queueForCloud: false
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
      queueReason: timeout ? "timeout" : undefined
    };
  }
}

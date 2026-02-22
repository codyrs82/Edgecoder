import { spawn } from "node:child_process";
import { Language, RunResult } from "../common/types.js";

const DOCKER_IMAGES: Record<Language, string> = {
  python: "edgecoder/sandbox-python:latest",
  javascript: "edgecoder/sandbox-node:latest"
};

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn("docker", ["info"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function runInDockerSandbox(
  language: Language,
  code: string,
  timeoutMs = 10000
): Promise<RunResult> {
  const start = Date.now();
  const image = DOCKER_IMAGES[language];

  return new Promise<RunResult>((resolve) => {
    const args = [
      "run", "--rm",
      "--network=none",
      "--read-only",
      "--memory=256m",
      "--cpus=0.5",
      "--pids-limit=50",
      image,
      code
    ];

    const proc = spawn("docker", args, {
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
          language,
          ok: false,
          stdout,
          stderr: `${stderr}\nDocker execution timed out`,
          exitCode: 124,
          durationMs: Date.now() - start,
          queueForCloud: true,
          queueReason: "timeout"
        });
      }
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (exitCode) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({
        language,
        ok: (exitCode ?? 1) === 0,
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - start,
        queueForCloud: false
      });
    });

    proc.on("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({
        language,
        ok: false,
        stdout,
        stderr: `Docker sandbox error: ${error.message}`,
        exitCode: 1,
        durationMs: Date.now() - start,
        queueForCloud: false
      });
    });
  });
}

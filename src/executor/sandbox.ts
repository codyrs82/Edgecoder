import { platform } from "node:os";

export interface SandboxParams {
  language: "python" | "javascript";
  memoryLimitMB: number;
  cpuTimeLimitSec: number;
  timeoutMs: number;
}

export interface SandboxConfig {
  timeoutMs: number;
  memoryLimitMB: number;
  cpuTimeLimitSec: number;
  noFileCreation: boolean;
  noNetwork: boolean;
  useSeccomp: boolean;
  useNamespaces: boolean;
  useSandboxExec: boolean;
  sandboxProfile?: string;
}

export function createSandboxConfig(params: SandboxParams): SandboxConfig {
  const base: SandboxConfig = {
    timeoutMs: params.timeoutMs,
    memoryLimitMB: params.memoryLimitMB,
    cpuTimeLimitSec: params.cpuTimeLimitSec,
    noFileCreation: true,
    noNetwork: true,
    useSeccomp: false,
    useNamespaces: false,
    useSandboxExec: false,
  };

  const os = platform();

  if (os === "linux") {
    base.useSeccomp = true;
    base.useNamespaces = true;
  } else if (os === "darwin") {
    base.useSandboxExec = true;
    base.sandboxProfile = generateDarwinProfile(params.language);
  }

  return base;
}

function generateDarwinProfile(language: "python" | "javascript"): string {
  const runtime = language === "python" ? "/usr/bin/python3" : "/usr/local/bin/node";
  return `(version 1)
(deny default)
(allow process-exec (literal "${runtime}"))
(allow file-read* (subpath "/usr/lib") (subpath "/usr/local/lib"))
(deny network*)
(deny file-write*)
(deny process-fork)`;
}

export function buildSpawnArgs(
  config: SandboxConfig,
  language: "python" | "javascript",
  code: string
): { command: string; args: string[] } {
  if (language === "python") {
    if (config.useSandboxExec && config.sandboxProfile) {
      return {
        command: "sandbox-exec",
        args: ["-p", config.sandboxProfile, "python3", "-c", code],
      };
    }
    return { command: "python3", args: ["-c", code] };
  }

  return {
    command: "node",
    args: [
      `--max-old-space-size=${config.memoryLimitMB}`,
      "--disallow-code-generation-from-strings",
      "-e",
      code,
    ],
  };
}

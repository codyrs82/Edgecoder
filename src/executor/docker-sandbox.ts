// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { spawn } from "node:child_process";
import { Language, RunResult, SandboxPolicy } from "../common/types.js";

const DOCKER_IMAGES: Record<Language, string> = {
  python: "edgecoder/sandbox-python:latest",
  javascript: "edgecoder/sandbox-node:latest"
};

let dockerProbeCache: { value: boolean; at: number } | undefined;
let dockerProbeInFlight: Promise<boolean> | undefined;
const DOCKER_PROBE_TTL_MS = 30_000;
/** Negative results expire sooner so a cold-starting daemon is picked up quickly. */
const DOCKER_PROBE_NEGATIVE_TTL_MS = 5_000;
const DEFAULT_DOCKER_PROBE_TIMEOUT_MS = 3_000;

/** DOCKER_PROBE_TIMEOUT_MS, falling back to 3 s when unset, empty, non-numeric or <= 0. */
export function dockerProbeTimeoutMs(raw: string | undefined = process.env.DOCKER_PROBE_TIMEOUT_MS): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_DOCKER_PROBE_TIMEOUT_MS;
}

/**
 * #32: probe the Docker daemon with a hard timeout (kills a hung `docker info`),
 * caching the answer for 30 s so per-loop callers stay cheap.
 */
export async function isDockerAvailable(
  timeoutMs: number = dockerProbeTimeoutMs()
): Promise<boolean> {
  if (dockerProbeCache) {
    const ttl = dockerProbeCache.value ? DOCKER_PROBE_TTL_MS : DOCKER_PROBE_NEGATIVE_TTL_MS;
    if (Date.now() - dockerProbeCache.at < ttl) return dockerProbeCache.value;
  }
  // Concurrent callers share one `docker info` process.
  if (dockerProbeInFlight) return dockerProbeInFlight;
  dockerProbeInFlight = probeDocker(timeoutMs).then((value) => {
    dockerProbeCache = { value, at: Date.now() };
    dockerProbeInFlight = undefined;
    return value;
  });
  return dockerProbeInFlight;
}

function probeDocker(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", windowsHide: true });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    proc.on("close", (code) => finish(code === 0));
    proc.on("error", () => finish(false));
  });
}

/** Test hook: forget the cached probe result. */
export function __resetDockerProbeCache(): void {
  dockerProbeCache = undefined;
  dockerProbeInFlight = undefined;
}

export interface DockerSandboxOptions {
  memoryMB?: number;       // Memory limit in megabytes (default: 256)
  cpuPercent?: number;     // CPU limit as percentage, 100 = 1 full core (default: 50)
  networkAccess?: boolean; // Allow network access (default: false)
  readOnly?: boolean;      // Read-only filesystem (default: true)
}

/** Build the Docker CLI flags from a SandboxPolicy or explicit options. */
export function buildDockerArgs(
  image: string,
  code: string,
  options?: DockerSandboxOptions
): string[] {
  const memoryMB = options?.memoryMB ?? 256;
  const cpuPercent = options?.cpuPercent ?? 50;
  const networkAccess = options?.networkAccess ?? false;
  const readOnly = options?.readOnly ?? true;

  const args: string[] = ["run", "--rm"];

  if (!networkAccess) {
    args.push("--network=none");
  }
  if (readOnly) {
    args.push("--read-only");
  }

  args.push(`--memory=${memoryMB}m`);
  args.push(`--cpus=${(cpuPercent / 100).toFixed(2)}`);
  args.push("--pids-limit=50");
  args.push(image);
  args.push(code);

  return args;
}

/** Convert a SandboxPolicy into DockerSandboxOptions. */
export function policyToDockerOptions(policy?: SandboxPolicy): DockerSandboxOptions {
  if (!policy) return {};
  return {
    memoryMB: policy.maxMemoryMB,
    cpuPercent: policy.maxCpuPercent,
    networkAccess: policy.networkAccess,
    readOnly: true
  };
}

export async function runInDockerSandbox(
  language: Language,
  code: string,
  timeoutMs = 10000,
  options?: DockerSandboxOptions
): Promise<RunResult> {
  const start = Date.now();
  const image = DOCKER_IMAGES[language];

  return new Promise<RunResult>((resolve) => {
    const args = buildDockerArgs(image, code, options);

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

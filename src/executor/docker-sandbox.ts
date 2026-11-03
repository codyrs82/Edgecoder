// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Language, RunResult, SandboxPolicy } from "../common/types.js";

const DOCKER_IMAGES: Record<Language, string> = {
  python: "edgecoder/sandbox-python:latest",
  javascript: "edgecoder/sandbox-node:latest"
};

/**
 * The sandbox images are not published; the worker builds them on first use. Keep these in sync
 * with docker/sandbox-*.Dockerfile (a test compares them).
 */
export const SANDBOX_DOCKERFILES: Record<Language, string> = {
  python: `FROM python:3.12-slim@sha256:6b25cbe6577518889d553cdd5a5da97d259348d8f6e45b527dd731caaba27a07
RUN useradd -m -s /bin/sh sandbox
USER sandbox
WORKDIR /home/sandbox
ENTRYPOINT ["python3", "-c"]
`,
  javascript: `FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN useradd -m -s /bin/sh sandbox
USER sandbox
WORKDIR /home/sandbox
ENTRYPOINT ["node", "-e"]
`
};

function dockerExit(args: string[], stdin?: string, timeoutMs = 600_000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("docker", args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stderr: String(err) });
      return;
    }
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    proc.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    proc.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stderr: String(err) }); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stderr }); });
    if (stdin !== undefined) proc.stdin?.end(stdin);
  });
}

let sandboxImagesInFlight: Promise<{ ok: true } | { ok: false; error: string }> | undefined;

/**
 * Build any missing sandbox image from SANDBOX_DOCKERFILES (no build context needed). Concurrent
 * callers share one build; a failure is returned, not thrown, and a later call retries.
 */
export function ensureSandboxImages(): Promise<{ ok: true } | { ok: false; error: string }> {
  sandboxImagesInFlight ??= (async () => {
    for (const language of Object.keys(DOCKER_IMAGES) as Language[]) {
      const image = DOCKER_IMAGES[language];
      if ((await dockerExit(["image", "inspect", image], undefined, 30_000)).code === 0) continue;
      const built = await dockerExit(["build", "-t", image, "-"], SANDBOX_DOCKERFILES[language]);
      if (built.code !== 0) return { ok: false as const, error: `building ${image} failed: ${built.stderr.trim().split("\n").pop() ?? ""}` };
    }
    return { ok: true as const };
  })().finally(() => {
    sandboxImagesInFlight = undefined;
  });
  return sandboxImagesInFlight;
}

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
  /** Container name (`--name`); runInDockerSandbox sets a unique one per run so it can kill it. */
  name?: string;
  /** Aborting stops the container like a timeout does. */
  signal?: AbortSignal;
  /** Per-stream capture cap in bytes (default SANDBOX_MAX_OUTPUT_BYTES, else 1 MiB). */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const OUTPUT_TRUNCATED_MARKER = "\n[edgecoder: output truncated]";

/** SANDBOX_MAX_OUTPUT_BYTES, falling back to 1 MiB when unset or invalid. */
export function sandboxMaxOutputBytes(raw: string | undefined = process.env.SANDBOX_MAX_OUTPUT_BYTES): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_OUTPUT_BYTES;
}

/**
 * Stop a sandbox container on the daemon side: killing the `docker run` client does not stop the
 * container. `docker kill`, then `docker rm -f`, then `docker inspect` to confirm it is gone.
 */
export async function stopSandboxContainer(name: string, timeoutMs = 15_000): Promise<{ removed: boolean }> {
  await dockerExit(["kill", name], undefined, timeoutMs);
  await dockerExit(["rm", "-f", name], undefined, timeoutMs);
  // inspect fails (non-zero) once the container no longer exists.
  const inspect = await dockerExit(["container", "inspect", name], undefined, timeoutMs);
  return { removed: inspect.code !== 0 };
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
  if (options?.name) args.push(`--name=${options.name}`);

  if (!networkAccess) {
    args.push("--network=none");
  }
  if (readOnly) {
    args.push("--read-only");
  }

  args.push(`--memory=${memoryMB}m`);
  args.push(`--cpus=${(cpuPercent / 100).toFixed(2)}`);
  args.push("--pids-limit=50");
  // #45: least-privilege container.
  args.push(
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    "--ulimit=nofile=256:256"
  );
  if (process.env.SANDBOX_SECCOMP_PROFILE) {
    args.push(`--security-opt=seccomp=${process.env.SANDBOX_SECCOMP_PROFILE}`);
  }
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
  const name = options?.name ?? `edgecoder-sbx-${randomUUID()}`;
  const maxBytes = options?.maxOutputBytes ?? sandboxMaxOutputBytes();
  const signal = options?.signal;

  return new Promise<RunResult>((resolve) => {
    const args = buildDockerArgs(image, code, { ...options, name });

    const proc = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const size = { stdout: 0, stderr: 0 };
    let truncated = false;
    let settled = false;
    let stopping = false;
    const text = (k: "stdout" | "stderr") => Buffer.concat(out[k]).toString() + (truncated && size[k] >= maxBytes ? OUTPUT_TRUNCATED_MARKER : "");

    const finish = (result: Omit<RunResult, "language" | "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ language, durationMs: Date.now() - start, ...result });
    };

    /** Stop the run: kill the client, then the container itself, and report why. */
    const stop = (reason: "timeout" | "aborted" | "output_limit") => {
      if (settled || stopping) return;
      stopping = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      const note = reason === "timeout" ? "Docker execution timed out" : reason === "aborted" ? "Docker execution aborted" : `Docker execution stopped: output exceeded ${maxBytes} bytes`;
      void stopSandboxContainer(name).then(({ removed }) => {
        const cleanup = removed ? "" : `\nsandbox container ${name} could not be confirmed removed`;
        if (!removed) console.warn(`[sandbox] container ${name} still present after kill/rm`);
        finish({
          ok: false,
          stdout: text("stdout"),
          stderr: `${text("stderr")}\n${note}${cleanup}`,
          exitCode: reason === "timeout" ? 124 : 137,
          queueForCloud: reason === "timeout",
          ...(reason === "timeout" ? { queueReason: "timeout" as const } : {})
        });
      });
      // Nothing more is captured once stopping.
      proc.stdout?.removeAllListeners("data");
      proc.stderr?.removeAllListeners("data");
    };

    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("aborted");
    if (signal) {
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const capture = (k: "stdout" | "stderr") => (chunk: Buffer) => {
      if (settled || stopping) return;
      const room = maxBytes - size[k];
      if (chunk.length > room) {
        if (room > 0) out[k].push(chunk.subarray(0, room));
        size[k] = maxBytes;
        truncated = true;
        stop("output_limit");
        return;
      }
      out[k].push(chunk);
      size[k] += chunk.length;
    };
    proc.stdout.on("data", capture("stdout"));
    proc.stderr.on("data", capture("stderr"));

    proc.on("close", (exitCode) => {
      if (settled || stopping) return;
      finish({
        ok: (exitCode ?? 1) === 0,
        stdout: text("stdout"),
        stderr: text("stderr"),
        exitCode: exitCode ?? 1,
        queueForCloud: false
      });
    });

    proc.on("error", (error) => {
      if (settled || stopping) return;
      // The client failed (e.g. docker missing); make sure no container was left behind.
      void stopSandboxContainer(name).catch(() => undefined);
      finish({
        ok: false,
        stdout: text("stdout"),
        stderr: `Docker sandbox error: ${error.message}`,
        exitCode: 1,
        queueForCloud: false
      });
    });
  });
}

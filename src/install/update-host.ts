// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The real UpdateDeps for update.ts: https-only downloads with size caps, argv-only commands, and
 * a status-file reader that never follows a link or blocks on a FIFO (the file lives in the
 * service account's own directory, so it is treated as untrusted input).
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, createWriteStream, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { BinFs } from "./binaries.js";
import { AGENT_STATUS_FILE } from "../swarm/update-drain.js";
import { HttpStatusError, rateLimitRetryAt, type AgentStatus, type UpdateDeps } from "./update.js";

const MAX_REDIRECTS = 5;
const USER_AGENT = "edgecoder-install-update";

/** GET `url`, following redirects by hand so every hop must be https. */
export async function httpsGet(url: string, timeoutMs: number): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (u.protocol !== "https:") throw new Error(`refusing a non-https URL: ${u.protocol}//${u.host}`);
    const res = await fetch(u, { redirect: "manual", headers: { "user-agent": USER_AGENT, accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status} without a location from ${u.host}`);
      current = new URL(loc, u).toString();
      continue;
    }
    if (res.status !== 200) throw new HttpStatusError(`HTTP ${res.status} from ${u.host}${u.pathname}`, res.status, rateLimitRetryAt(res.status, res.headers, Date.now()));
    return res;
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects for ${url}`);
}

async function fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
  const res = await httpsGet(url, 60_000);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function fetchToFile(url: string, dest: string, maxBytes: number): Promise<void> {
  const res = await httpsGet(url, 30 * 60_000);
  if (!res.body) throw new Error(`empty response for ${url}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`);
  let total = 0;
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  body.on("data", (c: Buffer) => {
    total += c.length;
    if (total > maxBytes) body.destroy(new Error(`${url} is larger than ${maxBytes} bytes`));
  });
  await pipeline(body, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
}

/** Parse agent-status.json; null for anything that is not one. */
export function parseAgentStatus(text: string): AgentStatus | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
    const s: AgentStatus = {
      pid: num(j.pid),
      version: typeof j.version === "string" ? j.version.slice(0, 64) : "",
      startedAtMs: num(j.startedAtMs),
      updatedAtMs: num(j.updatedAtMs),
      registered: j.registered === true,
      draining: j.draining === true,
      busy: num(j.busy),
      ...(typeof j.drainSignal === "string" ? { drainSignal: j.drainSignal } : {})
    };
    return [s.pid, s.startedAtMs, s.updatedAtMs, s.busy].some(Number.isNaN) ? null : s;
  } catch {
    return null;
  }
}

/** Read a small regular file without following a symlink at its last component or blocking on a FIFO. */
export function readUntrustedSmallFile(path: string, maxBytes = 16 << 10): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function realUpdateDeps(opts: { binFs: BinFs; writeText: UpdateDeps["writeText"]; stateDir: string; log?: (line: string) => void }): UpdateDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: opts.log ?? ((line) => console.log(line)),
    fetchBytes,
    fetchToFile,
    run(cmd, args, env) {
      const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...(env ? { env: { ...process.env, ...env } } : {}) });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
    },
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeText: opts.writeText,
    exists: (path) => existsSync(path),
    listDir: (path) => readdirSync(path),
    rename: (from, to) => renameSync(from, to),
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
    makeTempDir: (prefix) => mkdtempSync(prefix),
    readAgentStatus(n) {
      const text = readUntrustedSmallFile(`${opts.stateDir}/agent-${n}/${AGENT_STATUS_FILE}`);
      return text === null ? null : parseAgentStatus(text);
    },
    binFs: opts.binFs,
    isRoot: typeof process.getuid === "function" && process.getuid() === 0
  };
}

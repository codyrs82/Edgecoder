// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Each instance's Ollama server needs its own port (11434, 11435, ...). A machine that already runs
 * Ollama (the stock ollama.service, or the Ollama app) holds 11434, and edgecoder-ollama-0 then never
 * starts: it stays "activating" while it retries the bind. The installer asks who listens on each
 * port, skips ports held by anything that isn't EdgeCoder's own server, and `status` names the holder.
 */
import { OLLAMA_BASE_PORT } from "./plan.js";
import type { Host } from "./services.js";

export interface PortOwner {
  pid?: number;
  /** Process name as the OS reports it (ollama, python3, ...). */
  process?: string;
  /** systemd unit (Linux) or launchd label (macOS) the process belongs to, when known. */
  unit?: string;
}

export type ReadText = (path: string) => string | undefined;

/** Linux: `ss -Hltnp "sport = :<port>"`; macOS: `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`. null = nothing listens (or the OS can't tell). */
export function portOwner(host: Pick<Host, "platform" | "run">, port: number, read: ReadText = () => undefined): PortOwner | null {
  if (host.platform === "linux") {
    const r = host.run("ss", ["-Hltnp", `sport = :${port}`]);
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(r.stdout);
    if (!m) return {};
    const pid = Number(m[2]);
    // 0::/system.slice/ollama.service (cgroup v2) or N:name=systemd:/system.slice/x.service (v1).
    const unit = /\/([^/\s]+\.service)\s*$/m.exec(read(`/proc/${pid}/cgroup`) ?? "")?.[1];
    return { pid, process: m[1], ...(unit ? { unit } : {}) };
  }
  if (host.platform === "darwin") {
    const r = host.run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const pid = Number(/^p(\d+)/m.exec(r.stdout)?.[1]);
    const proc = /^c(.+)$/m.exec(r.stdout)?.[1];
    if (!Number.isInteger(pid)) return {};
    // Ours when one of the io.edgecoder.ollama.<n> jobs runs this pid.
    for (let i = 0; i < 64; i++) {
      const job = host.run("launchctl", ["print", `system/io.edgecoder.ollama.${i}`]);
      if (job.code !== 0) break;
      if (new RegExp(`\\bpid = ${pid}\\b`).test(job.stdout)) return { pid, process: proc, unit: `io.edgecoder.ollama.${i}` };
    }
    return { pid, ...(proc ? { process: proc } : {}) };
  }
  return null;
}

/** EdgeCoder's own Ollama server (a re-run finds its previous one on the port: not a conflict). */
export function isEdgecoderOllama(owner: PortOwner): boolean {
  return Boolean(owner.unit && /^(edgecoder-ollama-\d+\.service|io\.edgecoder\.ollama\.\d+)$/.test(owner.unit));
}

/** "ollama.service", "ollama (pid 812)", or "another process". */
export function describeOwner(owner: PortOwner): string {
  if (owner.unit) return owner.unit;
  if (owner.process) return `${owner.process}${owner.pid ? ` (pid ${owner.pid})` : ""}`;
  return "another process";
}

/**
 * One Ollama port per instance, from 11434 up, skipping ports another program holds. With nothing in
 * the way that is 11434 + index, as before. Returns the ports and a note per skipped port.
 */
export function allocateOllamaPorts(count: number, ownerOf: (port: number) => PortOwner | null, base = OLLAMA_BASE_PORT, maxTries = 200): { ports: Record<number, number>; notes: string[] } {
  const ports: Record<number, number> = {};
  const notes: string[] = [];
  let candidate = base;
  for (let index = 0; index < count; index++) {
    for (let tries = 0; tries < maxTries; tries++, candidate++) {
      const owner = ownerOf(candidate);
      if (!owner || isEdgecoderOllama(owner)) break;
      notes.push(`port ${candidate} is in use by ${describeOwner(owner)}${owner.unit === "ollama.service" ? " (the system's own Ollama)" : ""}: EdgeCoder's Ollama for instance ${index} uses the next free port. To give it ${candidate} instead: sudo systemctl disable --now ${owner.unit ?? "<that service>"}, then run the installer again.`);
    }
    ports[index] = candidate++;
  }
  return { ports, notes };
}

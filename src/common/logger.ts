// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// #14: keys whose values never reach a log line, at any depth.
const SECRET_KEY_RE = /^(authorization|cookie|set-cookie|password|token|secret|privatekeypem|mnemonic|seedphrase|apikey|x-[a-z-]*-token|x-[a-z-]*-signature)$/i;

export function redactMeta(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactMeta(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactMeta(v, depth + 1);
  }
  return out;
}

function write(level: "info" | "warn" | "error", message: string, meta?: unknown): void {
  const line = JSON.stringify({ level, message, meta: redactMeta(meta), ts: Date.now() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info(message: string, meta?: unknown): void {
    write("info", message, meta);
  },
  warn(message: string, meta?: unknown): void {
    write("warn", message, meta);
  },
  error(message: string, meta?: unknown): void {
    write("error", message, meta);
  }
};

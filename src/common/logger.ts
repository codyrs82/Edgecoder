// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * #14: one deep redaction rule shared by `log.*` and every Fastify/pino logger
 * (http-logging.ts runs it as the pino `formatters.log` hook).
 * Keys are matched case-insensitively as substrings, so accessToken, refreshToken, meshToken,
 * api_key, privateKey, xprv, Password, ... are all caught.
 */
export const SECRET_KEY_RE = /(token|secret|passw|private|mnemonic|seed|api_?key|signature|cookie|authorization|xprv|wif)/i;
const MAX_DEPTH = 8;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function redactMeta(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  // #128 review: never return raw data we didn't inspect.
  if (depth > MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactMeta(v, depth + 1));
  if (!isPlainObject(value)) {
    // Date, Error, Buffer, Map, ...: keep their normal JSON form (Date -> ISO string).
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") return redactMeta(toJSON.call(value), depth + 1);
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (value instanceof Map) return redactMeta(Object.fromEntries(value), depth + 1);
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Numbers/booleans under a matching key (e.g. tokensUsed) carry no secret.
    out[k] = SECRET_KEY_RE.test(k) && v !== null && typeof v !== "number" && typeof v !== "boolean" ? "[redacted]" : redactMeta(v, depth + 1);
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

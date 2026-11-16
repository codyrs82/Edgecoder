// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The app's own log files, for the desktop's Settings → Logs: the last part of a file and then what
 * was appended since (`after`, a byte offset), read-only and size-capped.
 *
 * Only the files named in LOG_SOURCES can be read: a request names a source id, never a path, so
 * nothing outside ~/.edgecoder is reachable. Lines are cut at MAX_LINE characters and pass through
 * redactLogLine, so a credential that reached a log (a bearer token in an error, an API key, an
 * invoice) is masked before it leaves the process.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CENSOR, scrubText } from "../../common/redaction.js";

export interface LogSource {
  id: string;
  label: string;
  file: string;
}

/** The files Settings → Logs may show, under ~/.edgecoder. */
export const LOG_SOURCES: readonly LogSource[] = [
  { id: "agent", label: "Agent and services", file: "agent.log" },
  { id: "local-compute", label: "Local compute setup", file: "local-compute.log" },
  { id: "ollama", label: "Ollama", file: "ollama.log" },
];

export const DEFAULT_TAIL_BYTES = 256 * 1024;
export const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_LINE = 8 * 1024;

export function logDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EDGECODER_LOG_DIR || join(homedir(), ".edgecoder");
}

export function findSource(id: string): LogSource | undefined {
  return LOG_SOURCES.find((s) => s.id === id);
}

// JSON fields and key=value pairs whose name says secret: `"token":"..."`, `apiKey=...`.
const SECRET_NAME = "(?:[A-Za-z_-]*(?:token|secret|passw(?:or)?d?|passphrase|private[_-]?key|mnemonic|seed|api[_-]?key|signature|cookie|authorization|xprv|preimage|macaroon|credential)[A-Za-z_-]*)";
const JSON_SECRET_RE = new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
const KV_SECRET_RE = new RegExp(`\\b(${SECRET_NAME}\\s*[=:]\\s*)(?!\\[redacted\\])[^\\s,;&"'}]{6,}`, "gi");
// Lightning invoices (BOLT11: lnbc / lntb / lnbcrt / lntbs) and offers (BOLT12: lno).
const INVOICE_RE = /\b(?:ln(?:bcrt|bc|tbs|tb)[0-9]*[a-z]?1[02-9ac-hj-np-z]{40,}|lno1[02-9ac-hj-np-z]{40,})\b/gi;
// Edgecoder API keys and IDE / registration tokens that have a recognisable prefix.
const EC_KEY_RE = /\b(?:ec_(?:live|test)_[A-Za-z0-9_-]{6,}|ecreg_[A-Za-z0-9_-]{8,})\b/g;

/** Mask credentials in one log line (text or a JSON line). */
export function redactLogLine(line: string): string {
  return scrubText(line)
    .replace(JSON_SECRET_RE, `$1"${CENSOR}"`)
    .replace(KV_SECRET_RE, `$1${CENSOR}`)
    .replace(INVOICE_RE, CENSOR)
    .replace(EC_KEY_RE, CENSOR);
}

export interface LogTail {
  source: string;
  exists: boolean;
  /** The file's size now. */
  size: number;
  /** The byte offset the returned lines start at, and the one to pass as `after` next time. */
  start: number;
  next: number;
  lines: string[];
  /** Older lines (or appended ones beyond the cap) were left out. */
  truncated: boolean;
  /** The file got shorter than `after` (the app truncates it at a restart): read from its end again. */
  reset: boolean;
}

/**
 * The end of `path` (at most `maxBytes`), or what was appended after byte `after`. Only whole lines
 * are returned; a line still being written is read the next time.
 */
export function readLogTail(path: string, opts: { after?: number; maxBytes?: number; source?: string } = {}): LogTail {
  const maxBytes = Math.max(1024, Math.min(MAX_TAIL_BYTES, Math.floor(opts.maxBytes ?? DEFAULT_TAIL_BYTES)));
  const source = opts.source ?? "";
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return { source, exists: false, size: 0, start: 0, next: 0, lines: [], truncated: false, reset: false };
  }
  const after = opts.after;
  const reset = after !== undefined && after > size;
  const from = after !== undefined && !reset ? after : 0;
  const start = Math.max(from, size - maxBytes);
  const truncated = start > from;
  if (start >= size) return { source, exists: true, size, start: size, next: size, lines: [], truncated: false, reset };

  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  let chunk = buf.subarray(0, read);
  let skip = 0;
  // Started mid-file and not exactly where the last read ended: drop the partial first line.
  if (start > 0 && start !== after) {
    const nl = chunk.indexOf(0x0a);
    skip = nl < 0 ? chunk.length : nl + 1;
  }
  const lastNl = chunk.lastIndexOf(0x0a);
  const end = lastNl < skip ? skip : lastNl + 1;
  chunk = chunk.subarray(skip, end);
  const lines = chunk
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => redactLogLine(l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l));
  return { source, exists: true, size, start: start + skip, next: start + end, lines, truncated, reset };
}

/** Which sources exist now and how big they are (the source picker). */
export function logSourcesStatus(dir: string): Array<{ id: string; label: string; exists: boolean; size: number }> {
  return LOG_SOURCES.map((s) => {
    try {
      const st = statSync(join(dir, s.file));
      return { id: s.id, label: s.label, exists: st.isFile(), size: st.isFile() ? st.size : 0 };
    } catch {
      return { id: s.id, label: s.label, exists: false, size: 0 };
    }
  });
}

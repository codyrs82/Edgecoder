// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** How `edgecoder code` prints things: tool calls in one line, diffs, command output, colours. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export interface Style {
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
}

export function makeStyle(color: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { dim: wrap(2, 22), bold: wrap(1, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), magenta: wrap(35, 39) };
}

const short = (s: unknown, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "read_file(src/a.ts)", "run_shell(npm test)": a tool call in one line. */
export function toolSummary(tool: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  const main =
    a.path ?? a.command ?? a.query ?? a.pattern ?? a.message ?? a.branch ?? a.title ?? (Object.keys(a).length ? JSON.stringify(a) : "");
  return `${tool}(${short(main)})`;
}

/**
 * A line diff (longest common subsequence) with `context` unchanged lines around each change:
 * lines start with "+", "-" or " ", and "…" separates hunks.
 */
export function lineDiff(before: string, after: string, context = 3): string[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let ops: Array<[" " | "-" | "+", string]> = [];
  if (a.length * b.length > 4_000_000) {
    ops = [...a.map((l) => ["-", l] as [" " | "-" | "+", string]), ...b.map((l) => ["+", l] as [" " | "-" | "+", string])];
  } else {
    const n = a.length;
    const m = b.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push([" ", a[i]]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a[i++]]);
      else ops.push(["+", b[j++]]);
    }
    while (i < n) ops.push(["-", a[i++]]);
    while (j < m) ops.push(["+", b[j++]]);
  }
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach(([k], idx) => {
    if (k === " ") return;
    for (let d = Math.max(0, idx - context); d <= Math.min(ops.length - 1, idx + context); d++) keep[d] = true;
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach(([k, l], idx) => {
    if (!keep[idx]) {
      gap = true;
      return;
    }
    if (gap && out.length) out.push("…");
    gap = false;
    out.push(`${k}${l}`);
  });
  return out;
}

/** The diff a write_file or edit_file call would make (null for other tools or unreadable files). */
export function proposedDiff(projectRoot: string, tool: string, args: Record<string, unknown>): string[] | null {
  if (tool === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string") {
    return lineDiff(args.old_string, args.new_string, 2);
  }
  if (tool === "write_file" && typeof args.path === "string" && typeof args.content === "string") {
    const abs = isAbsolute(args.path) ? args.path : join(projectRoot, args.path);
    const rel = relative(projectRoot, abs);
    if (rel.startsWith("..")) return null;
    let before = "";
    try {
      if (existsSync(abs) && statSync(abs).isFile() && statSync(abs).size < 1_000_000) before = readFileSync(abs, "utf8");
    } catch {
      before = "";
    }
    return lineDiff(before, args.content, 2);
  }
  return null;
}

/** Diff lines coloured and cut to `max` lines. */
export function formatDiff(lines: string[], st: Style, max = 60, indent = "    "): string {
  const shown = lines.slice(0, max).map((l) => {
    if (l === "…") return `${indent}${st.dim("…")}`;
    if (l.startsWith("+")) return `${indent}${st.green(l)}`;
    if (l.startsWith("-")) return `${indent}${st.red(l)}`;
    return `${indent}${st.dim(l)}`;
  });
  if (lines.length > max) shown.push(`${indent}${st.dim(`… ${lines.length - max} more lines`)}`);
  return shown.join("\n");
}

/** The tail of a command's output. */
export function outputTail(text: string, max = 12, indent = "    "): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const shown = lines.slice(-max).map((l) => `${indent}${l}`);
  if (lines.length > max) shown.unshift(`${indent}… ${lines.length - max} earlier lines`);
  return shown.join("\n");
}

/** One line for a tool's result: "12 lines", the first line of an error. */
export function resultSummary(result: string | undefined, error: string | undefined): string {
  if (error) return short(error.split("\n")[0], 100);
  const r = result ?? "";
  const n = r ? r.split("\n").length : 0;
  return n > 1 ? `${n} lines` : short(r, 80) || "done";
}

export function formatCSats(n: number): string {
  if (!n) return "0 cSats";
  return `${n < 1 ? n.toFixed(3) : n.toFixed(2).replace(/\.00$/, "")} cSats`;
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Problems for the editor: the project's own checkers, run on save, mapped to file/line/column.
 * TypeScript/JavaScript: the project's tsc (needs a tsconfig.json; whole-project, so results
 * cover every file). Python: ruff when installed, else a syntax check. Rust: cargo check.
 * Lighter than language servers, and it reports what the project's own build would.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
}

export interface CheckResult {
  /** Project-relative path -> its problems (files with none are absent). */
  byPath: Record<string, Diagnostic[]>;
  /** Checkers that ran, e.g. ["tsc"]. */
  checkers: string[];
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (_err, stdout, stderr) =>
      resolveRun({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    );
  });
}

const rel = (root: string, p: string) => relative(root, resolve(root, p)).split(sep).join("/");

/** `path(line,col): error TS2304: message` lines from `tsc --pretty false`. */
export function parseTsc(output: string, root: string, cwd: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({
      path: rel(root, join(cwd, m[1])),
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === "error" ? "error" : m[4] === "warning" ? "warning" : "info",
      message: `${m[6]} (${m[5]})`,
      source: "tsc",
    });
  }
  return out;
}

/** ruff's JSON output. */
export function parseRuff(json: string, root: string): Diagnostic[] {
  let items: Array<{ filename: string; code: string | null; message: string; location: { row: number; column: number }; end_location?: { row: number; column: number } }>;
  try {
    items = JSON.parse(json);
  } catch {
    return [];
  }
  return items.map((d) => ({
    path: rel(root, d.filename),
    line: d.location.row,
    column: d.location.column,
    ...(d.end_location ? { endLine: d.end_location.row, endColumn: d.end_location.column } : {}),
    // ruff's E9xx are syntax errors; the rest are lints.
    severity: d.code === null || /^E9/.test(d.code) ? "error" : "warning",
    message: d.code ? `${d.message} (${d.code})` : d.message,
    source: "ruff",
  }));
}

/** `python3 -m py_compile` failure: `File "x.py", line 3` and a final `SyntaxError: ...` line. */
export function parsePyCompile(stderr: string, relPath: string): Diagnostic[] {
  const err = [...stderr.matchAll(/(\w*Error): (.*)/g)].pop();
  if (!err) return [];
  const line = /line (\d+)/.exec(stderr);
  return [{ path: relPath, line: line ? Number(line[1]) : 1, column: 1, severity: "error", message: `${err[1]}: ${err[2].trim()}`, source: "python" }];
}

/** `cargo check --message-format=short`: `src/main.rs:12:5: error[E0425]: message`. */
export function parseCargo(output: string, root: string, cwd: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?):(\d+):(\d+): (error|warning)(\[\w+\])?: (.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({ path: rel(root, join(cwd, m[1])), line: Number(m[2]), column: Number(m[3]), severity: m[4] as "error" | "warning", message: m[6] + (m[5] ?? ""), source: "cargo" });
  }
  return out;
}

/** The nearest directory at or above `from` (inside root) that contains `file`. */
function nearest(root: string, from: string, file: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, file))) return dir;
    if (dir === root || !dir.startsWith(root)) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const running = new Map<string, Promise<CheckResult>>();

/** Run the checkers relevant to `relPaths` (deduplicated per project and language). */
export function checkProject(projectRoot: string, relPaths: string[]): Promise<CheckResult> {
  const root = resolve(projectRoot);
  const key = `${root}\0${[...new Set(relPaths.map((p) => p.split(".").pop()))].sort().join(",")}`;
  const existing = running.get(key);
  if (existing) return existing;
  const job = doCheck(root, relPaths).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

async function doCheck(root: string, relPaths: string[]): Promise<CheckResult> {
  const byPath: Record<string, Diagnostic[]> = {};
  const checkers: string[] = [];
  const add = (ds: Diagnostic[]) => {
    for (const d of ds) (byPath[d.path] ??= []).push(d);
  };
  const ts = relPaths.filter((p) => /\.(m|c)?[jt]sx?$/.test(p));
  const py = relPaths.filter((p) => p.endsWith(".py"));
  const rs = relPaths.filter((p) => p.endsWith(".rs"));

  if (ts.length) {
    const dir = nearest(root, dirname(resolve(root, ts[0])), "tsconfig.json");
    const tsc = dir ? [join(dir, "node_modules/.bin/tsc"), join(root, "node_modules/.bin/tsc")].find((p) => existsSync(p)) : undefined;
    if (dir && tsc) {
      const { stdout } = await run(tsc, ["--noEmit", "--pretty", "false", "-p", dir], dir, 180_000);
      add(parseTsc(stdout, root, dir));
      checkers.push("tsc");
    }
  }
  if (py.length) {
    const ruff = await run("ruff", ["check", "--output-format=json", "--no-fix", ...py.map((p) => resolve(root, p))], root, 60_000);
    if (ruff.stdout.trim().startsWith("[")) {
      add(parseRuff(ruff.stdout, root));
      checkers.push("ruff");
    } else {
      for (const p of py) {
        const r = await run("python3", ["-m", "py_compile", resolve(root, p)], root, 30_000);
        add(parsePyCompile(r.stderr, p));
      }
      checkers.push("python");
    }
  }
  if (rs.length) {
    const dir = nearest(root, dirname(resolve(root, rs[0])), "Cargo.toml");
    if (dir) {
      const { stderr } = await run("cargo", ["check", "--message-format=short", "--quiet"], dir, 300_000);
      add(parseCargo(stderr, root, dir));
      checkers.push("cargo");
    }
  }
  return { byPath, checkers };
}

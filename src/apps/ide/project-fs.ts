// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * File operations for the IDE's editor and file tree, confined to the open project the same way
 * the agent's tools are (lexical containment plus the #17 realpath check). Paths in and out are
 * project-relative with forward slashes.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isWithin, realPathEscape } from "./tool-executor.js";

/** Largest file the editor opens. Bigger files are listed but not loaded. */
export const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;
/** Directory entries never shown in the tree (still reachable by path). */
const HIDDEN_NAMES = new Set([".git", ".DS_Store"]);

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
}

export interface FileContent {
  path: string;
  content: string;
  mtimeMs: number;
  size: number;
}

export class ProjectFsError extends Error {
  constructor(
    readonly code: "escape" | "not_found" | "not_a_file" | "not_a_dir" | "too_large" | "binary" | "exists" | "conflict" | "invalid",
    message: string
  ) {
    super(message);
  }
}

export class ProjectFs {
  private readonly root: string;
  private readonly rootReal: string;

  constructor(projectRoot: string) {
    this.root = resolve(projectRoot);
    let real = this.root;
    try {
      real = realpathSync(this.root);
    } catch {
      // checked lexically only
    }
    this.rootReal = real;
  }

  /** Absolute path for a project-relative one, or ProjectFsError("escape"). */
  resolve(relPath: string): string {
    if (typeof relPath !== "string" || relPath.includes("\0")) throw new ProjectFsError("invalid", "invalid path");
    const abs = resolve(this.root, relPath || ".");
    if (!isWithin(this.root, abs)) throw new ProjectFsError("escape", `path escapes the project: ${relPath}`);
    if (realPathEscape(this.root, abs, this.rootReal) !== null) throw new ProjectFsError("escape", `symlink escapes the project: ${relPath}`);
    return abs;
  }

  private rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  /** Project-relative form (forward slashes) of an absolute path from resolve(). */
  relativePath(abs: string): string {
    return this.rel(abs);
  }

  /** One directory level, directories first, then files, each alphabetical. */
  list(relDir = ""): FsEntry[] {
    const abs = this.resolve(relDir);
    if (!existsSync(abs)) throw new ProjectFsError("not_found", `no such directory: ${relDir}`);
    if (!statSync(abs).isDirectory()) throw new ProjectFsError("not_a_dir", `not a directory: ${relDir}`);
    const entries: FsEntry[] = [];
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (HIDDEN_NAMES.has(d.name)) continue;
      const childAbs = join(abs, d.name);
      let isDir = d.isDirectory();
      let size: number | undefined;
      if (d.isSymbolicLink()) {
        // Shown only when it resolves inside the project.
        if (realPathEscape(this.root, childAbs, this.rootReal) !== null) continue;
        try {
          isDir = statSync(childAbs).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) {
        try {
          size = statSync(childAbs).size;
        } catch {
          continue;
        }
      }
      entries.push({ name: d.name, path: this.rel(childAbs), kind: isDir ? "dir" : "file", ...(size !== undefined ? { size } : {}) });
    }
    return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  }

  read(relPath: string): FileContent {
    const abs = this.resolve(relPath);
    if (!existsSync(abs)) throw new ProjectFsError("not_found", `no such file: ${relPath}`);
    const st = statSync(abs);
    if (!st.isFile()) throw new ProjectFsError("not_a_file", `not a file: ${relPath}`);
    if (st.size > MAX_EDITOR_FILE_BYTES) throw new ProjectFsError("too_large", `file is ${st.size} bytes; the editor opens files up to ${MAX_EDITOR_FILE_BYTES}`);
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new ProjectFsError("binary", `binary file: ${relPath}`);
    return { path: this.rel(abs), content: buf.toString("utf8"), mtimeMs: st.mtimeMs, size: st.size };
  }

  /**
   * Write a file. With `baseMtimeMs` (the version the editor loaded), a file changed on disk since
   * then is not overwritten: ProjectFsError("conflict"), so an agent's edit is never lost silently.
   */
  write(relPath: string, content: string, baseMtimeMs?: number): { path: string; mtimeMs: number } {
    const abs = this.resolve(relPath);
    if (existsSync(abs)) {
      const st = statSync(abs);
      if (!st.isFile()) throw new ProjectFsError("not_a_file", `not a file: ${relPath}`);
      if (baseMtimeMs !== undefined && Math.abs(st.mtimeMs - baseMtimeMs) > 1) {
        throw new ProjectFsError("conflict", `${relPath} changed on disk since it was opened`);
      }
    } else {
      mkdirSync(dirname(abs), { recursive: true });
    }
    writeFileSync(abs, content, "utf8");
    return { path: this.rel(abs), mtimeMs: statSync(abs).mtimeMs };
  }

  create(relPath: string, kind: "file" | "dir"): FsEntry {
    const abs = this.resolve(relPath);
    if (abs === this.root) throw new ProjectFsError("invalid", "cannot create the project root");
    if (existsSync(abs)) throw new ProjectFsError("exists", `already exists: ${relPath}`);
    if (kind === "dir") {
      mkdirSync(abs, { recursive: true });
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "", { flag: "wx" });
    }
    return { name: abs.split(sep).pop() ?? "", path: this.rel(abs), kind };
  }

  rename(fromRel: string, toRel: string): { from: string; to: string } {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    if (from === this.root || to === this.root) throw new ProjectFsError("invalid", "cannot rename the project root");
    if (!existsSync(from)) throw new ProjectFsError("not_found", `no such file: ${fromRel}`);
    if (existsSync(to)) throw new ProjectFsError("exists", `already exists: ${toRel}`);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return { from: this.rel(from), to: this.rel(to) };
  }

  remove(relPath: string): void {
    const abs = this.resolve(relPath);
    if (abs === this.root) throw new ProjectFsError("invalid", "cannot delete the project root");
    if (!existsSync(abs)) throw new ProjectFsError("not_found", `no such file: ${relPath}`);
    rmSync(abs, { recursive: true });
  }

  /** Modification times for open files, so the editor can reload ones changed on disk. Missing -> null. */
  stat(relPaths: string[]): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const p of relPaths.slice(0, 200)) {
      try {
        const abs = this.resolve(p);
        out[p] = statSync(abs).mtimeMs;
      } catch {
        out[p] = null;
      }
    }
    return out;
  }

  /** Branch and per-file status from `git status --porcelain=v1`; null when not a git repository. */
  gitStatus(): { branch: string | null; files: Record<string, string> } | null {
    let raw: string;
    try {
      raw = execFileSync("git", ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"], {
        cwd: this.root,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return null;
    }
    const parts = raw.split("\0");
    let branch: string | null = null;
    const files: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (!rec) continue;
      if (rec.startsWith("## ")) {
        const head = rec.slice(3);
        branch = head.startsWith("No commits yet on ") ? head.slice(18) : head.split("...")[0].split(" ")[0] || null;
        continue;
      }
      const xy = rec.slice(0, 2);
      const path = rec.slice(3);
      // Renames and copies carry the old path as the next record.
      if (xy[0] === "R" || xy[0] === "C") i++;
      files[path] = statusLetter(xy);
    }
    return { branch, files };
  }
}

/** One letter per file for the tree: M modified, A added, D deleted, R renamed, U untracked/new, C conflict. */
function statusLetter(xy: string): string {
  if (xy === "??") return "U";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "C";
  if (xy.includes("R")) return "R";
  if (xy.includes("D")) return "D";
  if (xy.includes("A")) return "A";
  return "M";
}

/** Project instruction files the agent follows, in order; every one present is used. */
export const PROJECT_RULE_FILES = ["AGENTS.md", ".edgecoder/rules.md", ".cursorrules", "CLAUDE.md"];
const MAX_RULES_BYTES = 16 * 1024;

/** The project's rule files, concatenated with their names, capped at 16 KB; "" when none. */
export function readProjectRules(projectRoot: string): string {
  const fs = new ProjectFs(projectRoot);
  const parts: string[] = [];
  let used = 0;
  for (const name of PROJECT_RULE_FILES) {
    let content: string;
    try {
      content = fs.read(name).content.trim();
    } catch {
      continue;
    }
    if (!content) continue;
    const room = MAX_RULES_BYTES - used;
    if (room <= 0) break;
    const clipped = content.length > room ? `${content.slice(0, room)}\n…(truncated)` : content;
    parts.push(`### ${name}\n${clipped}`);
    used += clipped.length;
  }
  return parts.join("\n\n");
}

/** Directories never walked when searching paths (still openable from the tree). */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".next", ".svelte-kit", "__pycache__", ".venv", "venv", ".turbo", "coverage", ".cache"]);
const MAX_INDEXED_PATHS = 50_000;
const pathIndexCache = new Map<string, { atMs: number; paths: Array<{ path: string; kind: "file" | "dir" }> }>();
const PATH_INDEX_TTL_MS = 10_000;

/** Every file and folder in the project (minus SKIP_DIRS), cached for a few seconds. */
export function projectPaths(projectRoot: string): Array<{ path: string; kind: "file" | "dir" }> {
  const cached = pathIndexCache.get(projectRoot);
  if (cached && Date.now() - cached.atMs < PATH_INDEX_TTL_MS) return cached.paths;
  const root = resolve(projectRoot);
  const out: Array<{ path: string; kind: "file" | "dir" }> = [];
  const stack = [""];
  while (stack.length > 0 && out.length < MAX_INDEXED_PATHS) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        out.push({ path: p, kind: "dir" });
        stack.push(p);
      } else if (d.isFile() && d.name !== ".DS_Store") {
        out.push({ path: p, kind: "file" });
      }
      if (out.length >= MAX_INDEXED_PATHS) break;
    }
  }
  pathIndexCache.set(projectRoot, { atMs: Date.now(), paths: out });
  return out;
}

/**
 * Fuzzy path search for @-mentions and quick open: the query's characters must appear in order;
 * matches in the file name, at word starts and contiguous runs rank higher, shorter paths first.
 */
export function findPaths(projectRoot: string, query: string, limit = 20): Array<{ path: string; kind: "file" | "dir" }> {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const all = projectPaths(projectRoot);
  if (!q) return all.filter((p) => p.kind === "file").slice(0, limit);
  const scored: Array<{ p: { path: string; kind: "file" | "dir" }; score: number }> = [];
  for (const p of all) {
    const s = fuzzyScore(p.path.toLowerCase(), q);
    if (s !== null) scored.push({ p, score: s - p.path.length * 0.01 - (p.kind === "dir" ? 0.5 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.p);
}

function fuzzyScore(path: string, q: string): number | null {
  const nameStart = path.lastIndexOf("/") + 1;
  let score = 0;
  let pi = 0;
  let prev = -2;
  for (const ch of q) {
    const i = path.indexOf(ch, pi);
    if (i < 0) return null;
    score += 1;
    if (i === prev + 1) score += 2;
    if (i >= nameStart) score += 1.5;
    if (i === 0 || "/_-. ".includes(path[i - 1])) score += 2;
    prev = i;
    pi = i + 1;
  }
  if (path.slice(nameStart).startsWith(q)) score += 5;
  return score;
}

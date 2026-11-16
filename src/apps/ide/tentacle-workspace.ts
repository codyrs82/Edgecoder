// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * A tentacle's isolated workspace (tentacles.ts): a detached `git worktree` of the lead's
 * repository in a temp folder, starting from the lead's tree as it is now (HEAD plus its
 * uncommitted changes and untracked files), committed there as a baseline so the tentacle's own
 * work comes out as one patch. The lead's files are never written from here; the patch is applied
 * to them later (applyPatch), and only after `git apply --check` passes.
 *
 * Also the acceptance checks a tentacle runs in its workspace (vitest, tsc, grep), niced, with no
 * shell: argv only.
 */

import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { gitExecEnv, hardenedGitArgs } from "./git-safe.js";
import { scrubShellEnv } from "./tool-executor.js";

const GIT_TIMEOUT_MS = 60_000;
/** Untracked files copied into a workspace: at most this many, this large in all. */
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 5_000_000;
/** node_modules is linked into the workspace (not copied) and never part of a patch. */
const PATCH_PATHSPEC = [".", ":(exclude)node_modules", ":(exclude,glob)**/node_modules"];
const TENTACLE_IDENT = ["-c", "user.name=EdgeCoder tentacle", "-c", "user.email=tentacle@edgecoder.local", "-c", "commit.gpgsign=false"];

export class WorkspaceError extends Error {}

function git(cwd: string, args: string[], input?: string): string {
  // Byte-exact on every platform: no CRLF conversion between the lead's tree, the worktree and patches.
  return execFileSync("git", hardenedGitArgs(["-C", cwd, "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], cwd), {
    env: gitExecEnv(),
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

function gitTry(cwd: string, args: string[], input?: string): { ok: true; out: string } | { ok: false; err: string } {
  try {
    return { ok: true, out: git(cwd, args, input) };
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    return { ok: false, err: String(e.stderr ?? "").trim() || e.message || String(err) };
  }
}

/** A path with symlinks resolved (/var -> /private/var on macOS), as git reports paths. */
export function realOf(p: string): string {
  try {
    // .native also expands Windows 8.3 short names (C:\Users\RUNNER~1), which git never reports.
    return realpathSync.native(p);
  } catch {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }
}

/** The repository's top folder, or null outside git. */
export function repoTop(projectRoot: string): string | null {
  const r = gitTry(projectRoot, ["rev-parse", "--show-toplevel"]);
  const top = r.ok ? r.out.trim() : "";
  // git prints C:/a/b on Windows: the same folder in this platform's form, so relative() works.
  return top ? realOf(normalize(top)) : null;
}

export interface Workspace {
  /** The worktree folder (the repository's top). */
  dir: string;
  /** The project folder inside it (the lead's projectRoot, same place relative to the repo). */
  root: string;
  /** The lead's repository top. */
  leadTop: string;
  /** Where the lead's project sits inside the repository ("" at the top). */
  sub: string;
  /** The baseline commit the tentacle's patch is taken against. */
  baseline: string;
  /** What did not carry over from the lead's tree (shown to the lead). */
  notes: string[];
}

/** Link the lead's node_modules into the workspace, so checks run without an install. */
function linkNodeModules(from: string, to: string): void {
  const src = join(from, "node_modules");
  const dst = join(to, "node_modules");
  try {
    if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst, "dir");
  } catch {
    // checks that need it will say so
  }
}

/**
 * A worktree of the lead's repository at HEAD in a temp folder, with the lead's uncommitted
 * changes and untracked files on top, committed as the baseline.
 */
export function createWorkspace(projectRoot: string, opts: { tmpRoot?: string; label?: string } = {}): Workspace {
  const leadTop = repoTop(projectRoot);
  if (!leadTop) throw new WorkspaceError("Tentacles that change files need the project to be a git repository.");
  const sub = relative(leadTop, realOf(projectRoot));
  if (sub.startsWith("..") || isAbsolute(sub)) throw new WorkspaceError("The project isn't inside its git repository.");
  const head = gitTry(leadTop, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) throw new WorkspaceError("The repository has no commits yet; commit once before delegating edits.");
  const base = opts.tmpRoot ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const holder = mkdtempSync(join(base, `edgecoder-tentacle-${(opts.label ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16)}`));
  const dir = join(holder, "wt");
  const notes: string[] = [];
  const added = gitTry(leadTop, ["worktree", "add", "--detach", "--quiet", dir, head.out.trim()]);
  if (!added.ok) {
    rmSync(holder, { recursive: true, force: true });
    throw new WorkspaceError(`Couldn't create the tentacle's worktree: ${added.err}`);
  }
  try {
    // The lead's uncommitted changes to tracked files.
    const dirty = gitTry(leadTop, ["diff", "HEAD", "--binary"]);
    if (dirty.ok && dirty.out.trim()) {
      const applied = gitTry(dir, ["apply", "--binary", "--whitespace=nowarn"], dirty.out);
      if (!applied.ok) notes.push("the lead's uncommitted changes could not be carried over; the tentacle started from HEAD");
    }
    // Untracked (not ignored) files, within limits.
    const untracked = gitTry(leadTop, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.ok) {
      let bytes = 0;
      let skipped = 0;
      const files = untracked.out.split("\0").filter(Boolean);
      for (const [i, f] of files.entries()) {
        const src = join(leadTop, f);
        let size = 0;
        try {
          const st = lstatSync(src);
          if (!st.isFile()) continue;
          size = st.size;
        } catch {
          continue;
        }
        if (i >= MAX_UNTRACKED_FILES || bytes + size > MAX_UNTRACKED_BYTES) {
          skipped++;
          continue;
        }
        bytes += size;
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        copyFileSync(src, join(dir, f));
      }
      if (skipped) notes.push(`${skipped} untracked file(s) were too many or too large to copy`);
    }
    linkNodeModules(leadTop, dir);
    if (sub) linkNodeModules(join(leadTop, sub), join(dir, sub));
    const add = gitTry(dir, ["add", "-A", "--", ...PATCH_PATHSPEC]);
    if (!add.ok) throw new WorkspaceError(`Couldn't stage the baseline: ${add.err}`);
    const commit = gitTry(dir, [...TENTACLE_IDENT, "commit", "-q", "--no-verify", "--allow-empty", "-m", "tentacle baseline"]);
    if (!commit.ok) throw new WorkspaceError(`Couldn't commit the baseline: ${commit.err}`);
    const baseline = git(dir, ["rev-parse", "HEAD"]).trim();
    return { dir, root: sub ? join(dir, sub) : dir, leadTop, sub, baseline, notes };
  } catch (err) {
    removeWorkspace({ dir, leadTop });
    throw err;
  }
}

/** The tentacle's work so far: a binary-safe patch against the baseline, and the files it touches (repository paths). */
export function workspacePatch(ws: Pick<Workspace, "dir" | "baseline">): { patch: string; files: string[] } {
  const add = gitTry(ws.dir, ["add", "-A", "--", ...PATCH_PATHSPEC]);
  if (!add.ok) throw new WorkspaceError(`Couldn't collect the tentacle's changes: ${add.err}`);
  const patch = git(ws.dir, ["diff", "--cached", "--binary", ws.baseline]);
  const files = git(ws.dir, ["diff", "--cached", "--name-only", "-z", ws.baseline]).split("\0").filter(Boolean);
  return { patch, files };
}

/** Put the workspace back to its baseline (before a retry). */
export function resetWorkspace(ws: Pick<Workspace, "dir" | "baseline">): void {
  gitTry(ws.dir, ["reset", "-q", "--hard", ws.baseline]);
  gitTry(ws.dir, ["clean", "-q", "-fd", "-e", "node_modules"]);
}

export function removeWorkspace(ws: Pick<Workspace, "dir" | "leadTop">): void {
  gitTry(ws.leadTop, ["worktree", "remove", "--force", ws.dir]);
  rmSync(dirname(ws.dir), { recursive: true, force: true });
  gitTry(ws.leadTop, ["worktree", "prune"]);
}

/** Paths a patch touches (from its `diff --git` headers), repository-relative. */
export function patchFiles(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    out.add(m[1]);
    out.add(m[2]);
  }
  return [...out];
}

/** Whether `patch` applies cleanly to the lead's working tree (`git apply --check`). */
export function checkPatch(leadTop: string, patch: string): { ok: true } | { ok: false; error: string } {
  if (!patch.trim()) return { ok: true };
  const r = gitTry(leadTop, ["apply", "--check", "--binary", "--whitespace=nowarn"], patch);
  return r.ok ? { ok: true } : { ok: false, error: r.err };
}

/** Apply `patch` to the lead's working tree (not the index). Check first. */
export function applyPatch(leadTop: string, patch: string): { ok: true } | { ok: false; error: string } {
  if (!patch.trim()) return { ok: true };
  const r = gitTry(leadTop, ["apply", "--binary", "--whitespace=nowarn"], patch);
  return r.ok ? { ok: true } : { ok: false, error: r.err };
}

// ---------------------------------------------------------------------------
// Acceptance checks
// ---------------------------------------------------------------------------

export type AcceptanceKind = "vitest" | "tsc" | "grep" | "none";

export interface Acceptance {
  kind: AcceptanceKind;
  /** vitest: test files (string or list); tsc: { project }; grep: { pattern, paths?, absent? }. */
  args?: unknown;
}

export interface CheckResult {
  kind: AcceptanceKind;
  command: string;
  passed: boolean;
  exitCode: number;
  /** The output's tail. */
  output: string;
  durationMs: number;
}

/** A path argument a check may take: relative, inside the workspace, not an option. */
function safeRel(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const v = p.trim();
  if (!v || v.startsWith("-") || isAbsolute(v) || v.startsWith("~") || /[\0\n\r]/.test(v)) return null;
  const n = normalize(v);
  if (n === ".." || n.startsWith(`..${sep}`) || n.startsWith("../")) return null;
  return v;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);

/** The argv a check runs (niced where `nice` exists), or an error for arguments it refuses. */
export function acceptanceCommand(a: Acceptance, platform: NodeJS.Platform = process.platform): { argv: string[]; absent?: boolean } | { error: string } {
  const nice = platform === "win32" ? [] : ["nice", "-n", "10"];
  const o = (a.args && typeof a.args === "object" && !Array.isArray(a.args) ? a.args : {}) as Record<string, unknown>;
  switch (a.kind) {
    case "none":
      return { argv: [] };
    case "vitest": {
      const raw = Array.isArray(a.args) || typeof a.args === "string" ? list(a.args) : list(o.files ?? o.paths);
      const files = raw.map(safeRel);
      if (files.some((f) => f === null)) return { error: "vitest takes relative test file paths inside the project" };
      return { argv: [...nice, "npx", "--no-install", "vitest", "run", ...(files as string[]), "--maxWorkers=2"] };
    }
    case "tsc": {
      const project = o.project === undefined ? (typeof a.args === "string" ? a.args : "tsconfig.json") : o.project;
      const p = safeRel(project);
      if (!p) return { error: "tsc takes a relative tsconfig path" };
      return { argv: [...nice, "npx", "--no-install", "tsc", "--noEmit", "-p", p] };
    }
    case "grep": {
      const pattern = typeof a.args === "string" ? a.args : o.pattern;
      if (typeof pattern !== "string" || !pattern || pattern.length > 500 || /[\0\n\r]/.test(pattern)) return { error: "grep takes { pattern, paths?, absent? }" };
      const paths = list(o.paths).map(safeRel);
      if (paths.some((f) => f === null)) return { error: "grep paths must be relative and inside the project" };
      return { argv: ["grep", "-rnE", "-e", pattern, "--", ...(paths.length ? (paths as string[]) : ["."])], absent: o.absent === true };
    }
    default:
      return { error: `unknown acceptance kind ${String((a as { kind?: unknown }).kind)}` };
  }
}

const tail = (s: string, n = 3000) => (s.length > n ? `… ${s.slice(-n)}` : s);

/** Run a check in `cwd` (the tentacle's workspace); never throws. */
export function runAcceptance(a: Acceptance, cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CheckResult> {
  const started = Date.now();
  const cmd = acceptanceCommand(a);
  if ("error" in cmd) return Promise.resolve({ kind: a.kind, command: a.kind, passed: false, exitCode: -1, output: cmd.error, durationMs: 0 });
  if (!cmd.argv.length) return Promise.resolve({ kind: "none", command: "(none)", passed: true, exitCode: 0, output: "", durationMs: 0 });
  const command = cmd.argv.join(" ");
  return new Promise((resolve) => {
    execFile(
      cmd.argv[0],
      cmd.argv.slice(1),
      { cwd, env: { ...scrubShellEnv(process.env), CI: "1", FORCE_COLOR: "0" }, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 16 * 1024 * 1024, signal: opts.signal },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const exitCode = !e ? 0 : typeof e.code === "number" ? e.code : e.killed ? 137 : 1;
        const output = tail(`${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim());
        // grep: 0 found, 1 not found, 2 error.
        const passed = a.kind === "grep" ? (cmd.absent ? exitCode === 1 : exitCode === 0) : exitCode === 0;
        resolve({ kind: a.kind, command, passed, exitCode, output: e && !stdout && !stderr ? e.message : output, durationMs: Date.now() - started });
      },
    );
  });
}

/** Whether `p` exists and is a folder. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

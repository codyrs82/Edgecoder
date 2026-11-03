// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// ---------------------------------------------------------------------------
// Server-side tool executor for the IDE agent process.
// Called directly by the agent (provider-server on :4304) to perform
// filesystem, shell, and git operations within the user's project.
// ---------------------------------------------------------------------------

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, dirname, isAbsolute, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync, lstatSync, readFileSync } from "node:fs";
import type { ToolName } from "./tool-types.js";
import { gitExecEnv, hardenedGitArgs, hardenedGitEnv } from "./git-safe.js";
import { findGh, ghCredentialConfig } from "./git-setup.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolResult {
  result?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// #4: run_shell policy
// ---------------------------------------------------------------------------

const DEFAULT_SHELL_ALLOW = [
  "npm", "npx", "node", "python3", "python", "pytest", "git", "ls", "cat", "rg",
  "grep", "head", "tail", "wc", "pwd", "echo", "tsc", "vitest", "jest", "cargo", "go",
];
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "blame", "remote",
]);
const SHELL_METACHAR = /[;&|`<>\n\r]|\$\(/;
/** Interpreter flags that evaluate inline code. */
const INLINE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "-i", "--interactive", "-r", "--require", "--import", "--loader", "-m"]);
const INTERPRETERS = /^(node|python\d*(\.\d+)?|deno|bun|ruby|perl|php)$/;

export function shellAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.IDE_SHELL_ALLOW?.trim();
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SHELL_ALLOW;
  return new Set(list);
}

/** Minimal POSIX-ish argv parser: whitespace split with '' and "" quoting. */
export function parseArgv(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error("unterminated quote");
  if (has || cur) out.push(cur);
  return out;
}

export type ShellDecision =
  | { allowed: true; argv: string[]; useShell: boolean }
  | { allowed: false; reason: string };

/** Unapproved git: read-only subcommands, with no flags that write or rewrite. */
function gitUnapprovedReason(args: string[]): string | null {
  const sub = args[0] ?? "";
  if (!GIT_READONLY_SUBCOMMANDS.has(sub)) return `git ${sub} is not read-only`;
  if (args.some((a) => a === "--output" || a.startsWith("--output="))) return "git --output writes files";
  if (sub === "remote" && !(args.length === 1 || (args.length === 2 && (args[1] === "-v" || args[1] === "--verbose")))) {
    return "git remote is only allowed as `git remote` or `git remote -v`";
  }
  if (sub === "branch") {
    const destructive = new Set(["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "-u", "--set-upstream-to", "--unset-upstream", "--edit-description"]);
    if (args.slice(1).some((a) => destructive.has(a) || a.startsWith("--set-upstream-to="))) return "git branch with a modifying flag";
    if (args.slice(1).some((a) => !a.startsWith("-"))) return "git branch <name> creates a branch";
  }
  return null;
}

/** #17: `child` is `root` or inside it (no prefix confusion: /proj-evil is not inside /proj). */
/**
 * Where edit_file applies: old_string must occur exactly once. When it doesn't occur, extra
 * trailing newlines (a common model slip) are dropped from old_string, and as many from
 * new_string when it ends with them too, before giving up.
 */
export function locateEdit(
  content: string,
  oldString: string,
  newString: string,
): { index: number; oldString: string; newString: string } | { error: string } {
  let o = oldString;
  let n = newString;
  for (;;) {
    const first = content.indexOf(o);
    if (first !== -1) {
      if (content.indexOf(o, first + 1) !== -1) {
        return { error: "old_string matches multiple locations in the file. Provide a more specific string." };
      }
      return { index: first, oldString: o, newString: n };
    }
    if (!o.endsWith("\n") || o.length <= 1) return { error: "old_string not found in file" };
    o = o.slice(0, -1);
    if (n.endsWith("\n")) n = n.slice(0, -1);
  }
}

export function isWithin(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * #17: realpath check of the deepest existing part of `abs`. Checking only an existing leaf let
 * `write_file link/new.txt` (link -> /etc) or a dangling leaf symlink write outside the root.
 * lstat errors other than ENOENT (EACCES, ENOTDIR) also just move up a level; that is intended,
 * since the ancestor that does exist is still checked.
 * Not atomic with the later read/write: a concurrent process could swap a directory for a symlink
 * in between. Closing that needs O_NOFOLLOW opens or a re-check right before the write.
 */
export function realPathEscape(root: string, abs: string, rootReal = safeRealpath(root) ?? root): "dangling" | "escape" | null {
  let probe = abs;
  for (;;) {
    let exists = false;
    try {
      lstatSync(probe);
      exists = true;
    } catch {
      // not there; try the parent
    }
    if (exists) {
      const real = safeRealpath(probe);
      if (real === null) return "dangling";
      // realpath never goes through a symlinked ancestor, so comparing with rootReal is enough.
      return isWithin(rootReal, real) ? null : "escape";
    }
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
}

// ---------------------------------------------------------------------------
// Protected paths: the git directory, and files git or common tools act on by themselves
// ---------------------------------------------------------------------------

/**
 * Path segment compared the way case-insensitive and Windows filesystems match names: lower case,
 * NTFS stream suffix (`:...`) and trailing dots/spaces dropped, and the zero-width characters
 * HFS+ ignores removed (git's own `.git` checks do the same).
 */
function normalizeSegment(seg: string): string {
  let s = seg.normalize("NFC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").toLowerCase();
  const colon = s.indexOf(":");
  if (colon > 0) s = s.slice(0, colon);
  return s.replace(/[. ]+$/, "");
}

/** True for a segment that names a git directory (`.git`, or its 8.3 short name `git~1`). */
function isGitDirSegment(seg: string): boolean {
  const s = normalizeSegment(seg);
  return s === ".git" || s === "git~1";
}

/**
 * Files that need the user's explicit approval for every agent write (never auto-approved):
 * git reads them for submodule URLs and filter/diff drivers, and hook runners or the shell
 * execute what they name.
 */
const APPROVAL_FILES = new Set([
  ".gitmodules", ".gitattributes", ".envrc", ".pre-commit-config.yaml",
  "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml", ".lefthookrc",
]);
/** Directories whose contents are executed by tooling (git hook managers, editor task runners). */
const APPROVAL_DIRS = new Set([".husky", ".githooks", ".vscode"]);

export type ProtectedPathKind = "git_dir" | "needs_approval";

/** Classify a project-relative path by its segments alone (no filesystem access). */
export function classifyRelativePath(relPath: string): ProtectedPathKind | null {
  const segs = relPath.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segs.some(isGitDirSegment)) return "git_dir";
  if (segs.length > 0 && APPROVAL_FILES.has(normalizeSegment(segs[segs.length - 1]))) return "needs_approval";
  if (segs.slice(0, -1).some((s) => APPROVAL_DIRS.has(normalizeSegment(s)))) return "needs_approval";
  return null;
}

/**
 * Lexical check for a tool's `path` argument, for deciding approval before anything runs.
 * The executor repeats it with symlinks resolved.
 */
export function protectedToolPath(path: unknown): ProtectedPathKind | null {
  if (typeof path !== "string") return null;
  return classifyRelativePath(path);
}

/**
 * Classify `abs` (inside `root`) both as written and with symlinks resolved, so `link/config`
 * with `link -> .git` and a leaf symlink into the git directory are caught. `gitDirs` are
 * additional real git directories to protect (a `.git` file's `gitdir:` target).
 */
export function classifyProjectPath(root: string, abs: string, rootReal: string, gitDirs: string[] = []): ProtectedPathKind | null {
  const lexical = classifyRelativePath(relative(root, abs));
  if (lexical === "git_dir") return lexical;
  let real: string | null = null;
  let probe = abs;
  const tail: string[] = [];
  for (;;) {
    const r = safeRealpath(probe);
    if (r !== null) {
      real = tail.length ? join(r, ...tail.reverse()) : r;
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.push(relative(parent, probe));
    probe = parent;
  }
  if (real !== null) {
    if (gitDirs.some((g) => isWithin(g, real!))) return "git_dir";
    if (isWithin(rootReal, real)) {
      const resolved = classifyRelativePath(relative(rootReal, real));
      if (resolved === "git_dir") return resolved;
      return lexical ?? resolved;
    }
  }
  return lexical;
}

/** Real path of the git directory a `<root>/.git` file points to (worktrees, submodules), if any. */
function gitFileTarget(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    if (!lstatSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    return safeRealpath(resolve(root, m[1]));
  } catch {
    return null;
  }
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** True if an argument names a path outside `root` (absolute, ~, or ..-escaping). */
function escapesRoot(arg: string, root: string): boolean {
  const value = arg.includes("=") && arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
  if (!value || (value.startsWith("-") && !value.includes("/"))) return false;
  if (value.startsWith("~")) return true;
  const abs = resolve(root, value);
  if (!isWithin(root, abs)) return true;
  // #121 review: a committed symlink (link -> /etc) must not let `cat link/passwd` run unapproved.
  return realPathEscape(root, abs) !== null;
}

/**
 * Decide whether `command` may run. Without explicit user approval (including
 * IDE_SHELL_AUTO_APPROVE=1) only allowlisted binaries run, with no shell syntax,
 * no inline-code interpreter flags, no npx / npm exec / cargo run / go run, and
 * no path arguments outside the project root.
 */
export function evaluateShellCommand(
  command: string,
  opts: { approved?: boolean; env?: NodeJS.ProcessEnv; root?: string } = {},
): ShellDecision {
  const approved = opts.approved === true;
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "empty command" };
  if (SHELL_METACHAR.test(trimmed)) {
    if (!approved) return { allowed: false, reason: "shell metacharacters require explicit approval" };
    return { allowed: true, argv: [], useShell: true };
  }
  let argv: string[];
  try {
    argv = parseArgv(trimmed);
  } catch (e) {
    return { allowed: false, reason: String((e as Error).message) };
  }
  if (argv.length === 0) return { allowed: false, reason: "empty command" };
  if (!approved) {
    const deny = (why: string): ShellDecision => ({ allowed: false, reason: `${why}; approval required` });
    const bin = argv[0];
    const args = argv.slice(1);
    if (bin.includes("/") || bin.includes("\\")) return deny("binaries must be named, not given as a path");
    if (!shellAllowlist(opts.env).has(bin)) return deny(`'${bin}' is not in the allowlist (IDE_SHELL_ALLOW)`);
    if (bin === "npx") return deny("npx runs arbitrary packages");
    if (bin === "npm" && ["exec", "x", "explore"].includes(args[0] ?? "")) return deny(`npm ${args[0]} runs arbitrary code`);
    if ((bin === "cargo" || bin === "go") && args[0] === "run") return deny(`${bin} run executes arbitrary code`);
    if (INTERPRETERS.test(bin) && (args.length === 0 || args.some((a) => INLINE_EVAL_FLAGS.has(a) || /^--(eval|print|require|import|loader)=/.test(a)))) {
      return deny(`${bin} inline code / REPL`);
    }
    if (bin === "git") {
      const why = gitUnapprovedReason(args);
      if (why) return deny(why);
    }
    if (opts.root) {
      const outside = args.find((a) => escapesRoot(a, opts.root!));
      if (outside !== undefined) return deny(`path '${outside}' is outside the project root`);
    }
  }
  return { allowed: true, argv, useShell: false };
}

/** Environment variables passed to shell commands; everything else is dropped. */
const SHELL_ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ",
  "TMPDIR", "TMP", "TEMP", "NODE_ENV", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  // Windows essentials
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "SYSTEMDRIVE",
]);

/**
 * Allowlisted environment for shell commands (#4 review): PATH, HOME, locale,
 * terminal and temp vars, LC_*, plus names listed in IDE_SHELL_ENV_PASS.
 */
export function scrubShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra = new Set(
    (env.IDE_SHELL_ENV_PASS ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  );
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    const key = k.toUpperCase();
    if (SHELL_ENV_ALLOW.has(key) || key.startsWith("LC_") || extra.has(key)) out[k] = v;
  }
  return out;
}

/** A branch-name piece: lower case, letters, digits and dashes, at most `max` characters. */
export function branchSlug(text: string, max = 40): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** `bot/<bot-name>/<short-slug>` (or `<prefix>/<short-slug>`) for a pull request's title. */
export function pullRequestBranch(prefix: string, title: string): string {
  return `${prefix}/${branchSlug(title) || "changes"}`;
}

/** What open_pull_request will do, as the approval card shows it. */
export interface PullRequestPlan {
  title: string;
  body: string;
  base: string;
  branch: string;
  /** Create `branch` at HEAD (the agent is on the default branch, or asked for a new name). */
  createBranch: boolean;
  diffstat: string;
  commits: number;
  /** Changed files that aren't committed (not part of the PR). */
  uncommitted: number;
}

export class ToolExecutor {
  private readonly root: string;
  private readonly githubToken: string | null;
  /** Prefix for generated PR branches: "bot/<name>" for bots, "edgecoder" for chat. */
  private readonly branchPrefix: string;

  /** #17: symlink-resolved root (e.g. /tmp -> /private/tmp on macOS), for real-path checks. */
  private readonly rootReal: string;

  /** Search by meaning (the project's codebase index), when available. */
  private readonly codebaseSearch: ((query: string) => Promise<string>) | null;

  constructor(projectRoot: string, githubToken?: string | null, codebaseSearch?: (query: string) => Promise<string>, opts: { branchPrefix?: string } = {}) {
    this.codebaseSearch = codebaseSearch ?? null;
    this.branchPrefix = opts.branchPrefix ?? "edgecoder";
    this.root = resolve(projectRoot);
    let rootReal = this.root;
    try {
      rootReal = realpathSync(this.root);
    } catch {
      // root doesn't exist yet; lexical checks still apply
    }
    // Captured once: if the root is created later as a symlink, every path is rejected (safe).
    this.rootReal = rootReal;
    this.githubToken = githubToken ?? null;
  }

  // -----------------------------------------------------------------------
  // Path helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve a user-supplied path against the project root and ensure the
   * resolved path does not escape outside the sandbox.
   */
  private resolvePath(relativePath: string): string {
    const abs = resolve(this.root, relativePath);
    if (!isWithin(this.root, abs)) {
      throw new Error(`Path escapes project root: ${relativePath}`);
    }
    const why = realPathEscape(this.root, abs, this.rootReal);
    if (why === "dangling") throw new Error(`Dangling symlink in path: ${relativePath}`);
    if (why === "escape") throw new Error(`Symlink escapes project root: ${relativePath}`);
    return abs;
  }

  /**
   * Refuse agent writes into the git directory (git runs commands named in its config and hooks,
   * and the IDE runs git), and writes to files that tooling executes unless the user approved this
   * very call. `approved` is true only for an explicit approval, never for auto-approved edits.
   */
  private assertWritable(abs: string, approved: boolean): void {
    const gitFile = gitFileTarget(this.root);
    const kind = classifyProjectPath(this.root, abs, this.rootReal, gitFile ? [gitFile] : []);
    const rel = relative(this.root, abs) || ".";
    if (kind === "git_dir") {
      throw new Error(`Refusing to modify ${rel}: agent tools can't write inside the git directory (.git).`);
    }
    if (kind === "needs_approval" && !approved) {
      throw new Error(`Refusing to modify ${rel} without explicit approval: git or other tools run commands named in this file.`);
    }
  }

  // -----------------------------------------------------------------------
  // Main dispatch
  // -----------------------------------------------------------------------

  async execute(
    tool: ToolName,
    args: Record<string, unknown>,
    opts: { approved?: boolean } = {},
  ): Promise<ToolResult> {
    try {
      switch (tool) {
        case "read_file":
          return await this.readFileImpl(args);
        case "list_directory":
          return await this.listDirectory(args);
        case "search_files":
          return await this.searchFiles(args);
        case "search_codebase":
          if (!this.codebaseSearch) return { error: "No codebase index for this project yet. Use search_files instead." };
          return { result: await this.codebaseSearch(String(args.query ?? "")) };
        case "write_file":
          return await this.writeFileImpl(args, opts.approved === true);
        case "edit_file":
          return await this.editFile(args, opts.approved === true);
        case "run_shell":
          return await this.runShell(args, opts.approved === true);
        case "git_status":
          return this.gitStatus();
        case "git_diff":
          return this.gitDiff(args);
        case "git_log":
          return this.gitLog(args);
        case "git_commit":
          return this.gitCommit(args);
        case "git_branch":
          return this.gitBranch(args);
        case "git_fetch":
          return this.gitFetch(args);
        case "git_push":
          return this.gitPush(args);
        case "git_pull":
          return this.gitPull(args);
        case "github_create_pr":
          return await this.githubCreatePr(args);
        case "github_list_prs":
          return await this.githubListPrs(args);
        case "github_list_issues":
          return await this.githubListIssues(args);
        case "open_pull_request":
          return await this.openPullRequest(args, opts.approved === true);
        default: {
          const _exhaustive: never = tool;
          return { error: `Unknown tool: ${_exhaustive}` };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  }

  // -----------------------------------------------------------------------
  // read_file
  // -----------------------------------------------------------------------

  private async readFileImpl(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const filePath = this.resolvePath(String(args.path ?? ""));
    const raw = await readFile(filePath, "utf-8");
    // A final newline ends the last line; it is not an extra empty line (numbering one made the
    // model add a blank line to old_string and miss on edit_file).
    const allLines = (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n");

    const offset = typeof args.offset === "number" ? args.offset : 1;
    const limit =
      typeof args.limit === "number" ? args.limit : allLines.length;

    // offset is 1-based per the tool definition
    const startIdx = Math.max(0, offset - 1);
    const slice = allLines.slice(startIdx, startIdx + limit);

    const numbered = slice.map(
      (line, i) => `${String(startIdx + i + 1).padStart(6, " ")}  ${line}`,
    );
    return { result: numbered.join("\n") };
  }

  // -----------------------------------------------------------------------
  // list_directory
  // -----------------------------------------------------------------------

  private async listDirectory(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const dirPath = this.resolvePath(String(args.path ?? "."));
    const entries = await readdir(dirPath, { withFileTypes: true });

    const lines: string[] = [];
    for (const entry of entries) {
      // Skip dotfiles/dotfolders
      if (entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        lines.push(`dir   ${entry.name}/`);
      } else {
        try {
          const info = await stat(join(dirPath, entry.name));
          lines.push(`file  ${entry.name}  (${info.size} bytes)`);
        } catch {
          lines.push(`file  ${entry.name}`);
        }
      }
    }
    return { result: lines.join("\n") || "(empty directory)" };
  }

  // -----------------------------------------------------------------------
  // search_files
  // -----------------------------------------------------------------------

  private async searchFiles(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    const searchDir = this.resolvePath(String(args.path ?? "."));
    const include = typeof args.include === "string" ? args.include : "";

    // #121 review: -e keeps a pattern starting with "-" from being parsed as a grep option.
    const grepArgs = ["grep", "-rn", "-E", "-e", pattern];
    if (include) {
      grepArgs.push("--include", include);
    }
    grepArgs.push("--", searchDir);

    return new Promise<ToolResult>((resolvePromise) => {
      const proc = spawn(grepArgs[0], grepArgs.slice(1), {
        cwd: this.root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let lineCount = 0;
      const MAX_RESULTS = 50;

      proc.stdout.on("data", (chunk: Buffer) => {
        if (lineCount >= MAX_RESULTS) return;
        const text = chunk.toString("utf-8");
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line) continue;
          if (lineCount >= MAX_RESULTS) {
            proc.kill();
            break;
          }
          // Make paths relative to project root for readability
          const relLine = line.startsWith(this.root)
            ? line.slice(this.root.length + 1)
            : line;
          stdout += relLine + "\n";
          lineCount++;
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("close", (code) => {
        if (lineCount === 0 && code !== 0) {
          resolvePromise({
            result: stderr ? `No matches found. ${stderr.trim()}` : "No matches found.",
          });
        } else {
          const suffix =
            lineCount >= MAX_RESULTS
              ? `\n... (limited to ${MAX_RESULTS} results)`
              : "";
          resolvePromise({ result: stdout.trimEnd() + suffix });
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // write_file
  // -----------------------------------------------------------------------

  private async writeFileImpl(
    args: Record<string, unknown>,
    approved = false,
  ): Promise<ToolResult> {
    const filePath = this.resolvePath(String(args.path ?? ""));
    this.assertWritable(filePath, approved);
    const content = String(args.content ?? "");

    // Ensure parent directories exist
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, content, "utf-8");
    return { result: `Wrote ${content.length} bytes to ${relative(this.root, filePath)}` };
  }

  // -----------------------------------------------------------------------
  // edit_file
  // -----------------------------------------------------------------------

  private async editFile(args: Record<string, unknown>, approved = false): Promise<ToolResult> {
    const filePath = this.resolvePath(String(args.path ?? ""));
    this.assertWritable(filePath, approved);
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");

    if (!oldString) {
      return { error: "old_string must not be empty" };
    }

    const original = await readFile(filePath, "utf-8");
    const match = locateEdit(original, oldString, newString);
    if ("error" in match) return { error: match.error };

    // Splice rather than String.replace, which would expand $&, $' and $` in the new code.
    const updated = original.slice(0, match.index) + match.newString + original.slice(match.index + match.oldString.length);
    await writeFile(filePath, updated, "utf-8");

    const relPath = relative(this.root, filePath);
    return { result: `Edited ${relPath} — replaced ${match.oldString.length} chars` };
  }

  // -----------------------------------------------------------------------
  // run_shell
  // -----------------------------------------------------------------------

  private async runShell(args: Record<string, unknown>, approved = false): Promise<ToolResult> {
    const command = String(args.command ?? "");
    const timeout =
      typeof args.timeout === "number" ? args.timeout : 30_000;

    // #4: policy check before anything is spawned.
    const decision = evaluateShellCommand(command, { approved, root: this.root });
    if (!decision.allowed) {
      return { error: `run_shell rejected: ${decision.reason}` };
    }

    return new Promise<ToolResult>((resolvePromise) => {
      // Default: no shell, parsed argv. Only an explicitly approved command that
      // needs shell syntax (pipes, &&, …) is run through sh -c.
      // git run by the agent (directly or from a script) gets the IDE's git hardening.
      const [cmd, cmdArgs] = decision.useShell
        ? ["sh", ["-c", command]]
        : decision.argv[0] === "git"
          ? ["git", hardenedGitArgs(decision.argv.slice(1))]
          : [decision.argv[0], decision.argv.slice(1)];
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(cmd, cmdArgs, {
          cwd: this.root,
          shell: false,
          env: hardenedGitEnv(scrubShellEnv(process.env)),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolvePromise({ error: `run_shell failed: ${String(error)}` });
        return;
      }

      let stdout = "";
      let stderr = "";
      let killed = false;
      let settled = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, timeout);

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ error: `run_shell failed: ${error.message}` });
      });

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const exitCode = killed ? 137 : (code ?? 1);
        resolvePromise({
          result: JSON.stringify({
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exit_code: exitCode,
          }),
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // git_status
  // -----------------------------------------------------------------------

  private gitStatus(): ToolResult {
    try {
      const out = execFileSync("git", hardenedGitArgs(["status", "--porcelain"]), {
        env: gitExecEnv(),
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() || "(clean working tree)" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git status failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // git_diff
  // -----------------------------------------------------------------------

  private gitDiff(args: Record<string, unknown>): ToolResult {
    const ref = typeof args.ref === "string" ? args.ref : "";
    const filePath = typeof args.path === "string" ? args.path : "";

    const gitArgs = ["diff"];
    if (ref) gitArgs.push(ref);
    if (filePath) gitArgs.push("--", filePath);

    try {
      const out = execFileSync("git", hardenedGitArgs(gitArgs), {
        env: gitExecEnv(),
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() || "(no diff)" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git diff failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // git_log
  // -----------------------------------------------------------------------

  private gitLog(args: Record<string, unknown>): ToolResult {
    const count =
      typeof args.count === "number" ? args.count : 10;
    const ref = typeof args.ref === "string" ? args.ref : "";

    const gitArgs = ["log", "--oneline", "-n", `${count}`];
    if (ref) gitArgs.push(ref);

    try {
      const out = execFileSync("git", hardenedGitArgs(gitArgs), {
        env: gitExecEnv(),
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() || "(no commits)" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git log failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // git_commit
  // -----------------------------------------------------------------------

  private gitCommit(args: Record<string, unknown>): ToolResult {
    const message = String(args.message ?? "");
    const files = String(args.files ?? ".");

    if (!message) {
      return { error: "commit message is required" };
    }

    try {
      // Stage files — split on whitespace to pass as separate arguments
      const fileList = files.split(/\s+/).filter(Boolean);
      execFileSync("git", hardenedGitArgs(["add", ...fileList]), {
        env: gitExecEnv(),
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });

      // Commit — execFileSync passes message as argument, no shell interpolation
      const out = execFileSync("git", hardenedGitArgs(["commit", "-m", message]), {
        env: gitExecEnv(),
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git commit failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // git_branch
  // -----------------------------------------------------------------------

  private gitBranch(args: Record<string, unknown>): ToolResult {
    const name = typeof args.name === "string" ? args.name : "";
    const create = args.create === true;

    try {
      if (!name) {
        // List branches
        const out = execFileSync("git", hardenedGitArgs(["branch"]), {
        env: gitExecEnv(),
          cwd: this.root,
          encoding: "utf-8",
          timeout: 10_000,
        });
        return { result: out.trimEnd() };
      }

      const gitArgs = create
        ? ["checkout", "-b", name]
        : ["checkout", name];

      const out = execFileSync("git", hardenedGitArgs(gitArgs), {
        env: gitExecEnv(),
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() || `Switched to branch '${name}'` };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git branch failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Git credential helper for authenticated remote ops
  // -----------------------------------------------------------------------

  private execGitAuth(gitArgs: string[], timeoutMs = 60_000): string {
    const args: string[] = [];
    if (this.githubToken) {
      // Inject a one-shot credential helper that echoes the token as HTTPS password
      const helper = `!f() { echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=${this.githubToken}"; }; f`;
      args.push("-c", `credential.helper=${helper}`);
    }
    args.push(...gitArgs);
    return execFileSync("git", hardenedGitArgs(args), {
        env: gitExecEnv(),
      cwd: this.root,
      encoding: "utf-8",
      timeout: timeoutMs,
    }).trimEnd();
  }

  // -----------------------------------------------------------------------
  // git_fetch
  // -----------------------------------------------------------------------

  private gitFetch(args: Record<string, unknown>): ToolResult {
    const remote = typeof args.remote === "string" ? args.remote : "origin";
    try {
      const out = this.execGitAuth(["fetch", remote]);
      return { result: out || `Fetched from ${remote}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "git fetch failed" };
    }
  }

  // -----------------------------------------------------------------------
  // git_push
  // -----------------------------------------------------------------------

  private gitPush(args: Record<string, unknown>): ToolResult {
    const remote = typeof args.remote === "string" ? args.remote : "origin";
    const branch = typeof args.branch === "string" ? args.branch : "";
    const setUpstream = args.setUpstream === true;

    const gitArgs = ["push"];
    if (setUpstream) gitArgs.push("--set-upstream");
    gitArgs.push(remote);
    if (branch) gitArgs.push(branch);

    try {
      const out = this.execGitAuth(gitArgs);
      return { result: out || `Pushed to ${remote}${branch ? ` ${branch}` : ""}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "git push failed" };
    }
  }

  // -----------------------------------------------------------------------
  // git_pull
  // -----------------------------------------------------------------------

  private gitPull(args: Record<string, unknown>): ToolResult {
    const remote = typeof args.remote === "string" ? args.remote : "origin";
    const branch = typeof args.branch === "string" ? args.branch : "";

    const gitArgs = ["pull", remote];
    if (branch) gitArgs.push(branch);

    try {
      const out = this.execGitAuth(gitArgs);
      return { result: out || `Pulled from ${remote}${branch ? ` ${branch}` : ""}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "git pull failed" };
    }
  }

  // -----------------------------------------------------------------------
  // GitHub API helpers
  // -----------------------------------------------------------------------

  private getGitHubRepo(): { owner: string; repo: string } {
    const url = execFileSync("git", hardenedGitArgs(["remote", "get-url", "origin"]), {
        env: gitExecEnv(),
      cwd: this.root,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

    throw new Error(`Could not parse GitHub owner/repo from remote URL: ${url}`);
  }

  private async githubApiFetch(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    if (!this.githubToken) {
      throw new Error("GitHub not connected. Connect GitHub in Settings > Integrations.");
    }
    const { request: httpRequest } = await import("undici");
    const res = await httpRequest(`https://api.github.com${path}`, {
      method: (options.method ?? "GET") as any,
      headers: {
        authorization: `Bearer ${this.githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "EdgeCoder-IDE",
        "x-github-api-version": "2022-11-28",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.body.json();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const msg = (data as any)?.message ?? `HTTP ${res.statusCode}`;
      throw new Error(`GitHub API error: ${msg}`);
    }
    return data;
  }

  // -----------------------------------------------------------------------
  // github_create_pr
  // -----------------------------------------------------------------------

  private async githubCreatePr(args: Record<string, unknown>): Promise<ToolResult> {
    const title = String(args.title ?? "");
    if (!title) return { error: "title is required" };

    const body = typeof args.body === "string" ? args.body : "";
    const base = typeof args.base === "string" ? args.base : "main";
    let head = typeof args.head === "string" ? args.head : "";

    if (!head) {
      head = execFileSync("git", hardenedGitArgs(["rev-parse", "--abbrev-ref", "HEAD"]), {
        env: gitExecEnv(),
        cwd: this.root,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
    }

    try {
      const { owner, repo } = this.getGitHubRepo();
      const pr = (await this.githubApiFetch(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { title, body, head, base },
      })) as { number: number; html_url: string; title: string };
      return { result: `Created PR #${pr.number}: ${pr.title}\n${pr.html_url}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "github_create_pr failed" };
    }
  }

  // -----------------------------------------------------------------------
  // github_list_prs
  // -----------------------------------------------------------------------

  private async githubListPrs(args: Record<string, unknown>): Promise<ToolResult> {
    const state = typeof args.state === "string" ? args.state : "open";
    try {
      const { owner, repo } = this.getGitHubRepo();
      const prs = (await this.githubApiFetch(
        `/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=30`,
      )) as Array<{ number: number; title: string; state: string; user: { login: string }; html_url: string }>;
      if (prs.length === 0) return { result: `No ${state} pull requests.` };
      const lines = prs.map(
        (pr) => `#${pr.number} [${pr.state}] ${pr.title} (by @${pr.user.login}) — ${pr.html_url}`,
      );
      return { result: lines.join("\n") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "github_list_prs failed" };
    }
  }

  // -----------------------------------------------------------------------
  // github_list_issues
  // -----------------------------------------------------------------------

  private async githubListIssues(args: Record<string, unknown>): Promise<ToolResult> {
    const state = typeof args.state === "string" ? args.state : "open";
    const labels = typeof args.labels === "string" ? args.labels : "";
    try {
      const { owner, repo } = this.getGitHubRepo();
      let url = `/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=30`;
      if (labels) url += `&labels=${encodeURIComponent(labels)}`;
      const items = (await this.githubApiFetch(url)) as Array<{
        number: number; title: string; state: string; user: { login: string };
        html_url: string; pull_request?: unknown;
      }>;
      // GitHub API returns PRs as issues — filter them out
      const issues = items.filter((i) => !i.pull_request);
      if (issues.length === 0) return { result: `No ${state} issues.` };
      const lines = issues.map(
        (i) => `#${i.number} [${i.state}] ${i.title} (by @${i.user.login}) — ${i.html_url}`,
      );
      return { result: lines.join("\n") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "github_list_issues failed" };
    }
  }

  // -----------------------------------------------------------------------
  // open_pull_request: push the current branch and open a PR with gh's login
  // -----------------------------------------------------------------------

  private git(args: string[], timeoutMs = 15_000): string {
    return execFileSync("git", hardenedGitArgs(args), {
      env: gitExecEnv({ GIT_TERMINAL_PROMPT: "0" }),
      cwd: this.root,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  }

  private gitOk(args: string[]): string | null {
    try {
      return this.git(args);
    } catch {
      return null;
    }
  }

  /** The repository's default branch: origin/HEAD, then gh, then main. */
  private defaultBranch(): string {
    const head = this.gitOk(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (head && head.startsWith("origin/")) return head.slice("origin/".length);
    const gh = findGh();
    if (gh) {
      try {
        const out = execFileSync(gh, ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], {
          cwd: this.root,
          encoding: "utf-8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "ignore"],
          env: gitExecEnv({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }),
        }).trim();
        if (/^[A-Za-z0-9._/-]{1,200}$/.test(out)) return out;
      } catch {
        // fall through
      }
    }
    return "main";
  }

  private validBranch(name: string): boolean {
    if (!name || name.startsWith("-") || name.length > 200) return false;
    return this.gitOk(["check-ref-format", "--branch", name]) !== null;
  }

  /**
   * Work out the pull request before asking: base (the default branch unless given), branch (the
   * current one, or bot/<name>/<slug> when on the default branch), commits and diffstat. Throws
   * when it can't be opened, including any attempt to push the default branch.
   */
  preparePullRequest(args: Record<string, unknown>): PullRequestPlan {
    const title = String(args.title ?? "").replace(/\s+/g, " ").trim().slice(0, 256);
    if (!title) throw new Error("A pull request needs a title.");
    const body = typeof args.body === "string" ? args.body.slice(0, 60_000) : "";
    if (this.gitOk(["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("This project isn't a git repository.");
    if (!this.gitOk(["remote", "get-url", "origin"])) throw new Error("This repository has no origin remote to push to.");
    const defaultBranch = this.defaultBranch();
    const base = typeof args.base === "string" && args.base.trim() ? args.base.trim() : defaultBranch;
    if (!this.validBranch(base)) throw new Error(`"${base}" isn't a branch name.`);
    const headRaw = this.gitOk(["rev-parse", "--abbrev-ref", "HEAD"]);
    const current = headRaw && headRaw !== "HEAD" ? headRaw : null;
    let branch = typeof args.branch === "string" ? args.branch.trim() : "";
    if (!branch) branch = current && current !== defaultBranch && current !== base ? current : pullRequestBranch(this.branchPrefix, title);
    if (!this.validBranch(branch)) throw new Error(`"${branch}" isn't a branch name.`);
    if (branch === defaultBranch || branch === base) {
      throw new Error(`Refusing to push to ${branch}, the ${branch === defaultBranch ? "default" : "base"} branch: a pull request goes on its own branch.`);
    }
    let createBranch = false;
    if (branch !== current) {
      if (this.gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null) {
        throw new Error(`Branch ${branch} already exists and isn't checked out. Switch to it first, or leave branch empty.`);
      }
      createBranch = true;
    }
    const baseRef = this.gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]) !== null ? `origin/${base}` : base;
    const commits = Number(this.gitOk(["rev-list", "--count", `${baseRef}..HEAD`]) ?? "0") || 0;
    if (commits === 0) throw new Error(`There are no commits on top of ${base} to open a pull request with. Commit your changes first (git_commit).`);
    const diffstat = this.gitOk(["diff", "--stat", "--no-color", `${baseRef}...HEAD`]) ?? "";
    const uncommitted = (this.gitOk(["status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length;
    return { title, body, base, branch, createBranch, diffstat: diffstat.length > 4_000 ? `${diffstat.slice(0, 4_000)}\n…` : diffstat, commits, uncommitted };
  }

  private async openPullRequest(args: Record<string, unknown>, approved: boolean): Promise<ToolResult> {
    // Never without an explicit approval of this very call.
    if (!approved) return { error: "open_pull_request needs the user's approval." };
    const gh = findGh();
    if (!gh) return { error: "Install the GitHub CLI (brew install gh) and run `gh auth login` to open pull requests." };
    const plan = this.preparePullRequest(args);
    if (plan.createBranch) this.git(["switch", "-c", plan.branch]);
    const origin = this.gitOk(["remote", "get-url", "origin"]) ?? "";
    // gh's stored login as git's credential for github.com; no token passes through EdgeCoder.
    const cred = /^https:\/\/github\.com\//i.test(origin) ? ghCredentialConfig() : [];
    try {
      // An explicit refspec: only this branch, which was checked not to be the default one.
      this.git([...cred, "push", "--set-upstream", "origin", `refs/heads/${plan.branch}:refs/heads/${plan.branch}`], 120_000);
    } catch (err) {
      const e = err as { stderr?: unknown; message?: string };
      return { error: `git push failed: ${String(e.stderr || e.message || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    const out = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = spawn(gh, ["pr", "create", "--title", plan.title, "--body", plan.body, "--base", plan.base, "--head", plan.branch], {
        cwd: this.root,
        env: gitExecEnv({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        done({ code: 1, stdout, stderr: e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? 1, stdout, stderr });
      });
    });
    const url = /https:\/\/\S+\/pull\/\d+/.exec(`${out.stdout}\n${out.stderr}`)?.[0];
    if (out.code !== 0 || !url) return { error: `gh pr create failed: ${(out.stderr || out.stdout).trim().slice(0, 500) || `exit ${out.code}`}` };
    return { result: `Opened pull request ${url}\nBranch ${plan.branch} → ${plan.base} (${plan.commits} commit${plan.commits === 1 ? "" : "s"}).` };
  }
}

/**
 * The arguments the approval card shows and the call then runs with: open_pull_request gets its
 * base and branch filled in, plus the diffstat and commit count (shown, not used). Other tools pass.
 */
export function preparePullRequestArgs(executor: ToolExecutor, tool: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== "open_pull_request") return args;
  const plan = executor.preparePullRequest(args);
  return { title: plan.title, body: plan.body, base: plan.base, branch: plan.branch, diffstat: plan.diffstat, commits: plan.commits, uncommitted: plan.uncommitted };
}

/** True when the project's origin is on github.com (open_pull_request is offered to chat then). */
export function hasGitHubOrigin(root: string): boolean {
  try {
    const url = execFileSync("git", hardenedGitArgs(["remote", "get-url", "origin"]), { cwd: root, env: gitExecEnv(), encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(url);
  } catch {
    return false;
  }
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * How much a coding session asks before it acts (permission modes), which commands never need to
 * ask (read-only) and which always do (risky), and the "always" answers kept per project.
 *
 * Modes:
 *   ask         edits and commands ask (read-only commands never do)
 *   auto-edits  edits apply without asking (each turn's checkpoint keeps them undoable); commands ask
 *   auto        edits and commands apply without asking, except risky commands (riskOf)
 *
 * Whatever the mode: pushes and pull requests ask, edits to protected paths (the git directory,
 * hooks, files tooling executes) ask, and the executor's own refusals still apply.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { classifyRelativePath, isWithin, parseArgv, realPathEscape } from "./tool-executor.js";

export type PermissionMode = "ask" | "auto-edits" | "auto";
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto-edits", "auto"];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);
}

/** The next mode for Shift+Tab. */
export function nextMode(m: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(m) + 1) % PERMISSION_MODES.length];
}

/** Commands that only read. Arguments are checked per program (readOnlyArgs). */
const READ_ONLY_BINS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "pwd", "echo", "tree", "stat", "file", "du", "df",
  "which", "whoami", "date", "uname", "basename", "dirname", "realpath", "sort", "uniq", "cut", "tr", "nl", "diff", "cmp", "true",
]);
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "branch", "remote", "describe", "shortlog", "grep"]);
/** find actions that run or delete things, or write files. */
const FIND_WRITES = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

/** Programs whose job is to change or remove things outside what an undo can bring back. */
const RISKY_BINS = new Set(["rm", "rmdir", "shred", "dd", "mkfs", "sudo", "su", "doas", "chown", "chmod", "chgrp", "kill", "killall", "pkill", "shutdown", "reboot", "launchctl", "systemctl", "crontab", "diskutil", "format"]);
/** Network fetches and remote access. */
const NETWORK_BINS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "http", "https", "aria2c", "gh"]);
/** Package managers' install / add / global commands (they fetch and run other people's code). */
const INSTALLS: Record<string, RegExp> = {
  npm: /^(i|install|add|ci|update|upgrade|link|exec|x|publish)$/,
  pnpm: /^(i|install|add|update|up|dlx|exec|link|publish)$/,
  yarn: /^(add|install|upgrade|dlx|link|publish|global)$/,
  bun: /^(add|install|i|update|x|link|publish)$/,
  pip: /^(install|download|uninstall)$/,
  pip3: /^(install|download|uninstall)$/,
  pipx: /^(install|run|inject)$/,
  uv: /^(add|pip|tool|sync|run)$/,
  poetry: /^(add|install|update)$/,
  brew: /^(install|reinstall|upgrade|tap|uninstall)$/,
  apt: /.*/,
  "apt-get": /.*/,
  yum: /.*/,
  dnf: /.*/,
  pacman: /.*/,
  port: /^(install|upgrade|uninstall)$/,
  gem: /^(install|update|uninstall)$/,
  cargo: /^(install|add|uninstall|publish)$/,
  go: /^(install|get)$/,
  composer: /^(require|install|update)$/,
};
/** Always a download-and-run. */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);

/** Splits a command at |, &&, || and ; (outside quotes); null when it has syntax we don't read (substitution, subshells, here-docs). */
export function splitCommand(command: string): Array<{ text: string; op: string }> | null {
  if (/[`\n\r]|\$\(|<\(|>\(|<</.test(command)) return null;
  const out: Array<{ text: string; op: string }> = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push({ text: cur.trim(), op: two });
      cur = "";
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&") {
      out.push({ text: cur.trim(), op: ch });
      cur = "";
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") return null;
    cur += ch;
  }
  if (quote) return null;
  out.push({ text: cur.trim(), op: "" });
  return out.every((s) => s.text) ? out : null;
}

/** Redirection targets (`> file`, `2>>log`) of one segment, and the segment without them; null when unreadable. */
function redirections(segment: string): { rest: string; targets: string[]; inputs: string[] } | null {
  const targets: string[] = [];
  const inputs: string[] = [];
  // Outside quotes only: a quoted ">" is an argument.
  let rest = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      rest += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      rest += ch;
      continue;
    }
    if (ch === ">" || ch === "<") {
      let j = i + 1;
      if (segment[j] === ">" || segment[j] === "&") j++;
      while (segment[j] === " ") j++;
      let k = j;
      while (k < segment.length && !/\s/.test(segment[k])) k++;
      const target = segment.slice(j, k);
      if (!target) return null;
      // Drop the fd number before the operator (2>).
      rest = rest.replace(/\d$/, "");
      if (ch === ">") {
        if (!/^\d$/.test(target) && target !== "-") targets.push(target);
      } else inputs.push(target);
      i = k - 1;
      continue;
    }
    rest += ch;
  }
  return { rest: rest.trim(), targets, inputs };
}

function escapes(arg: string, root: string): boolean {
  const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
  if (!value || (value.startsWith("-") && !value.includes("/"))) return false;
  if (value.startsWith("~") || value.startsWith("$")) return true;
  const abs = resolve(root, value);
  if (!isWithin(root, abs)) return true;
  return realPathEscape(root, abs) !== null;
}

function protectedArg(arg: string, root: string): boolean {
  if (arg.startsWith("-")) return false;
  try {
    const rel = resolve(root, arg).slice(root.length + 1);
    return classifyRelativePath(rel) !== null;
  } catch {
    return false;
  }
}

function readOnlyArgv(argv: string[]): boolean {
  const [bin, ...args] = argv;
  if (!READ_ONLY_BINS.has(bin)) {
    if (bin !== "git") return false;
    const sub = args[0] ?? "";
    if (!GIT_READ_ONLY.has(sub)) return false;
    if (args.some((a) => a === "--output" || a.startsWith("--output=") || a === "--ext-diff" || a.startsWith("--exec"))) return false;
    if (sub === "branch" && args.slice(1).some((a) => !["-a", "-r", "-v", "-vv", "--list", "--all", "--remotes", "--show-current", "--merged", "--no-merged", "--contains"].includes(a))) return false;
    if (sub === "remote" && !(args.length === 1 || (args.length === 2 && ["-v", "--verbose"].includes(args[1])))) return false;
    return true;
  }
  if (bin === "find" && args.some((a) => FIND_WRITES.test(a))) return false;
  // rg --pre runs a program on each file; sort -o writes one.
  if (bin === "rg" && args.some((a) => a === "--pre" || a.startsWith("--pre="))) return false;
  if (bin === "sort" && args.some((a) => a === "-o" || a.startsWith("-o") || a.startsWith("--output"))) return false;
  return true;
}

/**
 * True for a command that only reads inside the project: every part is a read-only program
 * (pipes between them are fine), with no redirection, no command substitution and no path
 * outside the project.
 */
export function isReadOnlyCommand(command: unknown, root: string): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const parts = splitCommand(command.trim());
  if (!parts) return false;
  // Only pipes and sequences of reads; `&` (background) is not a read.
  if (parts.some((p) => p.op === "&")) return false;
  for (const p of parts) {
    if (/[<>]/.test(p.text.replace(/'[^']*'|"[^"]*"/g, ""))) return false;
    let argv: string[];
    try {
      argv = parseArgv(p.text);
    } catch {
      return false;
    }
    if (!argv.length || argv[0].includes("/") || /^\w+=/.test(argv[0])) return false;
    if (!readOnlyArgv(argv)) return false;
    if (argv.slice(1).some((a) => escapes(a, root))) return false;
  }
  return true;
}

/** Why a command is risky (asks in every mode), or null. */
export function riskOf(command: unknown, root: string): string | null {
  if (typeof command !== "string" || !command.trim()) return "an empty or malformed command";
  const c = command.trim();
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(c)) return "downloads and runs a script";
  const parts = splitCommand(c);
  if (!parts) return "uses shell syntax that can't be checked (command substitution, subshells or here-docs)";
  for (const p of parts) {
    const r = redirections(p.text);
    if (!r) return "has a redirection that can't be checked";
    for (const t of r.targets) {
      if (escapes(t, root)) return `writes outside the project (${t})`;
      if (protectedArg(t, root)) return `writes a protected path (${t})`;
    }
    for (const t of r.inputs) if (escapes(t, root)) return `reads outside the project (${t})`;
    let argv: string[];
    try {
      argv = parseArgv(r.rest);
    } catch {
      return "has an unterminated quote";
    }
    // Leading VAR=value assignments.
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
    if (!argv.length) continue;
    let [bin, ...args] = argv;
    if (bin === "env" || bin === "command" || bin === "exec" || bin === "nohup" || bin === "time" || bin === "xargs") {
      if (bin === "xargs") return "runs commands from its input (xargs)";
      [bin, ...args] = args.filter((a) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && !a.startsWith("-"));
      if (!bin) continue;
    }
    const name = bin.split("/").pop()!;
    if (bin.includes("/") && escapes(bin, root)) return `runs a program outside the project (${bin})`;
    if (RISKY_BINS.has(name)) return `${name} deletes or changes things a checkpoint can't restore`;
    if (NETWORK_BINS.has(name)) return `${name} reaches the network`;
    if (RUNNERS.has(name)) return `${name} downloads and runs a package`;
    if (/^(ba|z|da|k|fi)?sh$/.test(name) && args.some((a) => a === "-c")) return "runs a shell script given inline";
    if (INSTALLS[name] && INSTALLS[name].test(args.find((a) => !a.startsWith("-")) ?? "")) return `${name} ${args[0] ?? ""} installs packages`.replace(/\s+/g, " ");
    if (name === "git") {
      const sub = args.find((a) => !a.startsWith("-")) ?? "";
      if (sub === "push") return "git push publishes commits";
      if (sub === "reset" && args.includes("--hard")) return "git reset --hard discards changes";
      if (sub === "clean") return "git clean deletes untracked files";
      if ((sub === "checkout" || sub === "restore") && (args.includes("--") || args.includes(".") || args.includes("-f"))) return `git ${sub} discards changes`;
      if (sub === "branch" && args.some((a) => a === "-D" || a === "-d" || a === "--delete")) return "git branch -D deletes a branch";
      if (sub === "rebase" || sub === "filter-branch" || sub === "filter-repo") return `git ${sub} rewrites history`;
      if (sub === "stash" && args.some((a) => a === "drop" || a === "clear")) return "git stash drop discards changes";
      if (["fetch", "pull", "clone", "submodule"].includes(sub)) return `git ${sub} reaches the network`;
      if (sub === "config" || args.includes("-c")) return "changes git configuration";
    }
    for (const a of args) {
      if (escapes(a, root)) return `touches a path outside the project (${a})`;
      if (protectedArg(a, root)) return `touches a protected path (${a})`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Always" answers per project
// ---------------------------------------------------------------------------

export interface ProjectPermissions {
  /** Command names approved "always" (npm, make); never covers a risky command. */
  shell: string[];
  /** Edits were approved "always": new sessions here start in auto-edits. */
  edits?: boolean;
}

export function defaultPermissionsFile(env: NodeJS.ProcessEnv = process.env): string {
  // Beside the sessions when they live elsewhere (EDGECODER_SESSIONS_DIR: tests, a second profile).
  return env.EDGECODER_PERMISSIONS_FILE || (env.EDGECODER_SESSIONS_DIR ? join(env.EDGECODER_SESSIONS_DIR, "permissions.json") : join(homedir(), ".edgecoder", "permissions.json"));
}

/** "Always" answers kept per project folder in one JSON file (0600). A null path keeps them in memory. */
export class PermissionStore {
  private data: Record<string, ProjectPermissions> = {};
  private loaded = false;
  constructor(private readonly file: string | null) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file || !existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, ProjectPermissions>;
      for (const [root, p] of Object.entries(raw ?? {})) {
        if (!p || typeof p !== "object") continue;
        this.data[root] = { shell: Array.isArray(p.shell) ? p.shell.filter((s) => typeof s === "string" && /^[A-Za-z0-9._\-/]{1,64}$/.test(s)) : [], ...(p.edits ? { edits: true } : {}) };
      }
    } catch {
      // a damaged file is ignored
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows
    }
  }

  get(root: string): ProjectPermissions {
    this.load();
    return this.data[root] ?? { shell: [] };
  }

  allowShell(root: string, prefix: string): void {
    this.load();
    const p = (this.data[root] ??= { shell: [] });
    if (!p.shell.includes(prefix)) p.shell.push(prefix);
    this.save();
  }

  allowEdits(root: string): void {
    this.load();
    (this.data[root] ??= { shell: [] }).edits = true;
    this.save();
  }
}

/**
 * The mode a new session starts in: auto-edits when edits are recoverable (a git repository with a
 * clean working tree, so the checkpoint and git both hold the original) or were approved "always"
 * for this project; otherwise ask.
 */
export function defaultMode(root: string, perms?: ProjectPermissions): PermissionMode {
  if (perms?.edits) return "auto-edits";
  try {
    const out = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_OPTIONAL_LOCKS: "0" },
    });
    return out.trim() === "" ? "auto-edits" : "ask";
  } catch {
    return "ask";
  }
}

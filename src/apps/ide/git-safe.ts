// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Hardening for every git command the IDE runs on a project. Git reads per-repository config and
 * hooks from the project's git directory, and some of that config names commands git runs itself
 * (core.fsmonitor on every `git status`, hooks on commit/checkout/merge). These overrides make the
 * IDE's own git calls ignore them. Calls that pass the repository (`hardenedGitArgs(args, cwd)`)
 * also override every other command-running key that repository's config sets (filter, diff and
 * merge drivers, signing programs, ssh/credential helpers, upload-pack and the rest:
 * repoConfigOverrides), so a tampered `.git/` can't run code when the IDE polls status, diffs,
 * fetches or commits. Hooks are off for commits the IDE makes too; the user's own terminal git is
 * unaffected.
 *
 * The same settings are passed two ways: `-c` arguments for the git process the IDE starts, and
 * GIT_CONFIG_COUNT/KEY/VALUE environment variables, which reach git processes started by other
 * tools (gh, commands in an approved run_shell).
 *
 * GIT_CONFIG_NOSYSTEM is not set: the system config is not writable from the project, and it is
 * where Apple git and Git for Windows configure the credential helper that pushes rely on.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let windowsHooksDir: string | null = null;

/** A hooks directory with no hooks in it: /dev/null on POSIX, an empty temp folder on Windows. */
export function emptyHooksPath(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "/dev/null";
  if (!windowsHooksDir) windowsHooksDir = mkdtempSync(join(tmpdir(), "edgecoder-nohooks-"));
  return windowsHooksDir;
}

/** Config overrides applied to every IDE git invocation, as [key, value] pairs. */
export function gitHardeningConfig(platform: NodeJS.Platform = process.platform): Array<[string, string]> {
  return [
    ["core.fsmonitor", "false"],
    ["core.hooksPath", emptyHooksPath(platform)],
    ["protocol.ext.allow", "never"],
    // A project folder that isn't a repository must not become one by having HEAD, config,
    // objects/ and refs/ written into it (implicit bare-repository discovery).
    ["safe.bareRepository", "explicit"],
  ];
}

/** `-c key=value` arguments to put before the git subcommand. */
export function gitHardeningArgs(): string[] {
  return gitHardeningConfig().flatMap(([k, v]) => ["-c", `${k}=${v}`]);
}

/**
 * `args` (a git subcommand and its arguments) with the hardening options in front. With `cwd` (the
 * repository the command runs in), commands named by that repository's own config are overridden
 * too (repoConfigOverrides).
 */
export function hardenedGitArgs(args: string[], cwd?: string): string[] {
  if (!cwd) return [...gitHardeningArgs(), ...args];
  const repo = repoConfigOverrides(readRepoConfig(cwd));
  return [...gitHardeningArgs(), ...repo.flatMap(([k, v]) => ["-c", `${k}=${v}`]), ...pinnedCommandArgs(args)];
}

/**
 * Options that `-c` can't replace: git uses the first remote.<name>.uploadpack/receivepack it
 * reads (the repository's), so fetch/pull/ls-remote/push name the standard programs explicitly;
 * diff/log/show get --no-ext-diff for external diff commands.
 */
const PINNED_OPTIONS: Record<string, string> = {
  fetch: "--upload-pack=git-upload-pack",
  pull: "--upload-pack=git-upload-pack",
  "ls-remote": "--upload-pack=git-upload-pack",
  push: "--receive-pack=git-receive-pack",
  diff: "--no-ext-diff",
  log: "--no-ext-diff",
  show: "--no-ext-diff",
};

function pinnedCommandArgs(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  const opt = Object.hasOwn(PINNED_OPTIONS, args[i] ?? "") ? PINNED_OPTIONS[args[i]] : undefined;
  return opt ? [...args.slice(0, i + 1), opt, ...args.slice(i + 1)] : args;
}

// --- Commands named in the repository's own config ---------------------------------------------

/** One config entry as `git config --list --show-scope` reports it (key: section and name lower case). */
export interface GitConfigEntry {
  scope: string;
  key: string;
  value: string;
}

/** Scopes a project folder can bring with it: `.git/config`, `config.worktree` and what they include. */
const REPO_SCOPES = new Set(["local", "worktree"]);

/** The project-supplied values git-lfs writes (`git lfs install --local`); they run git-lfs from PATH. */
const LFS_VALUES = new Set(["git-lfs clean -- %f", "git-lfs smudge -- %f", "git-lfs filter-process"]);

/**
 * The value that makes a command-running key inert, or null for a key that runs nothing. Covers
 * git-config(1) keys whose value git executes: filter/diff/merge drivers, textconv, external diff,
 * signing programs, ssh/askpass/credential helpers, pagers and editors,
 * alternate-refs and trailer commands, difftool/mergetool commands and `!` submodule updates.
 */
function inertValue(key: string, value: string): string | null {
  const lower = key.toLowerCase();
  const parts = lower.split(".");
  const section = parts[0];
  const name = parts[parts.length - 1];
  const sub = parts.length > 2;
  switch (lower) {
    case "core.sshcommand": return "ssh";
    case "core.pager": return "cat";
    case "core.editor":
    case "sequence.editor": return "true";
    case "core.askpass":
    case "credential.helper": return "";
    // Empty would make git try to run "": these print nothing instead. diff/log/show also get
    // --no-ext-diff (hardenedGitArgs).
    case "core.alternaterefscommand":
    case "diff.external": return "true";
    case "gpg.ssh.defaultkeycommand": return "false";
    case "gpg.program":
    case "gpg.openpgp.program": return "gpg";
    case "gpg.x509.program": return "gpgsm";
    case "gpg.ssh.program": return "ssh-keygen";
  }
  if (!sub) return section === "pager" ? "false" : null;
  if (section === "filter" && (name === "clean" || name === "smudge" || name === "process")) return LFS_VALUES.has(value) ? null : "";
  if (section === "filter" && name === "required") return "false";
  if (section === "diff" && name === "command") return "true";
  if (section === "diff" && name === "textconv") return "cat";
  if (section === "merge" && name === "driver") return "false";
  if (section === "credential" && name === "helper") return "";
  if (section === "trailer" && (name === "command" || name === "cmd")) return "";
  if ((section === "difftool" || section === "mergetool") && name === "cmd") return "";
  if (section === "submodule" && name === "update") return value.trim().startsWith("!") ? "none" : null;
  return null;
}

/**
 * `-c` overrides that neutralise every command-running key the repository's own config sets.
 * Command-line config is read last, so the inert value wins; the user's global and system values
 * for the same key are re-applied after it, so their own helpers and drivers keep working (for
 * multi-valued keys like credential.helper the empty value first clears the repository's entries).
 * core.gitProxy can't be overridden (git uses its first match), so git:// is refused instead.
 */
export function repoConfigOverrides(entries: GitConfigEntry[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const done = new Set<string>();
  for (const e of entries) {
    if (!REPO_SCOPES.has(e.scope)) continue;
    const lower = e.key.toLowerCase();
    if (lower === "core.gitproxy") {
      if (!done.has(lower)) out.push(["protocol.git.allow", "never"]);
      done.add(lower);
      continue;
    }
    const inert = inertValue(e.key, e.value);
    if (inert === null || done.has(e.key)) continue;
    // `-c` splits at the first "=", so such a key can't be overridden: don't run git at all.
    if (e.key.includes("=")) throw new Error(`This repository's git config sets "${e.key.slice(0, 80)}", which EdgeCoder can't neutralise; git is not run here.`);
    done.add(e.key);
    out.push([e.key, inert]);
    for (const g of entries) if (g.key === e.key && !REPO_SCOPES.has(g.scope) && g.scope !== "command") out.push([g.key, g.value]);
  }
  return out;
}

/** The config git sees in `cwd`, with scopes (reading config runs nothing). [] if git fails. */
export function readRepoConfig(cwd: string): GitConfigEntry[] {
  let raw: string;
  try {
    raw = execFileSync("git", [...gitHardeningArgs(), "config", "--list", "--show-scope", "--includes", "-z"], {
      cwd,
      env: hardenedGitEnv(),
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const parts = raw.split("\0");
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf("\n");
    entries.push(nl < 0
      ? { scope: parts[i], key: parts[i + 1], value: "" }
      : { scope: parts[i], key: parts[i + 1].slice(0, nl), value: parts[i + 1].slice(nl + 1) });
  }
  return entries;
}

/** `base` plus the hardening config as GIT_CONFIG_COUNT/KEY_n/VALUE_n, appended to any already there. */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  let n = Number.isInteger(existing) && existing > 0 ? existing : 0;
  for (const [k, v] of gitHardeningConfig()) {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

/** Options for execFile/execFileSync/spawn of git: hardened env merged with the caller's. */
export function gitExecEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hardenedGitEnv({ ...process.env, ...extra });
}

/** Env var the GitHub credential helper reads the token from. */
export const GIT_TOKEN_ENV = "EDGECODER_GIT_TOKEN";

/**
 * gitExecEnv plus a github.com credential helper that answers with the token from GIT_TOKEN_ENV.
 * The helper is passed as GIT_CONFIG_KEY/VALUE and expands the variable itself, so the token is in
 * neither argv nor the config value.
 */
export function githubTokenCredentialEnv(token: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = hardenedGitEnv({ ...base, [GIT_TOKEN_ENV]: token });
  let n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  env[`GIT_CONFIG_KEY_${n}`] = "credential.https://github.com.helper";
  env[`GIT_CONFIG_VALUE_${n}`] = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV}"; }; f`;
  n++;
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

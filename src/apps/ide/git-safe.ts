// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Hardening for every git command the IDE runs on a project. Git reads per-repository config and
 * hooks from the project's git directory, and some of that config names commands git runs itself
 * (core.fsmonitor on every `git status`, hooks on commit/checkout/merge). These overrides make the
 * IDE's own git calls ignore them, so a tampered `.git/` can't run code when the IDE polls status
 * or commits. Hooks are off for commits the IDE makes too; the user's own terminal git is unaffected.
 *
 * The same settings are passed two ways: `-c` arguments for the git process the IDE starts, and
 * GIT_CONFIG_COUNT/KEY/VALUE environment variables, which reach git processes started by other
 * tools (gh, commands in an approved run_shell).
 *
 * GIT_CONFIG_NOSYSTEM is not set: the system config is not writable from the project, and it is
 * where Apple git and Git for Windows configure the credential helper that pushes rely on.
 */

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

/** `args` (a git subcommand and its arguments) with the hardening options in front. */
export function hardenedGitArgs(args: string[]): string[] {
  return [...gitHardeningArgs(), ...args];
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

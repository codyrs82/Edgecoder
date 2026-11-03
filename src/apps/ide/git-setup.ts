// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Getting a project into git from the source-control panel: clone URLs (validated), cloning, and
 * the GitHub CLI (`gh`) for publishing. GitHub auth is the user's own: the system git credential
 * helper and `gh`'s login (keychain). EdgeCoder never reads, stores or forwards a GitHub token;
 * pushes to github.com fall back to `gh auth git-credential`, which hands the token to git directly.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { gitExecEnv, hardenedGitArgs } from "./git-safe.js";

export class GitSetupError extends Error {}

const SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const SCP_LIKE = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/;

/**
 * A remote URL the panel may clone or add: https (no embedded credentials), ssh://git@host/…,
 * git@host:owner/repo, or GitHub's owner/repo shorthand (→ https://github.com/owner/repo.git).
 * Rejects file:, ext:: and other transports, local paths and anything that looks like an option.
 */
export function normalizeRemoteUrl(input: string): string {
  const s = input.trim();
  const bad = (why: string): never => {
    throw new GitSetupError(`${why} Use an https URL, git@host:owner/repo, or owner/repo for GitHub.`);
  };
  if (!s) bad("Enter a repository URL.");
  // eslint-disable-next-line no-control-regex
  if (s.startsWith("-") || /[\s\u0000-\u001f\u007f]/.test(s)) bad("That isn't a repository URL.");
  if (s.includes("::")) bad("That transport isn't allowed.");
  const short = SHORTHAND.exec(s);
  if (short && !short[2].startsWith(".")) return `https://github.com/${short[1]}/${short[2].replace(/\.git$/, "")}.git`;
  const scp = SCP_LIKE.exec(s);
  if (scp) {
    if (scp[1].startsWith("-") || scp[2].startsWith("-") || scp[2].split("/").includes("..")) bad("That isn't a repository URL.");
    return s;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return bad("That isn't a repository URL.");
  }
  if (u.protocol === "https:") {
    if (u.username || u.password) bad("Don't put credentials in the URL; git's credential helper signs you in.");
  } else if (u.protocol === "ssh:") {
    if (u.username !== "git" || u.password) bad("ssh URLs must be ssh://git@host/owner/repo.");
  } else {
    bad(`${u.protocol.replace(/:$/, "")}: URLs aren't allowed.`);
  }
  if (!u.hostname || u.hostname.startsWith("-") || u.pathname.length < 2) bad("That isn't a repository URL.");
  return s;
}

/** The folder name a clone gets: the URL's last path segment without .git. */
export function repoNameFromUrl(url: string): string {
  const tail = url.replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
  const name = tail.replace(/\.git$/, "");
  return validFolderName(name) ? name : "repository";
}

export function validFolderName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,200}$/.test(name) && !name.startsWith("-") && name !== "." && name !== "..";
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      // gh runs git itself; it gets the same hardening through the environment.
      cmd === "git" ? hardenedGitArgs(args) : args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, env: gitExecEnv({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }) },
      (err, stdout, stderr) => {
        if (err) reject(new GitSetupError((stderr || err.message).trim()));
        else resolve({ stdout, stderr });
      },
    );
  });
}

/** Clone `url` (already normalized) into `<parentDir>/<name>`; returns the new folder. */
export async function cloneRepo(url: string, parentDir: string, name?: string): Promise<string> {
  if (!isAbsolute(parentDir)) throw new GitSetupError("Pick a folder to clone into.");
  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) throw new GitSetupError(`${parentDir} isn't a folder.`);
  const folder = name ?? repoNameFromUrl(url);
  if (!validFolderName(folder)) throw new GitSetupError(`"${folder}" isn't a usable folder name.`);
  const dest = join(parentDir, folder);
  if (existsSync(dest)) throw new GitSetupError(`${dest} already exists. Pick another folder.`);
  // ext:: is refused by the URL check too; this also covers anything a submodule or redirect might name.
  await run("git", ["clone", "--", url, dest], { timeoutMs: 15 * 60_000 });
  return dest;
}

// --- GitHub CLI -------------------------------------------------------------------------------

/** gh's path: EDGECODER_GH_BIN, then PATH, then the usual install folders (a Finder-launched app has a short PATH). */
export function findGh(): string | null {
  const override = process.env.EDGECODER_GH_BIN;
  if (override) return existsSync(override) ? override : null;
  const exe = process.platform === "win32" ? "gh.exe" : "gh";
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    ...(process.platform === "win32" ? ["C:\\Program Files\\GitHub CLI"] : []),
  ].filter(Boolean);
  for (const d of dirs) {
    const p = join(d, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface GitHubStatus {
  ghInstalled: boolean;
  loggedIn: boolean;
  login: string | null;
}

/** Whether gh is installed and signed in to github.com, and as whom. Only the login leaves here. */
export async function githubStatus(): Promise<GitHubStatus> {
  const gh = findGh();
  if (!gh) return { ghInstalled: false, loggedIn: false, login: null };
  let out = "";
  try {
    const r = await run(gh, ["auth", "status", "--hostname", "github.com"], { timeoutMs: 15_000 });
    out = `${r.stdout}\n${r.stderr}`;
  } catch {
    return { ghInstalled: true, loggedIn: false, login: null };
  }
  const m = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(out);
  return { ghInstalled: true, loggedIn: Boolean(m), login: m?.[1] ?? null };
}

/**
 * git `-c` options that let a push to github.com use gh's login when the system credential
 * helper has nothing for it. The helper protocol passes the token from gh to git over a pipe.
 */
export function ghCredentialConfig(): string[] {
  const gh = findGh();
  if (!gh || /['"\\\n]/.test(gh)) return [];
  return ["-c", `credential.https://github.com.helper=!'${gh}' auth git-credential`];
}

/** Create a GitHub repository for `cwd` with gh and add it as `origin` (pushing is the caller's). */
export async function ghCreateRepo(cwd: string, name: string, visibility: "public" | "private"): Promise<string> {
  const gh = findGh();
  if (!gh) throw new GitSetupError("Install the GitHub CLI (brew install gh), then run `gh auth login`.");
  const { stdout } = await run(gh, ["repo", "create", name, `--${visibility}`, "--source", ".", "--remote", "origin"], { cwd, timeoutMs: 60_000 });
  return /https:\/\/github\.com\/\S+/.exec(stdout)?.[0] ?? stdout.trim();
}

/** owner/name or name, as GitHub allows it. */
export function validGitHubRepoName(name: string): boolean {
  const parts = name.split("/");
  if (parts.length > 2) return false;
  if (parts.length === 2 && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0])) return false;
  const repo = parts[parts.length - 1];
  return /^[A-Za-z0-9._-]{1,100}$/.test(repo) && !repo.startsWith("-") && !repo.startsWith(".");
}

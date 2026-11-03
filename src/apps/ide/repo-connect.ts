// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The projects folder (default ~/EdgeCoder, like Claude's and Cursor's per-user folders) and
 * "connect a repository": put a repo at <projectsFolder>/<name>, cloning it the first time and
 * fast-forwarding it after that. Local changes are never touched: a dirty copy is only reported.
 *
 * `ensureRepo` is the reusable entry point: the IDE route uses it, and persistent bots can use it
 * to turn a "Repository" field into a project folder.
 */

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { gitExecEnv, hardenedGitArgs } from "./git-safe.js";
import { GitSetupError, findGh, ghCredentialConfig, normalizeRemoteUrl, repoNameFromUrl, validFolderName } from "./git-setup.js";

// --- The projects folder ----------------------------------------------------------------------

export function defaultProjectsFolder(): string {
  return join(homedir(), "EdgeCoder");
}

function settingsFile(): string {
  return process.env.EDGECODER_IDE_SETTINGS_FILE ?? join(homedir(), ".edgecoder", "ide-settings.json");
}

interface IdeSettings {
  projectsFolder?: string;
}

function readSettings(): IdeSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as IdeSettings) : {};
  } catch {
    return {};
  }
}

/**
 * A projects-folder path as the user typed or picked it: absolute or ~/…, no `..` segments, not
 * the filesystem root. Returns the normalized absolute path; throws GitSetupError otherwise.
 */
export function resolveProjectsFolder(input: string): string {
  const s = input.trim();
  // eslint-disable-next-line no-control-regex
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) throw new GitSetupError("Choose a folder for your projects.");
  let p = s;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) throw new GitSetupError("The projects folder must be a full path (like ~/EdgeCoder).");
  if (s.split(/[/\\]+/).includes("..")) throw new GitSetupError("The projects folder can't contain \"..\".");
  const abs = normalize(resolve(p)).replace(/[/\\]+$/, "") || sep;
  if (dirname(abs) === abs) throw new GitSetupError("Pick a folder, not the root of the disk.");
  return abs;
}

/** Where projects live: EDGECODER_PROJECTS_DIR (tests, managed installs), then the setting, then ~/EdgeCoder. */
export function getProjectsFolder(): { path: string; source: "env" | "setting" | "default" } {
  const env = process.env.EDGECODER_PROJECTS_DIR;
  if (env) return { path: resolveProjectsFolder(env), source: "env" };
  const saved = readSettings().projectsFolder;
  if (typeof saved === "string") {
    try {
      return { path: resolveProjectsFolder(saved), source: "setting" };
    } catch {
      // a hand-edited bad value: fall back to the default
    }
  }
  return { path: defaultProjectsFolder(), source: "default" };
}

/** The projects folder, created if it isn't there yet. */
export function ensureProjectsFolder(): string {
  const { path } = getProjectsFolder();
  mkdirSync(path, { recursive: true });
  return path;
}

/** Save a new projects folder (validated, created) and return it. */
export function setProjectsFolder(input: string): string {
  const path = resolveProjectsFolder(input);
  mkdirSync(path, { recursive: true });
  const file = settingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...readSettings(), projectsFolder: path }, null, 2), { mode: 0o600 });
  return path;
}

/** `<folder>/<name>`, refusing any name that would land outside `folder`. */
export function projectPath(folder: string, name: string): string {
  if (!validFolderName(name)) throw new GitSetupError(`"${name}" isn't a usable folder name.`);
  const target = join(folder, name);
  const rel = relative(folder, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) throw new GitSetupError(`"${name}" isn't a usable folder name.`);
  return target;
}

// --- Remotes ----------------------------------------------------------------------------------

/**
 * A comparable key for a remote, so https://github.com/a/b.git, git@github.com:a/b and
 * ssh://git@github.com/a/b all name the same repository. Local paths (tests) compare as paths.
 */
export function remoteKey(url: string): string {
  const s = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if (scp) return `${scp[1]}/${scp[2].replace(/^\/+/, "")}`.toLowerCase();
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "ssh:" || u.protocol === "git:") {
      return `${u.hostname}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
    }
  } catch {
    // not a URL: a local path
  }
  return resolve(s);
}

// --- git --------------------------------------------------------------------------------------

type Progress = (line: string) => void;

function git(args: string[], opts: { cwd?: string; timeoutMs?: number; onProgress?: Progress } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", hardenedGitArgs(args), {
      cwd: opts.cwd,
      env: gitExecEnv({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_ASKPASS: "", SSH_ASKPASS: "" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let partial = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 60_000);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      err = (err + text).slice(-16_384);
      if (!opts.onProgress) return;
      // git redraws progress with \r; report each finished or redrawn line.
      const parts = (partial + text).split(/[\r\n]/);
      partial = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) opts.onProgress(line.trim());
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new GitSetupError(e.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new GitSetupError((signal ? `git ${args[0]} timed out` : err.trim()) || `git ${args[0]} failed`));
    });
  });
}

async function gitOk(args: string[], cwd: string): Promise<string | null> {
  try {
    return (await git(args, { cwd, timeoutMs: 15_000 })).trim();
  } catch {
    return null;
  }
}

/** gh's login as a credential for github.com over https (private repos), nothing otherwise. */
function credentialArgs(url: string): string[] {
  return /^https:\/\/github\.com\//i.test(url) ? ghCredentialConfig() : [];
}

// --- Connect ----------------------------------------------------------------------------------

export interface RepoTarget {
  path: string;
  /** A checkout of the same remote is already there. */
  exists: boolean;
}

/**
 * Where `url` goes under `folder`: `<name>` if it's free or already this repo, else `<name>-2`,
 * `<name>-3`… Anything else at a name (another remote, not a repo, a symlink, a file) is skipped.
 */
export async function pickRepoTarget(folder: string, name: string, url: string): Promise<RepoTarget> {
  const want = remoteKey(url);
  for (let n = 1; n <= 100; n++) {
    const path = projectPath(folder, n === 1 ? name : `${name}-${n}`);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return { path, exists: false };
    }
    if (!st.isDirectory() || st.isSymbolicLink() || !existsSync(join(path, ".git"))) continue;
    const origin = await gitOk(["remote", "get-url", "origin"], path);
    if (origin && remoteKey(origin) === want) return { path, exists: true };
  }
  throw new GitSetupError(`Too many folders named ${name} in ${folder}.`);
}

export interface RepoConnection {
  path: string;
  name: string;
  url: string;
  action: "cloned" | "updated";
  branch: string | null;
  /** Uncommitted or untracked files: left alone, nothing pulled. */
  dirty: boolean;
  /** Commits on the upstream not in the local branch, after any fast-forward. */
  behind: number;
  ahead: number;
  /** A fast-forward moved the branch. */
  fastForwarded: boolean;
  /** One line for the UI: what happened and why nothing was pulled, if not. */
  message: string;
}

export interface EnsureRepoOptions {
  /** Defaults to the projects folder setting (created if missing). */
  projectsFolder?: string;
  onProgress?: Progress;
}

async function branchState(path: string): Promise<{ branch: string | null; dirty: boolean; upstream: string | null }> {
  const head = await gitOk(["rev-parse", "--abbrev-ref", "HEAD"], path);
  const branch = head && head !== "HEAD" ? head : null;
  const dirty = Boolean(await gitOk(["status", "--porcelain"], path));
  const upstream = branch ? await gitOk(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], path) : null;
  return { branch, dirty, upstream: upstream || null };
}

async function aheadBehind(path: string): Promise<{ ahead: number; behind: number }> {
  const out = await gitOk(["rev-list", "--left-right", "--count", "HEAD...@{u}"], path);
  const [a, b] = (out ?? "0 0").split(/\s+/).map((x) => Number(x) || 0);
  return { ahead: a ?? 0, behind: b ?? 0 };
}

const inFlight = new Map<string, Promise<RepoConnection>>();

/**
 * Connect an already-validated remote URL (see normalizeRemoteUrl): clone it into the projects
 * folder, or fetch and fast-forward the copy that's there. Callers outside tests use ensureRepo.
 */
export function connectRepoUrl(url: string, opts: EnsureRepoOptions = {}): Promise<RepoConnection> {
  const folder = opts.projectsFolder ? resolveProjectsFolder(opts.projectsFolder) : ensureProjectsFolder();
  const key = `${folder}\n${remoteKey(url)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const job = doConnect(url, folder, opts.onProgress).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function doConnect(url: string, folder: string, onProgress?: Progress): Promise<RepoConnection> {
  mkdirSync(folder, { recursive: true });
  const name = repoNameFromUrl(url);
  const target = await pickRepoTarget(folder, name, url);
  const say = (line: string) => onProgress?.(line);

  if (!target.exists) {
    say(`Cloning into ${target.path}…`);
    await git([...credentialArgs(url), "clone", "--progress", "--", url, target.path], { timeoutMs: 15 * 60_000, onProgress });
    const st = await branchState(target.path);
    return {
      path: target.path, name, url, action: "cloned", branch: st.branch, dirty: false, behind: 0, ahead: 0, fastForwarded: false,
      message: `Cloned ${name}${st.branch ? ` (${st.branch})` : ""}.`,
    };
  }

  say(`Fetching ${name}…`);
  let fetchError: string | null = null;
  try {
    await git([...credentialArgs(url), "fetch", "--progress", "--prune", "origin"], { cwd: target.path, timeoutMs: 5 * 60_000, onProgress });
  } catch (e) {
    fetchError = (e as Error).message.split("\n")[0];
  }
  const st = await branchState(target.path);
  let fastForwarded = false;
  let note = "";
  if (fetchError) note = ` Couldn't fetch: ${fetchError}`;
  else if (!st.branch) note = " Detached HEAD: nothing pulled.";
  else if (!st.upstream) note = ` ${st.branch} has no upstream: nothing pulled.`;
  else if (st.dirty) note = " You have local changes, so nothing was pulled.";
  else {
    const before = await aheadBehind(target.path);
    if (before.behind > 0 && before.ahead === 0) {
      say(`Fast-forwarding ${st.branch}…`);
      try {
        await git(["merge", "--ff-only", "@{u}"], { cwd: target.path, timeoutMs: 60_000 });
        fastForwarded = true;
      } catch (e) {
        note = ` Couldn't fast-forward: ${(e as Error).message.split("\n")[0]}`;
      }
    } else if (before.behind > 0) {
      note = ` ${st.branch} has diverged from ${st.upstream}: nothing pulled.`;
    }
  }
  const counts = st.upstream ? await aheadBehind(target.path) : { ahead: 0, behind: 0 };
  const parts = [`${name}${st.branch ? ` (${st.branch})` : ""} is ${fastForwarded ? "updated" : counts.behind ? `${counts.behind} commit${counts.behind === 1 ? "" : "s"} behind` : "up to date"}.`];
  return {
    path: target.path, name, url, action: "updated", branch: st.branch, dirty: st.dirty, behind: counts.behind, ahead: counts.ahead, fastForwarded,
    message: (parts[0] + note).trim(),
  };
}

/**
 * Make sure `repo` (owner/repo, an https URL or an SSH URL) is checked out in the projects folder
 * and return where. The hook for anything that takes a "Repository" field, such as bots.
 */
export async function ensureRepo(repo: string, opts: EnsureRepoOptions = {}): Promise<RepoConnection> {
  return connectRepoUrl(normalizeRemoteUrl(repo), opts);
}

// --- GitHub -----------------------------------------------------------------------------------

/** The signed-in gh user's recent repositories (owner/name), or [] without gh or a login. */
export async function recentGitHubRepos(limit = 20): Promise<string[]> {
  const gh = findGh();
  if (!gh) return [];
  const out = await new Promise<string>((res) => {
    const child = spawn(gh, ["repo", "list", "--limit", String(limit), "--json", "nameWithOwner"], {
      env: gitExecEnv({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let s = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.stdout.on("data", (d: Buffer) => { s += d.toString(); });
    child.on("error", () => { clearTimeout(timer); res(""); });
    child.on("close", (code) => { clearTimeout(timer); res(code === 0 ? s : ""); });
  });
  try {
    const rows = JSON.parse(out) as Array<{ nameWithOwner?: unknown }>;
    return rows
      .map((r) => r.nameWithOwner)
      .filter((n): n is string => typeof n === "string" && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(n));
  } catch {
    return [];
  }
}

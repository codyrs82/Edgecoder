// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Git for the IDE's source-control panel: status split into staged and unstaged, stage, unstage,
 * discard, commit, branches, pull and push. These are the user's own actions from the UI (the
 * agent has its own approval-gated git tools). Runs the git CLI in the project with the user's
 * own configuration and credentials; paths are confined to the project.
 */

import { execFile } from "node:child_process";
import { ProjectFs, ProjectFsError } from "./project-fs.js";
import { gitExecEnv, hardenedGitArgs } from "./git-safe.js";
import { GitSetupError, ghCreateRepo, ghCredentialConfig, validGitHubRepoName } from "./git-setup.js";

export interface GitFile {
  path: string;
  /** M modified, A added, D deleted, R renamed, U untracked, C conflict. */
  status: string;
  /** For renames, the previous path. */
  from?: string;
}

export interface GitState {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  branches: string[];
  /** Remote names (origin first when present). */
  remotes: string[];
  /** False before the first commit. */
  hasCommits: boolean;
}

export class GitError extends Error {}

function letter(c: string): string {
  if (c === "?") return "U";
  if (c === "M" || c === "T") return "M";
  if (c === "A") return "A";
  if (c === "D") return "D";
  if (c === "R" || c === "C") return "R";
  if (c === "U") return "C";
  return "M";
}

export class GitOps {
  private readonly fs: ProjectFs;

  constructor(private readonly root: string) {
    this.fs = new ProjectFs(root);
  }

  private git(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        hardenedGitArgs(args),
        { cwd: this.root, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, env: gitExecEnv({ GIT_TERMINAL_PROMPT: "0" }) },
        (err, stdout, stderr) => {
          if (err) reject(new GitError((stderr || err.message).trim()));
          else resolve(stdout);
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  /** Project-relative paths, each confined to the project (ProjectFsError otherwise). */
  private paths(paths: string[]): string[] {
    if (paths.length === 0) throw new ProjectFsError("invalid", "no paths given");
    return paths.map((p) => this.fs.relativePath(this.fs.resolve(p)));
  }

  async state(): Promise<GitState | null> {
    let raw: string;
    try {
      raw = await this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    } catch {
      return null;
    }
    const st: GitState = { branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], branches: [], remotes: [], hasCommits: false };
    const recs = raw.split("\0");
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!r) continue;
      if (r.startsWith("# branch.oid ")) st.hasCommits = r.slice(13) !== "(initial)";
      else if (r.startsWith("# branch.head ")) st.branch = r.slice(14) === "(detached)" ? null : r.slice(14);
      else if (r.startsWith("# branch.upstream ")) st.upstream = r.slice(18);
      else if (r.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(r);
        if (m) {
          st.ahead = Number(m[1]);
          st.behind = Number(m[2]);
        }
      } else if (r.startsWith("? ")) st.unstaged.push({ path: r.slice(2), status: "U" });
      else if (r.startsWith("1 ") || r.startsWith("2 ")) {
        const parts = r.split(" ");
        const xy = parts[1];
        const path = r.startsWith("1 ") ? parts.slice(8).join(" ") : parts.slice(9).join(" ");
        const from = r.startsWith("2 ") ? recs[++i] : undefined;
        if (xy[0] !== ".") st.staged.push({ path, status: letter(xy[0]), ...(from ? { from } : {}) });
        if (xy[1] !== ".") st.unstaged.push({ path, status: letter(xy[1]) });
      } else if (r.startsWith("u ")) {
        const parts = r.split(" ");
        st.unstaged.push({ path: parts.slice(10).join(" "), status: "C" });
      }
    }
    try {
      st.branches = (await this.git(["branch", "--format=%(refname:short)"])).split("\n").map((b) => b.trim()).filter(Boolean);
    } catch {
      // no commits yet
    }
    st.remotes = await this.remotes();
    return st;
  }

  private async remotes(): Promise<string[]> {
    try {
      const names = (await this.git(["remote"])).split("\n").map((r) => r.trim()).filter(Boolean);
      return names.includes("origin") ? ["origin", ...names.filter((n) => n !== "origin")] : names;
    } catch {
      return [];
    }
  }

  /** `git init` here, on a branch named main (git's default may still be master). */
  async init(): Promise<void> {
    if (await this.state()) throw new GitError("This folder is already a git repository.");
    await this.git(["init"]);
    const head = (await this.git(["symbolic-ref", "--short", "HEAD"])).trim();
    if (head === "master") await this.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  }

  /** Add a remote. The URL is validated by the caller (normalizeRemoteUrl). */
  async addRemote(name: string, url: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.startsWith("-")) throw new GitError(`"${name}" isn't a valid remote name.`);
    if ((await this.remotes()).includes(name)) throw new GitError(`A remote named ${name} already exists.`);
    await this.git(["remote", "add", "--", name, url]);
  }

  /**
   * Publish to a new GitHub repository with gh: init if needed, make a first commit of every
   * non-ignored file if there are no commits yet, create the repository as origin, push with -u.
   */
  async publishGitHub(name: string, visibility: "public" | "private"): Promise<{ url: string; output: string }> {
    if (!validGitHubRepoName(name)) throw new GitError(`"${name}" isn't a valid GitHub repository name.`);
    if (!(await this.state())) await this.init();
    const st = (await this.state())!;
    if (st.remotes.includes("origin")) throw new GitError("This repository already has an origin remote. Use Publish Branch to push to it.");
    if (!st.branch) throw new GitError("Check out a branch before publishing.");
    if (!st.hasCommits) {
      await this.git(["add", "-A"]);
      await this.git(["commit", "--allow-empty", "-m", "Initial commit"]);
    }
    let url: string;
    try {
      url = await ghCreateRepo(this.root, name, visibility);
    } catch (err) {
      if (err instanceof GitSetupError) throw new GitError(err.message);
      throw err;
    }
    return { url, output: await this.push() };
  }

  /** A file's content at HEAD (the diff's "before"); null when it is not in HEAD. */
  async headContent(path: string): Promise<string | null> {
    const [rel] = this.paths([path]);
    try {
      return await this.git(["show", `HEAD:${rel}`]);
    } catch {
      return null;
    }
  }

  async stage(paths: string[]) {
    await this.git(["add", "--", ...this.paths(paths)]);
  }

  async unstage(paths: string[]) {
    const rels = this.paths(paths);
    try {
      await this.git(["restore", "--staged", "--", ...rels]);
    } catch {
      // before the first commit there is no HEAD to restore from
      await this.git(["rm", "--cached", "-r", "--quiet", "--", ...rels]);
    }
  }

  /** Throw away working-tree changes: tracked files go back to their staged/HEAD version, new files are deleted. */
  async discard(paths: string[]) {
    const rels = this.paths(paths);
    const st = await this.state();
    const untracked = new Set(st?.unstaged.filter((f) => f.status === "U").map((f) => f.path) ?? []);
    const tracked = rels.filter((p) => !untracked.has(p));
    if (tracked.length) await this.git(["restore", "--worktree", "--", ...tracked]);
    for (const p of rels.filter((r) => untracked.has(r))) this.fs.remove(p);
  }

  async commit(message: string, opts: { all?: boolean } = {}): Promise<string> {
    if (!message.trim()) throw new GitError("Write a commit message first.");
    if (opts.all) await this.git(["add", "-A"]);
    await this.git(["commit", "-F", "-"], { input: message });
    return (await this.git(["rev-parse", "--short", "HEAD"])).trim();
  }

  async checkout(branch: string, create = false) {
    try {
      await this.git(["check-ref-format", "--branch", branch]);
    } catch {
      throw new GitError(`"${branch}" is not a valid branch name.`);
    }
    await this.git(create ? ["switch", "-c", branch] : ["switch", branch]);
  }

  async pull(): Promise<string> {
    return (await this.git(["pull", "--ff-only"], { timeoutMs: 120_000 })).trim();
  }

  /** Push; a branch with no upstream is published with `-u <origin, else the first remote> <branch>`. */
  async push(): Promise<string> {
    const st = await this.state();
    let args: string[];
    if (st?.upstream) args = ["push"];
    else {
      const remote = st?.remotes[0];
      if (!remote) throw new GitError("This repository has no remote yet. Publish it to GitHub or add a remote first.");
      if (!st?.branch) throw new GitError("Check out a branch before publishing.");
      args = ["push", "-u", "--", remote, st.branch];
    }
    // gh's login as a fallback credential for github.com; git push reports progress on stderr.
    const out = (await this.git([...ghCredentialConfig(), ...args], { timeoutMs: 120_000 })).trim();
    return out || (st?.upstream ? "Pushed." : `Published ${st!.branch}.`);
  }
}

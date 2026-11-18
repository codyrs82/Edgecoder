// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * GitHub for cloud bots, through the REST API with the bot's own token (docs/cloud-bots.md).
 *
 * - One repository per bot, fixed in its settings: no tool takes a repository, every path is built
 *   here from the configured owner/repo, and the host is always api.github.com.
 * - Reads: files and directories, pull requests (with their changed files), issues (with comments).
 * - Writes: a comment on an issue or pull request, and a pull request from a new branch with at
 *   most a few small file edits. Never the default branch, never a merge, never .github/ (workflows
 *   run with the repository's secrets), never a force push or a deleted branch.
 * - Everything GitHub returns is wrapped as untrusted data for the model (issue text is anyone's).
 * - The token goes only into the Authorization header; errors carry GitHub's message, never it.
 */

import type { ToolSchema } from "../../apps/ide/agent-loop.js";
import { wrapUntrusted } from "../../web-tool/tools.js";
import { GITHUB_REPO_RE, type CloudTrigger } from "./types.js";

export const GITHUB_API = "https://api.github.com";
const MAX_FILE_CHARS = 40_000;
const MAX_EDIT_FILES = 10;
const MAX_EDIT_BYTES = 200_000;
const MAX_COMMENT_CHARS = 20_000;
const BRANCH_PREFIX = "edgecoder/";

/** One GitHub API call: method, path under api.github.com, JSON body. */
export type GithubHttp = (method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown) => Promise<{ status: number; json: any }>;

/** The real client: fetch with the token, a timeout, no redirects to other hosts. */
export function githubHttp(token: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): GithubHttp {
  const f = opts.fetchImpl ?? fetch;
  return async (method, path, body) => {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("bad GitHub path");
    const res = await f(`${GITHUB_API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "EdgeCoder-CloudBot/1.0",
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text.slice(0, 200) };
    }
    return { status: res.status, json };
  };
}

export function splitRepo(repo: string): { owner: string; name: string } {
  if (!GITHUB_REPO_RE.test(repo)) throw new Error("invalid repository");
  const [owner, name] = repo.split("/");
  return { owner, name };
}

const seg = (s: string) => encodeURIComponent(s);

/** A repository path the bot may name: relative, no "..", no empty or dot segments. */
export function safeRepoPath(p: unknown): string {
  const s = String(p ?? "").trim().replace(/^\/+/, "");
  if (s.length > 400) throw new Error("path too long");
  if (s === "") return "";
  const parts = s.split("/");
  if (parts.some((x) => x === "" || x === "." || x === ".." || /[\0\\]/.test(x))) throw new Error(`invalid path: ${s.slice(0, 100)}`);
  return parts.join("/");
}

/** Paths a bot never writes: CI workflows and the repository's automation run with its secrets. */
export function protectedRepoPath(p: string): boolean {
  const l = p.toLowerCase();
  return l === ".github" || l.startsWith(".github/") || l === ".gitmodules" || l.startsWith(".git/") || l === ".git";
}

function failure(r: { status: number; json: any }, what: string): string {
  const msg = typeof r.json?.message === "string" ? r.json.message.slice(0, 200) : `HTTP ${r.status}`;
  if (r.status === 401) return `GitHub refused the bot's token (${msg}). Update the token in the bot's settings.`;
  if (r.status === 403 || r.status === 404) return `GitHub said ${r.status} for ${what}: ${msg}. The token may not have access to it.`;
  return `GitHub couldn't ${what}: ${msg}`;
}

const posInt = (v: unknown): number => {
  const x = Number(v);
  if (!Number.isInteger(x) || x <= 0 || x > 1e9) throw new Error("a positive number is needed");
  return x;
};

export const GITHUB_TOOL_NAMES = [
  "github_read_file",
  "github_list_files",
  "github_list_pull_requests",
  "github_read_pull_request",
  "github_list_issues",
  "github_read_issue",
  "github_comment",
  "github_open_pull_request",
] as const;
export type GithubToolName = (typeof GITHUB_TOOL_NAMES)[number];
export const isGithubTool = (t: string): t is GithubToolName => (GITHUB_TOOL_NAMES as readonly string[]).includes(t);
export const GITHUB_WRITE_TOOLS: ReadonlySet<string> = new Set(["github_comment", "github_open_pull_request"]);

const fn = (name: string, description: string, properties: Record<string, { type: string; description: string }>, required: string[]): ToolSchema => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export function githubToolSchemas(repo: string): ToolSchema[] {
  return [
    fn("github_read_file", `Read a file from ${repo}.`, { path: { type: "string", description: "Path in the repository" }, ref: { type: "string", description: "Branch, tag or commit (default: the default branch)" } }, ["path"]),
    fn("github_list_files", `List a directory of ${repo}.`, { path: { type: "string", description: "Directory path ('' for the root)" }, ref: { type: "string", description: "Branch, tag or commit" } }, []),
    fn("github_list_pull_requests", `List pull requests in ${repo}.`, { state: { type: "string", description: "open (default), closed or all" } }, []),
    fn("github_read_pull_request", `Read one pull request in ${repo}, with its changed files.`, { number: { type: "number", description: "PR number" } }, ["number"]),
    fn("github_list_issues", `List issues in ${repo}.`, { state: { type: "string", description: "open (default), closed or all" }, labels: { type: "string", description: "Comma-separated labels" } }, []),
    fn("github_read_issue", `Read one issue in ${repo}, with its latest comments.`, { number: { type: "number", description: "Issue number" } }, ["number"]),
    fn("github_comment", `Comment on an issue or pull request in ${repo}.`, { number: { type: "number", description: "Issue or PR number" }, body: { type: "string", description: "Markdown comment" } }, ["number", "body"]),
    fn(
      "github_open_pull_request",
      `Open a pull request in ${repo} with small file edits on a new branch (${BRANCH_PREFIX}…). At most ${MAX_EDIT_FILES} files; each file's full new content. Never touches .github/.`,
      {
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR description" },
        branch: { type: "string", description: `New branch name (prefixed with ${BRANCH_PREFIX})` },
        files: { type: "array", description: "[{path, content}] the full new content of each file" },
      },
      ["title", "branch", "files"],
    ),
  ];
}

/** What the bot's GitHub tools can do; one per run, on the bot's configured repository. */
export class GithubTools {
  private readonly base: string;
  private defaultBranch: string | null = null;
  /** PRs and comments made this run (for the run's summary). */
  readonly made: Array<{ url: string; number?: number; title?: string }> = [];

  constructor(private readonly http: GithubHttp, readonly repo: string) {
    const { owner, name } = splitRepo(repo);
    this.base = `/repos/${seg(owner)}/${seg(name)}`;
  }

  private async branchOfDefault(): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    const r = await this.http("GET", this.base);
    if (r.status !== 200) throw new Error(failure(r, `read ${this.repo}`));
    this.defaultBranch = String(r.json?.default_branch || "main");
    return this.defaultBranch;
  }

  async run(tool: GithubToolName, args: Record<string, unknown>): Promise<{ result?: string; error?: string }> {
    try {
      return { result: await this.dispatch(tool, args) };
    } catch (err) {
      return { error: (err as Error).message.slice(0, 400) };
    }
  }

  private wrap(meta: Record<string, string>, body: string): string {
    return wrapUntrusted({ tool: "github", repo: this.repo, ...meta }, body);
  }

  private async dispatch(tool: GithubToolName, a: Record<string, unknown>): Promise<string> {
    const ref = typeof a.ref === "string" && a.ref.trim() ? `?ref=${seg(a.ref.trim().slice(0, 200))}` : "";
    switch (tool) {
      case "github_read_file": {
        const path = safeRepoPath(a.path);
        if (!path) throw new Error("github_read_file needs a path.");
        const r = await this.http("GET", `${this.base}/contents/${path.split("/").map(seg).join("/")}${ref}`);
        if (r.status !== 200) throw new Error(failure(r, `read ${path}`));
        if (Array.isArray(r.json)) throw new Error(`${path} is a directory; use github_list_files.`);
        if (r.json?.encoding !== "base64" || typeof r.json?.content !== "string") throw new Error(`${path} can't be read as text (${r.json?.type ?? "unknown"}).`);
        let text = Buffer.from(r.json.content, "base64").toString("utf8");
        const cut = text.length > MAX_FILE_CHARS;
        if (cut) text = text.slice(0, MAX_FILE_CHARS);
        return this.wrap({ path }, `${text}${cut ? "\n…(truncated)" : ""}`);
      }
      case "github_list_files": {
        const path = safeRepoPath(a.path ?? "");
        const r = await this.http("GET", `${this.base}/contents/${path.split("/").map(seg).join("/")}${ref}`);
        if (r.status !== 200) throw new Error(failure(r, `list ${path || "/"}`));
        const list = Array.isArray(r.json) ? r.json : [r.json];
        return this.wrap({ path: path || "/" }, list.slice(0, 300).map((e: any) => `${e.type === "dir" ? "dir " : "file"} ${e.path}`).join("\n") || "(empty)");
      }
      case "github_list_pull_requests": {
        const state = ["open", "closed", "all"].includes(String(a.state)) ? String(a.state) : "open";
        const r = await this.http("GET", `${this.base}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`);
        if (r.status !== 200) throw new Error(failure(r, "list pull requests"));
        return this.wrap({ list: "pull_requests" }, (r.json as any[]).map((p) => `#${p.number} ${p.title} (${p.state}${p.draft ? ", draft" : ""}, by ${p.user?.login ?? "?"}, ${p.head?.ref} -> ${p.base?.ref})`).join("\n") || "(none)");
      }
      case "github_read_pull_request": {
        const num = posInt(a.number);
        const r = await this.http("GET", `${this.base}/pulls/${num}`);
        if (r.status !== 200) throw new Error(failure(r, `read PR #${num}`));
        const files = await this.http("GET", `${this.base}/pulls/${num}/files?per_page=50`);
        const p = r.json;
        const list = files.status === 200 ? (files.json as any[]).map((f) => `${f.status} ${f.filename} (+${f.additions} -${f.deletions})${f.patch ? `\n${String(f.patch).slice(0, 3_000)}` : ""}`).join("\n\n") : "(files unavailable)";
        return this.wrap({ pull_request: String(num) }, `#${p.number} ${p.title}\nState: ${p.state}${p.merged ? " (merged)" : ""} · by ${p.user?.login ?? "?"} · ${p.head?.ref} -> ${p.base?.ref}\nURL: ${p.html_url}\n\n${String(p.body ?? "").slice(0, 8_000)}\n\nChanged files:\n${list}`.slice(0, MAX_FILE_CHARS));
      }
      case "github_list_issues": {
        const state = ["open", "closed", "all"].includes(String(a.state)) ? String(a.state) : "open";
        const labels = typeof a.labels === "string" && a.labels.trim() ? `&labels=${seg(a.labels.trim().slice(0, 200))}` : "";
        const r = await this.http("GET", `${this.base}/issues?state=${state}&per_page=30&sort=updated${labels}`);
        if (r.status !== 200) throw new Error(failure(r, "list issues"));
        return this.wrap({ list: "issues" }, (r.json as any[]).filter((i) => !i.pull_request).map((i) => `#${i.number} ${i.title} (${i.state}; labels: ${(i.labels ?? []).map((l: any) => l.name).join(", ") || "none"})`).join("\n") || "(none)");
      }
      case "github_read_issue": {
        const num = posInt(a.number);
        const r = await this.http("GET", `${this.base}/issues/${num}`);
        if (r.status !== 200) throw new Error(failure(r, `read issue #${num}`));
        const c = await this.http("GET", `${this.base}/issues/${num}/comments?per_page=20`);
        const i = r.json;
        const comments = c.status === 200 ? (c.json as any[]).map((x) => `--- ${x.user?.login ?? "?"}:\n${String(x.body ?? "").slice(0, 3_000)}`).join("\n") : "";
        return this.wrap({ issue: String(num) }, `#${i.number} ${i.title}\nState: ${i.state} · by ${i.user?.login ?? "?"} · labels: ${(i.labels ?? []).map((l: any) => l.name).join(", ") || "none"}\nURL: ${i.html_url}\n\n${String(i.body ?? "").slice(0, 8_000)}\n\n${comments}`.slice(0, MAX_FILE_CHARS));
      }
      case "github_comment": {
        const num = posInt(a.number);
        const body = String(a.body ?? "").trim();
        if (!body) throw new Error("github_comment needs a body.");
        if (body.length > MAX_COMMENT_CHARS) throw new Error(`A comment is at most ${MAX_COMMENT_CHARS} characters.`);
        const r = await this.http("POST", `${this.base}/issues/${num}/comments`, { body });
        if (r.status !== 201) throw new Error(failure(r, `comment on #${num}`));
        this.made.push({ url: String(r.json?.html_url ?? ""), number: num, title: "comment" });
        return `Commented on #${num}: ${r.json?.html_url ?? ""}`;
      }
      case "github_open_pull_request":
        return this.openPullRequest(a);
    }
  }

  private async openPullRequest(a: Record<string, unknown>): Promise<string> {
    const title = String(a.title ?? "").trim().slice(0, 200);
    if (!title) throw new Error("github_open_pull_request needs a title.");
    let branch = String(a.branch ?? "").trim();
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes("..") || branch.endsWith(".lock") || branch.endsWith("/")) throw new Error("Use a simple branch name (letters, digits, . _ - /).");
    if (!branch.startsWith(BRANCH_PREFIX)) branch = `${BRANCH_PREFIX}${branch}`;
    const files = Array.isArray(a.files) ? a.files : [];
    if (!files.length || files.length > MAX_EDIT_FILES) throw new Error(`Give 1 to ${MAX_EDIT_FILES} files as [{path, content}].`);
    let bytes = 0;
    const edits = files.map((f: any) => {
      const path = safeRepoPath(f?.path);
      if (!path) throw new Error("Each file needs a path.");
      if (protectedRepoPath(path)) throw new Error(`${path}: bots don't change .github/ or git metadata.`);
      if (typeof f?.content !== "string") throw new Error(`${path}: content must be the file's full text.`);
      bytes += Buffer.byteLength(f.content);
      return { path, content: f.content as string };
    });
    if (bytes > MAX_EDIT_BYTES) throw new Error(`At most ${MAX_EDIT_BYTES / 1000} KB of edits per pull request.`);
    const base = await this.branchOfDefault();
    if (branch === base) throw new Error("A bot never commits to the default branch.");
    const head = await this.http("GET", `${this.base}/git/ref/heads/${base.split("/").map(seg).join("/")}`);
    if (head.status !== 200) throw new Error(failure(head, `read ${base}`));
    const created = await this.http("POST", `${this.base}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.json?.object?.sha });
    if (created.status !== 201) throw new Error(created.status === 422 ? `Branch ${branch} already exists; pick another name.` : failure(created, `create ${branch}`));
    for (const e of edits) {
      const path = e.path.split("/").map(seg).join("/");
      const cur = await this.http("GET", `${this.base}/contents/${path}?ref=${seg(branch)}`);
      const sha = cur.status === 200 && !Array.isArray(cur.json) ? cur.json?.sha : undefined;
      const put = await this.http("PUT", `${this.base}/contents/${path}`, { message: `${title} (${e.path})`, content: Buffer.from(e.content, "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) });
      if (put.status !== 200 && put.status !== 201) throw new Error(failure(put, `write ${e.path}`));
    }
    const body = `${String(a.body ?? "").slice(0, 20_000)}\n\n_Opened by an EdgeCoder cloud bot._`.trim();
    const pr = await this.http("POST", `${this.base}/pulls`, { title, head: branch, base, body });
    if (pr.status !== 201) throw new Error(failure(pr, "open the pull request"));
    this.made.push({ url: String(pr.json?.html_url ?? ""), number: Number(pr.json?.number) || undefined, title });
    return `Opened PR #${pr.json?.number}: ${pr.json?.html_url} (${branch} -> ${base}, ${edits.length} file${edits.length === 1 ? "" : "s"})`;
  }
}

// ---- Polling for triggers ----

export interface GithubEvent {
  /** Stable id for dedupe ("pr:12", "ci:123456", "issue:7:bot"). */
  id: string;
  kind: CloudTrigger["kind"];
  text: string;
}

/**
 * New events for the bot's triggers since the last poll. The first poll only records what's
 * there (no run for old events). Pull requests by the token's own account (the bot's) are skipped.
 */
export async function pollGithub(
  http: GithubHttp,
  repo: string,
  triggers: CloudTrigger[],
  state: { login?: string; sinceMs?: number; seen?: string[] },
  nowMs: number,
): Promise<{ events: GithubEvent[]; state: { login?: string; sinceMs: number; seen: string[] } }> {
  const { owner, name } = splitRepo(repo);
  const base = `/repos/${seg(owner)}/${seg(name)}`;
  const seen = new Set(state.seen ?? []);
  const first = state.sinceMs === undefined;
  const since = state.sinceMs ?? nowMs;
  let login = state.login;
  if (!login) {
    const me = await http("GET", "/user");
    if (me.status === 401) throw new Error(failure(me, "check the token"));
    if (me.status === 200 && typeof me.json?.login === "string") login = me.json.login;
  }
  const found: GithubEvent[] = [];
  const after = (iso: unknown) => typeof iso === "string" && Date.parse(iso) >= since - 60_000;
  for (const t of triggers.filter((x) => x.enabled)) {
    if (t.kind === "pr_opened") {
      const r = await http("GET", `${base}/pulls?state=open&sort=created&direction=desc&per_page=20`);
      if (r.status !== 200) throw new Error(failure(r, "list pull requests"));
      for (const p of r.json as any[]) {
        if (login && p.user?.login === login) continue;
        if (!after(p.created_at)) continue;
        found.push({ id: `pr:${p.number}`, kind: t.kind, text: `Pull request #${p.number} opened by ${p.user?.login ?? "someone"}: ${String(p.title ?? "").slice(0, 200)} (${p.html_url})` });
      }
    } else if (t.kind === "ci_failed") {
      const r = await http("GET", `${base}/actions/runs?status=failure&per_page=20`);
      if (r.status !== 200) throw new Error(failure(r, "list workflow runs"));
      for (const w of (r.json?.workflow_runs ?? []) as any[]) {
        if (!after(w.updated_at)) continue;
        found.push({ id: `ci:${w.id}`, kind: t.kind, text: `CI failed: ${String(w.name ?? "workflow").slice(0, 100)} on ${String(w.head_branch ?? "?").slice(0, 100)} (${w.html_url})` });
      }
    } else if (t.kind === "issue_labeled" && t.label) {
      const r = await http("GET", `${base}/issues?state=open&labels=${seg(t.label)}&sort=updated&direction=desc&per_page=20`);
      if (r.status !== 200) throw new Error(failure(r, "list issues"));
      for (const i of r.json as any[]) {
        if (i.pull_request) continue;
        found.push({ id: `issue:${i.number}:${t.label}`, kind: t.kind, text: `Issue #${i.number} labeled "${t.label}": ${String(i.title ?? "").slice(0, 200)} (${i.html_url})` });
      }
    }
  }
  const fresh = found.filter((e) => !seen.has(e.id));
  for (const e of found) seen.add(e.id);
  return { events: first ? [] : fresh, state: { ...(login ? { login } : {}), sinceMs: nowMs, seen: [...seen].slice(-300) } };
}

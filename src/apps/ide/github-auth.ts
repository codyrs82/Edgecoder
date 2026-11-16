// The GitHub credential and API calls behind the agent's GitHub tools (github_list_prs,
// github_list_issues, github_create_pr), for chat, the Code view, shared sessions (`edgecoder
// code`) and bots alike.
//
// One credential, found in this order:
//   1. the agent's GitHub connection (Settings → Integrations → "GitHub for the agent", an OAuth
//      token the desktop reads from the portal and hands to this server);
//   2. a token saved with the project's clone (in the origin URL, https://x-access-token:…@github.com/…);
//   3. the GitHub CLI's sign-in (`gh auth token`, "GitHub for your projects": what Clone from
//      GitHub, pull, push and publish use);
//   4. git's credential helper for github.com (`git credential fill`, read-only, e.g. the Keychain),
//      only when the project's origin is on github.com.
// A token GitHub rejects (401, or a 403/404 that another credential might not get) passes to the
// next one. Every failure is reported as what GitHub said and what the user can do about it.
// Tokens are never logged or put in an error message.

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { findGh } from "./git-setup.js";
import { gitExecEnv, hardenedGitArgs } from "./git-safe.js";

export type GitHubTokenSource = "integration" | "project" | "gh" | "git-credential";

export interface GitHubCredential {
  token: string;
  source: GitHubTokenSource;
}

/** owner/repo of the project's origin on github.com, and the origin URL without credentials. */
export interface GitHubRepo {
  owner: string;
  repo: string;
}

/** Where each credential comes from, in words, and how the user fixes it. */
export const SOURCE_LABEL: Record<GitHubTokenSource, string> = {
  integration: "the agent's GitHub connection (Settings → Integrations)",
  project: "the token saved in this project's origin URL",
  gh: "your GitHub CLI sign-in (gh)",
  "git-credential": "git's saved github.com credential",
};

const SOURCE_FIX: Record<GitHubTokenSource, { reconnect: string; scope: string }> = {
  integration: {
    reconnect: "Reconnect GitHub in Settings → Integrations → GitHub for the agent.",
    scope: "Disconnect and reconnect GitHub in Settings → Integrations → GitHub for the agent so it grants the repo scope.",
  },
  project: {
    reconnect: "Update or remove the token in this project's origin URL (git remote set-url origin https://github.com/OWNER/REPO.git).",
    scope: "Give the token in this project's origin URL the repo scope, or remove it from the URL.",
  },
  gh: {
    reconnect: "Run `gh auth login` in a terminal (or sign in under Settings → Integrations → GitHub for your projects).",
    scope: "Run `gh auth refresh -h github.com -s repo` in a terminal.",
  },
  "git-credential": {
    reconnect: "Update the github.com credential your git credential helper saved (e.g. in Keychain Access), or connect GitHub in Settings → Integrations.",
    scope: "Replace the github.com credential your git credential helper saved with a token that has the repo scope.",
  },
};

/** An error for the model and the user: what went wrong and what to do. Never carries a token. */
export class GitHubToolError extends Error {}

// --- Repository --------------------------------------------------------------------------------

/**
 * owner/repo from a github.com remote URL (https, ssh, git@), with any credentials ignored and
 * dots allowed in the name (my.repo); null for other hosts.
 */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const u = url.trim();
  const m =
    /^https?:\/\/(?:[^@/]*@)?github\.com(?::443)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  return { owner, repo };
}

/** The token in an https github.com URL's userinfo (https://x-access-token:TOKEN@github.com/…), if any. */
export function tokenFromRemoteUrl(url: string): string | null {
  const m = /^https:\/\/([^@/]+)@github\.com(?::443)?\//i.exec(url.trim());
  if (!m) return null;
  const userinfo = m[1];
  const colon = userinfo.indexOf(":");
  let secret = colon >= 0 ? userinfo.slice(colon + 1) : userinfo;
  try {
    secret = decodeURIComponent(secret);
  } catch {
    return null;
  }
  // A bare username (https://octocat@github.com/…) isn't a token.
  return /^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|[0-9a-f]{40})$/.test(secret) ? secret : null;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024, encoding: "utf-8" }, (err, stdout) => {
      done({ code: err ? ((err as { code?: unknown }).code as number) || 1 : 0, stdout: String(stdout ?? "") });
    });
    child.on("error", () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** The project's origin URL as configured (not `get-url`, which insteadOf rewrites), or null. */
export async function originUrl(root: string): Promise<string | null> {
  const r = await run("git", hardenedGitArgs(["config", "--get", "remote.origin.url"], root), { cwd: root, env: gitExecEnv(), timeoutMs: 5_000 });
  const url = r.stdout.trim();
  return r.code === 0 && url ? url : null;
}

// --- Credential sources ------------------------------------------------------------------------

export interface CredentialDeps {
  /** The agent's GitHub connection token (Settings → Integrations), when the app sent one. */
  integrationToken?: () => string | null | undefined;
  /** Why there's no integration token, for the "nothing found" message. */
  integrationMissing?: () => string;
  /** gh's path (default findGh). */
  gh?: () => string | null;
}

/** `gh auth token` for github.com: the CLI's sign-in, or null. */
async function ghToken(gh: string | null): Promise<{ token: string | null; why: string }> {
  if (!gh) return { token: null, why: "the GitHub CLI isn't installed" };
  const r = await run(gh, ["auth", "token", "--hostname", "github.com"], {
    env: gitExecEnv({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }),
    cwd: tmpdir(),
    timeoutMs: 10_000,
  });
  const token = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (r.code !== 0 || !token || /\s/.test(token)) return { token: null, why: "gh isn't signed in to github.com" };
  return { token, why: "" };
}

/**
 * The github.com password git's credential helper has saved, read with `git credential fill`
 * (never stored, never asks: no terminal prompt, no askpass). Runs outside the project so only
 * the user's own global/system helpers answer, not one the project's config names.
 */
async function gitCredentialToken(): Promise<{ token: string | null; why: string }> {
  const env = gitExecEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" });
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  const r = await run("git", hardenedGitArgs(["credential", "fill"]), { cwd: tmpdir(), env, input: "protocol=https\nhost=github.com\n\n", timeoutMs: 10_000 });
  if (r.code !== 0) return { token: null, why: "no github.com credential saved" };
  const password = /^password=(.*)$/m.exec(r.stdout)?.[1]?.trim() ?? "";
  if (!password) return { token: null, why: "no github.com credential saved" };
  return { token: password, why: "" };
}

/**
 * Each credential in order, lazily (gh and the helper only run when the ones before didn't
 * work). `tried` collects why a source had nothing, for the final message.
 */
export async function* githubCredentials(origin: string | null, deps: CredentialDeps, tried: string[]): AsyncGenerator<GitHubCredential> {
  const seen = new Set<string>();
  const offer = (token: string | null | undefined, source: GitHubTokenSource): GitHubCredential | null => {
    if (!token || seen.has(token)) return null;
    seen.add(token);
    return { token, source };
  };
  const integration = deps.integrationToken?.() ?? null;
  const a = offer(integration, "integration");
  if (a) yield a;
  else tried.push(`${SOURCE_LABEL.integration}: ${deps.integrationMissing?.() ?? "not available here"}`);

  const b = offer(origin ? tokenFromRemoteUrl(origin) : null, "project");
  if (b) yield b;

  const gh = await ghToken((deps.gh ?? findGh)());
  const c = offer(gh.token, "gh");
  if (c) yield c;
  else if (!gh.token) tried.push(`${SOURCE_LABEL.gh}: ${gh.why}`);

  if (origin && parseGitHubRemote(origin)) {
    const helper = await gitCredentialToken();
    const d = offer(helper.token, "git-credential");
    if (d) yield d;
    else if (!helper.token) tried.push(`${SOURCE_LABEL["git-credential"]}: ${helper.why}`);
  }
}

// --- API ---------------------------------------------------------------------------------------

/** api.github.com, or EDGECODER_GITHUB_API_URL (tests; never set by the model). */
export function githubApiBase(): string {
  return (process.env.EDGECODER_GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

interface ApiFailure {
  status: number;
  /** Worth trying the next credential (another one might be allowed). */
  retryable: boolean;
  message: string;
}

function header(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** GitHub's answer as one sentence for the model and the user, with the fix for this credential. */
export function describeGitHubFailure(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  source: GitHubTokenSource,
  repo: GitHubRepo,
  method: string,
): ApiFailure {
  const ghMsg = typeof (body as { message?: unknown })?.message === "string" ? String((body as { message: string }).message).slice(0, 300) : "";
  const via = SOURCE_LABEL[source];
  const fix = SOURCE_FIX[source];
  const slug = `${repo.owner}/${repo.repo}`;
  const remaining = header(headers, "x-ratelimit-remaining");
  if (status === 429 || (status === 403 && (remaining === "0" || /rate limit/i.test(ghMsg)))) {
    const reset = Number(header(headers, "x-ratelimit-reset"));
    const retryAfter = Number(header(headers, "retry-after"));
    const when = Number.isFinite(retryAfter) && retryAfter > 0
      ? `in ${Math.ceil(retryAfter / 60)} min`
      : Number.isFinite(reset) && reset > 0
        ? `at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC (in ${Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000))} min)`
        : "shortly";
    return { status, retryable: false, message: `GitHub API rate limit reached (HTTP ${status}${ghMsg ? `: ${ghMsg}` : ""}) using ${via}. It resets ${when}; try again then.` };
  }
  if (status === 401) {
    return { status, retryable: true, message: `GitHub rejected ${via} (HTTP 401${ghMsg ? `: ${ghMsg}` : ""}): the token was revoked or has expired. ${fix.reconnect}` };
  }
  if (status === 403) {
    const has = header(headers, "x-oauth-scopes");
    const needs = header(headers, "x-accepted-oauth-scopes");
    const scopes = has !== undefined
      ? ` The token has scopes: ${has.trim() || "(none)"}${needs ? `; this call needs: ${needs}` : ""}.`
      : "";
    const missingRepo = has !== undefined && !/\brepo\b/.test(has);
    const head = missingRepo
      ? `GitHub token from ${via} lacks the repo scope (HTTP 403${ghMsg ? `: ${ghMsg}` : ""}).`
      : `GitHub refused ${method === "GET" ? "access to" : "this change on"} ${slug} with ${via} (HTTP 403${ghMsg ? `: ${ghMsg}` : ""}).`;
    return { status, retryable: true, message: `${head}${scopes} ${missingRepo ? fix.scope : `If ${slug} belongs to an organization, it may need to approve EdgeCoder's access; otherwise: ${fix.scope}`}` };
  }
  if (status === 404) {
    return {
      status,
      retryable: true,
      message: `GitHub says ${slug} doesn't exist or isn't visible to ${via} (HTTP 404). Check the project's origin remote; if the repository is private, the token needs the repo scope: ${fix.scope}`,
    };
  }
  if (status === 422) {
    const errs = Array.isArray((body as { errors?: unknown })?.errors)
      ? ((body as { errors: Array<{ message?: string; field?: string; code?: string }> }).errors).map((e) => e.message ?? [e.field, e.code].filter(Boolean).join(" ")).filter(Boolean).join("; ")
      : "";
    return { status, retryable: false, message: `GitHub couldn't do that (HTTP 422: ${[ghMsg, errs].filter(Boolean).join(" — ") || "validation failed"}).` };
  }
  return { status, retryable: false, message: `GitHub API error (HTTP ${status}${ghMsg ? `: ${ghMsg}` : ""}) for ${slug}.` };
}

export interface GitHubApiOptions {
  method?: string;
  body?: unknown;
}

/**
 * Call the GitHub API for `repo` with the first credential that works. Throws GitHubToolError
 * with GitHub's real answer (and the fix) when none does. `onSource` hears which one answered.
 */
export async function githubApiCall(
  repo: GitHubRepo,
  path: string,
  options: GitHubApiOptions,
  deps: CredentialDeps,
  origin: string | null,
  onSource?: (source: GitHubTokenSource) => void,
): Promise<unknown> {
  const { request } = await import("undici");
  const tried: string[] = [];
  const failures: string[] = [];
  const method = options.method ?? "GET";
  for await (const cred of githubCredentials(origin, deps, tried)) {
    let res;
    try {
      res = await request(`${githubApiBase()}${path}`, {
        method: method as "GET",
        headers: {
          authorization: `Bearer ${cred.token}`,
          accept: "application/vnd.github+json",
          "user-agent": "EdgeCoder-IDE",
          "x-github-api-version": "2022-11-28",
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        headersTimeout: 20_000,
        bodyTimeout: 20_000,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg = (err as Error).message ?? String(err);
      throw new GitHubToolError(`Couldn't reach GitHub (${new URL(githubApiBase()).host}): ${code ? `${code} ` : ""}${msg.replace(cred.token, "***")}. Check this computer's internet connection and try again.`);
    }
    const text = await res.body.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 200) };
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      onSource?.(cred.source);
      return data;
    }
    const f = describeGitHubFailure(res.statusCode, res.headers, data, cred.source, repo, method);
    failures.push(f.message);
    if (!f.retryable) break;
  }
  if (failures.length) {
    const [first, ...rest] = failures;
    throw new GitHubToolError(rest.length ? `${first}\nAlso tried: ${rest.join("\n")}` : first);
  }
  throw new GitHubToolError(
    `No GitHub credential found for ${repo.owner}/${repo.repo}. Checked: ${tried.join("; ")}. ` +
      "Connect GitHub in Settings → Integrations (GitHub for the agent), or sign in with `gh auth login`.",
  );
}

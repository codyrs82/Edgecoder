// The agent's GitHub tools end to end against a fake GitHub API: each credential source (the
// agent's GitHub connection, a token in the origin URL, gh's sign-in, git's credential helper),
// the real error for each failure (401, 403 missing scope, 404, rate limit, unreachable), and a
// chat turn ("what open PRs do we have?") whose model calls the tool as text.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeToolRunner, runAgentLoop, type ChatFn } from "../../src/apps/ide/agent-loop.js";
import { parseGitHubRemote, tokenFromRemoteUrl } from "../../src/apps/ide/github-auth.js";
import { ToolExecutor } from "../../src/apps/ide/tool-executor.js";

// Fake tokens (not real credentials). Each one makes the fake API answer differently.
const T = {
  ok: "tok-integration-ok",
  gh: "tok-gh-ok",
  helper: "tok-helper-ok",
  project: `ghp_${"a".repeat(36)}`,
  bad: "tok-revoked",
  noScope: "tok-no-repo-scope",
  limited: "tok-rate-limited",
  hidden: "tok-cant-see",
};

let server: Server;
let base = "";
const seen: string[] = [];

const PRS = [
  { number: 12, title: "Fix the footer", state: "open", user: { login: "octo" }, html_url: "https://github.com/acme/my.repo/pull/12" },
  { number: 9, title: "Add GitHub fallback", state: "open", user: { login: "cat" }, html_url: "https://github.com/acme/my.repo/pull/9" },
];
const ISSUES = [
  { number: 3, title: "Crash on start", state: "open", user: { login: "octo" }, html_url: "https://github.com/acme/my.repo/issues/3" },
  { number: 12, title: "Fix the footer", state: "open", user: { login: "octo" }, html_url: "https://github.com/acme/my.repo/pull/12", pull_request: {} },
];

function handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  seen.push(token);
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (token === T.bad) return send(401, { message: "Bad credentials" });
  if (token === T.noScope) return send(403, { message: "Resource not accessible by integration" }, { "x-oauth-scopes": "read:user, user:email", "x-accepted-oauth-scopes": "repo" });
  if (token === T.limited) return send(403, { message: "API rate limit exceeded for user." }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) });
  if (token === T.hidden) return send(404, { message: "Not Found" });
  if (![T.ok, T.gh, T.helper, T.project].includes(token)) return send(401, { message: "Bad credentials" });
  if (req.url?.startsWith("/repos/acme/my.repo/pulls")) return send(200, PRS);
  if (req.url?.startsWith("/repos/acme/my.repo/issues")) return send(200, ISSUES);
  return send(404, { message: "Not Found" });
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["EDGECODER_GITHUB_API_URL", "EDGECODER_GH_BIN", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME", "XDG_CONFIG_HOME"];
let dir = "";
let root = "";

function git(args: string[], cwd = root) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

/** A stub `gh` that answers `gh auth token` with `token` (or fails when null). */
function ghStub(token: string | null): string {
  const p = join(dir, `gh-${token ?? "none"}`);
  writeFileSync(p, token ? `#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo ${token} && exit 0\nexit 1\n` : "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
  chmodSync(p, 0o755);
  return p;
}

/** git's global config with a credential helper answering github.com with `token`. */
function credentialHelper(token: string | null) {
  writeFileSync(process.env.GIT_CONFIG_GLOBAL!, token ? `[credential]\n\thelper = "!f() { test \\"$1\\" = get && echo username=x-access-token && echo password=${token}; }; f"\n` : "");
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "ec-gh-tools-"));
  root = join(dir, "repo");
  execFileSync("mkdir", ["-p", root]);
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = join(dir, ".config");
  process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
  process.env.EDGECODER_GITHUB_API_URL = base;
  process.env.EDGECODER_GH_BIN = join(dir, "no-gh-here");
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/acme/my.repo.git"]);
  seen.length = 0;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const listPrs = (ex: ToolExecutor) => ex.execute("github_list_prs", {});
const noTokenIn = (s: string | undefined) => {
  for (const t of Object.values(T)) expect(s ?? "").not.toContain(t);
};

describe("remote parsing", () => {
  it("reads owner/repo from https, ssh and credentialed URLs (dots allowed)", () => {
    expect(parseGitHubRemote("https://github.com/acme/my.repo.git")).toEqual({ owner: "acme", repo: "my.repo" });
    expect(parseGitHubRemote("git@github.com:codyrs82/Edgecoder.git")).toEqual({ owner: "codyrs82", repo: "Edgecoder" });
    expect(parseGitHubRemote("ssh://git@github.com/codyrs82/Edgecoder")).toEqual({ owner: "codyrs82", repo: "Edgecoder" });
    expect(parseGitHubRemote(`https://x-access-token:${T.project}@github.com/acme/my.repo.git`)).toEqual({ owner: "acme", repo: "my.repo" });
    expect(parseGitHubRemote("https://gitlab.com/acme/x.git")).toBeNull();
    expect(tokenFromRemoteUrl(`https://x-access-token:${T.project}@github.com/acme/my.repo.git`)).toBe(T.project);
    expect(tokenFromRemoteUrl("https://octocat@github.com/acme/my.repo.git")).toBeNull();
  });
});

describe("credential sources", () => {
  it("the agent's GitHub connection (Integrations) comes first", async () => {
    const r = await listPrs(new ToolExecutor(root, T.ok, undefined, { github: { integrationToken: () => T.gh } }));
    expect(r.error).toBeUndefined();
    expect(r.result).toContain("#12 [open] Fix the footer (by @octo)");
    expect(seen).toEqual([T.ok]);
  });

  it("the connection the server holds, when the request carried none (sessions, bots)", async () => {
    const r = await listPrs(new ToolExecutor(root, undefined, undefined, { github: { integrationToken: () => T.ok } }));
    expect(r.result).toContain("#9 [open] Add GitHub fallback");
    expect(seen).toEqual([T.ok]);
  });

  it("a token saved in the project's origin URL", async () => {
    git(["remote", "set-url", "origin", `https://x-access-token:${T.project}@github.com/acme/my.repo.git`]);
    const r = await listPrs(new ToolExecutor(root));
    expect(r.result).toContain("#12");
    expect(r.result).toContain("token saved in this project's origin URL");
    expect(seen).toEqual([T.project]);
  });

  it("gh's sign-in (gh auth token) when there's no agent connection", async () => {
    process.env.EDGECODER_GH_BIN = ghStub(T.gh);
    const r = await listPrs(new ToolExecutor(root));
    expect(r.result).toContain("#12 [open] Fix the footer");
    expect(r.result).toContain("your GitHub CLI sign-in (gh)");
    expect(seen).toEqual([T.gh]);
  });

  it("git's credential helper for github.com, last", async () => {
    process.env.EDGECODER_GH_BIN = ghStub(null);
    credentialHelper(T.helper);
    const r = await new ToolExecutor(root).execute("github_list_issues", {});
    expect(r.error).toBeUndefined();
    expect(r.result).toContain("#3 [open] Crash on start");
    expect(r.result).not.toContain("Fix the footer"); // PRs aren't issues
    expect(seen).toEqual([T.helper]);
  });

  it("never asks the credential helper for a project whose origin isn't github.com", async () => {
    git(["remote", "set-url", "origin", "https://gitlab.com/acme/my.repo.git"]);
    credentialHelper(T.helper);
    const r = await listPrs(new ToolExecutor(root));
    expect(r.error).toMatch(/isn't a github\.com repository/);
    expect(seen).toEqual([]);
  });

  it("a revoked agent connection (401) falls back to gh's sign-in", async () => {
    process.env.EDGECODER_GH_BIN = ghStub(T.gh);
    const r = await listPrs(new ToolExecutor(root, T.bad));
    expect(r.result).toContain("#12");
    expect(seen).toEqual([T.bad, T.gh]);
  });

  it("says exactly what's missing when there's no credential at all", async () => {
    process.env.EDGECODER_GH_BIN = ghStub(null);
    const r = await listPrs(new ToolExecutor(root, undefined, undefined, { github: { integrationToken: () => null, integrationMissing: () => "not connected" } }));
    expect(r.error).toMatch(/No GitHub credential found for acme\/my\.repo/);
    expect(r.error).toContain("the agent's GitHub connection (Settings → Integrations): not connected");
    expect(r.error).toContain("gh isn't signed in to github.com");
    expect(r.error).toContain("no github.com credential saved");
    expect(r.error).toMatch(/gh auth login/);
  });
});

describe("real errors", () => {
  it("401: the token was revoked, reconnect", async () => {
    const r = await listPrs(new ToolExecutor(root, T.bad));
    expect(r.result).toBeUndefined();
    expect(r.error).toMatch(/GitHub rejected the agent's GitHub connection .*HTTP 401: Bad credentials/);
    expect(r.error).toMatch(/Reconnect GitHub in Settings → Integrations/);
    noTokenIn(r.error);
  });

  it("403: names the missing repo scope and how to grant it", async () => {
    process.env.EDGECODER_GH_BIN = ghStub(T.noScope);
    const r = await listPrs(new ToolExecutor(root));
    expect(r.error).toMatch(/lacks the repo scope \(HTTP 403/);
    expect(r.error).toContain("The token has scopes: read:user, user:email; this call needs: repo.");
    expect(r.error).toContain("gh auth refresh -h github.com -s repo");
    noTokenIn(r.error);
  });

  it("404: the repository isn't there or isn't visible", async () => {
    const r = await listPrs(new ToolExecutor(root, T.hidden));
    expect(r.error).toMatch(/acme\/my\.repo doesn't exist or isn't visible to the agent's GitHub connection .*HTTP 404/);
  });

  it("rate limit: says when it resets and doesn't hammer other credentials", async () => {
    process.env.EDGECODER_GH_BIN = ghStub(T.gh);
    const r = await listPrs(new ToolExecutor(root, T.limited));
    expect(r.error).toMatch(/rate limit reached .*resets at \d\d:\d\d UTC \(in 1\d min\)/);
    expect(seen).toEqual([T.limited]);
  });

  it("unreachable: a network error, not 'not connected'", async () => {
    process.env.EDGECODER_GITHUB_API_URL = "http://127.0.0.1:9";
    const r = await listPrs(new ToolExecutor(root, T.ok));
    expect(r.error).toMatch(/Couldn't reach GitHub \(127\.0\.0\.1:9\)/);
    noTokenIn(r.error);
  });
});

describe("a chat turn: what open PRs do we have?", () => {
  it("runs github_list_prs from a text tool call, marks it ok, and answers with the list", async () => {
    process.env.EDGECODER_GH_BIN = ghStub(T.gh);
    const executor = new ToolExecutor(root, undefined, undefined, { github: { integrationToken: () => null } });
    const events: Array<Record<string, unknown>> = [];
    let toolOutput = "";
    // A small local model: the tool call comes back as text, then it answers from the tool's output.
    const chat: ChatFn = async ({ messages }, onDelta) => {
      const last = messages[messages.length - 1];
      if (last.role === "user" && /open PRs/.test(String(last.content))) {
        return { content: '```tool_call\n{"tool":"github_list_prs","args":{"state":"open"}}\n```', toolCalls: [] };
      }
      toolOutput = String(last.content);
      const answer = `Open pull requests:\n${toolOutput.split("\n").filter((l) => /^#\d+ /.test(l)).map((l) => `- ${l}`).join("\n")}`;
      onDelta?.(answer);
      return { content: answer, toolCalls: [] };
    };
    let reply = "";
    await runAgentLoop({
      chat,
      systemPrompt: () => "",
      messages: [{ role: "user", content: "what open PRs do we have?" }],
      sendEvent: (e) => {
        events.push(e as Record<string, unknown>);
        if (e.type === "text") reply += String((e as { content?: unknown }).content ?? "");
      },
      isCancelled: () => false,
      runTool: makeToolRunner({
        execute: (tool, args, opts) => executor.execute(tool, args, opts),
        sendEvent: (e) => events.push(e as Record<string, unknown>),
        waitForApproval: async () => true,
        captureBeforeWrite: () => null,
        turnId: "t1",
      }),
    });
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.error).toBeUndefined();
    expect(String(result?.result)).toContain("#12 [open] Fix the footer");
    expect(reply).toContain("Open pull requests:");
    expect(reply).toContain("#12 [open] Fix the footer (by @octo)");
    expect(reply).toContain("#9 [open] Add GitHub fallback (by @cat)");
  });

  it("a failing call reaches the model as the real error and the step as failed", async () => {
    const executor = new ToolExecutor(root, T.noScope);
    const events: Array<Record<string, unknown>> = [];
    let sawError = "";
    const chat: ChatFn = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last.role === "user" && /connected/.test(String(last.content))) {
        return { content: '```tool_call\n{"tool":"github_list_prs","args":{}}\n```', toolCalls: [] };
      }
      sawError = messages.map((m) => String(m.content)).find((c) => c.includes("[Error]")) ?? "";
      return { content: "GitHub says the token lacks the repo scope.", toolCalls: [] };
    };
    await runAgentLoop({
      chat,
      systemPrompt: () => "",
      messages: [{ role: "user", content: "yes it is connected" }],
      sendEvent: () => {},
      isCancelled: () => false,
      runTool: makeToolRunner({
        execute: (tool, args, opts) => executor.execute(tool, args, opts),
        sendEvent: (e) => events.push(e as Record<string, unknown>),
        waitForApproval: async () => true,
        captureBeforeWrite: () => null,
        turnId: "t2",
      }),
    });
    const result = events.find((e) => e.type === "tool_result");
    expect(String(result?.error)).toMatch(/lacks the repo scope/);
    expect(sawError).toMatch(/\[Error\]: GitHub token from the agent's GitHub connection .* lacks the repo scope/);
    expect(sawError).not.toMatch(/not connected/i);
    noTokenIn(sawError);
  });
});

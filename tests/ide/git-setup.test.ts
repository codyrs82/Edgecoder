import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitError, GitOps } from "../../src/apps/ide/git-ops.js";
import { GitSetupError, cloneRepo, githubStatus, normalizeRemoteUrl, repoNameFromUrl } from "../../src/apps/ide/git-setup.js";

const TOKEN = "git-setup-test-token";
process.env.IDE_PROVIDER_TOKEN = TOKEN;
delete process.env.IDE_PROVIDER_HOST;
delete process.env.MESH_AUTH_TOKEN;
const { ideProviderServer: app } = await import("../../src/apps/ide/provider-server.js");
const headers = { host: "127.0.0.1:4304", authorization: `Bearer ${TOKEN}` };

let tmp: string;
let root: string;
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
function identity(dir: string) {
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
}
function bareRemote(): string {
  const bare = join(tmp, "remote.git");
  git(tmp, "init", "-q", "--bare", bare);
  return bare;
}

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gitsetup-"));
  root = join(tmp, "project");
  mkdirSync(root);
  writeFileSync(join(root, "a.txt"), "one\n");
});
afterEach(() => {
  delete process.env.EDGECODER_GH_BIN;
  rmSync(tmp, { recursive: true, force: true });
});

describe("remote URL validation", () => {
  it("accepts https, git@ and GitHub owner/repo shorthand", () => {
    expect(normalizeRemoteUrl("https://github.com/acme/widgets.git")).toBe("https://github.com/acme/widgets.git");
    expect(normalizeRemoteUrl(" acme/widgets ")).toBe("https://github.com/acme/widgets.git");
    expect(normalizeRemoteUrl("acme/widgets.git")).toBe("https://github.com/acme/widgets.git");
    expect(normalizeRemoteUrl("git@github.com:acme/widgets.git")).toBe("git@github.com:acme/widgets.git");
    expect(normalizeRemoteUrl("ssh://git@gitlab.com/acme/widgets.git")).toBe("ssh://git@gitlab.com/acme/widgets.git");
  });

  it.each([
    "file:///etc/passwd",
    "ext::sh -c touch% /tmp/pwned",
    "--upload-pack=touch /tmp/pwned",
    "-u/x",
    "/Users/me/secret-repo",
    "../other",
    "http://example.com/repo.git",
    "https://user:token@github.com/acme/widgets.git",
    "git@-oProxyCommand=x:acme/w",
    "git@github.com:../../etc",
    "https://github.com/acme/w\n--foo",
    "",
  ])("rejects %j", (u) => {
    expect(() => normalizeRemoteUrl(u)).toThrow(GitSetupError);
  });

  it("names the clone folder after the repository", () => {
    expect(repoNameFromUrl("https://github.com/acme/widgets.git")).toBe("widgets");
    expect(repoNameFromUrl("git@github.com:acme/gadgets")).toBe("gadgets");
  });
});

describe("GitOps setup", () => {
  it("initializes on main, not master", async () => {
    const g = new GitOps(root);
    expect(await g.state()).toBeNull();
    await g.init();
    const st = (await g.state())!;
    expect(st.branch).toBe("main");
    expect(st.hasCommits).toBe(false);
    expect(st.remotes).toEqual([]);
    await expect(g.init()).rejects.toBeInstanceOf(GitError);
  });

  it("adds a remote and publishes a branch with no upstream using -u", async () => {
    const g = new GitOps(root);
    await g.init();
    identity(root);
    await g.commit("first", { all: true });
    await expect(g.push()).rejects.toThrow(/no remote/);
    const bare = bareRemote();
    await g.addRemote("origin", bare);
    await expect(g.addRemote("origin", bare)).rejects.toThrow(/already exists/);
    await expect(g.addRemote("-x", bare)).rejects.toBeInstanceOf(GitError);
    expect((await g.state())!.upstream).toBeNull();
    expect(await g.push()).toMatch(/Published main|main/);
    const st = (await g.state())!;
    expect(st.upstream).toBe("origin/main");
    expect(st.remotes).toEqual(["origin"]);
    expect(git(tmp, "--git-dir", bare, "log", "--format=%s", "main").trim()).toBe("first");
  });

  it("clones into a new folder under an absolute parent", async () => {
    const src = join(tmp, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    identity(src);
    writeFileSync(join(src, "r.md"), "hi\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "c");
    const dest = await cloneRepo(src, tmp, "copy");
    expect(dest).toBe(join(tmp, "copy"));
    expect(existsSync(join(dest, "r.md"))).toBe(true);
    await expect(cloneRepo(src, tmp, "copy")).rejects.toThrow(/already exists/);
    await expect(cloneRepo(src, "relative/dir")).rejects.toBeInstanceOf(GitSetupError);
  });
});

// A stand-in gh: `auth status` reports a login; `repo create` adds the bare repo as origin.
describe.skipIf(process.platform === "win32")("publish to GitHub through gh", () => {
  function fakeGh(bare: string, loggedIn = true) {
    const bin = join(tmp, "gh");
    writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then
  ${loggedIn ? 'echo "github.com"; echo "  ✓ Logged in to github.com account octo (keyring)"; exit 0' : 'echo "You are not logged into any GitHub hosts." >&2; exit 1'}
fi
if [ "$1" = repo ] && [ "$2" = create ]; then
  echo "$@" > "${join(tmp, "gh-args")}"
  git remote add origin "${bare}" || exit 1
  echo "https://github.com/octo/$3"
  exit 0
fi
exit 2
`,
    );
    chmodSync(bin, 0o755);
    process.env.EDGECODER_GH_BIN = bin;
  }

  it("reports whether gh is installed and signed in", async () => {
    process.env.EDGECODER_GH_BIN = join(tmp, "missing-gh");
    expect(await githubStatus()).toEqual({ ghInstalled: false, loggedIn: false, login: null });
    fakeGh(bareRemote(), false);
    expect(await githubStatus()).toEqual({ ghInstalled: true, loggedIn: false, login: null });
    fakeGh(join(tmp, "remote.git"), true);
    expect(await githubStatus()).toEqual({ ghInstalled: true, loggedIn: true, login: "octo" });
  });

  it("publishes a folder that isn't a repository yet: init, first commit, create, push -u", async () => {
    const bare = bareRemote();
    fakeGh(bare);
    // identity for the initial commit, without touching the user's global config
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t";
    try {
      const g = new GitOps(root);
      const r = await g.publishGitHub("widgets", "private");
      expect(r.url).toBe("https://github.com/octo/widgets");
      const st = (await g.state())!;
      expect(st.upstream).toBe("origin/main");
      expect(git(tmp, "--git-dir", bare, "ls-tree", "--name-only", "main").trim()).toBe("a.txt");
      expect(execFileSync("cat", [join(tmp, "gh-args")], { encoding: "utf8" }).trim()).toBe("repo create widgets --private --source . --remote origin");
      await expect(g.publishGitHub("again", "public")).rejects.toThrow(/already has an origin/);
      await expect(g.publishGitHub("bad name", "public")).rejects.toBeInstanceOf(GitError);
    } finally {
      for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) delete process.env[k];
    }
  });
});

describe("git setup routes", () => {
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers, payload: payload as object });

  it("inits the open project and rejects bad remote URLs", async () => {
    expect((await post("/v1/ide/project", { projectRoot: root })).statusCode).toBe(200);
    const init = await post("/v1/ide/git/init", {});
    expect(init.statusCode).toBe(200);
    const st = (await app.inject({ method: "GET", url: "/v1/ide/git/state", headers })).json();
    expect(st.branch).toBe("main");
    for (const url of ["file:///tmp/x", "ext::sh -c id", "--upload-pack=id", root]) {
      const r = await post("/v1/ide/git/remote", { url });
      expect(r.statusCode, url).toBe(400);
    }
    const ok = await post("/v1/ide/git/remote", { url: "acme/widgets" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().url).toBe("https://github.com/acme/widgets.git");
    // config --get is the stored URL; `remote get-url` can be rewritten by url.insteadOf.
    expect(git(root, "config", "--get", "remote.origin.url").trim()).toBe("https://github.com/acme/widgets.git");
  });

  it("validates clone requests before running git", async () => {
    expect((await post("/v1/ide/git/clone", { url: "file:///etc", parentDir: tmp })).statusCode).toBe(400);
    expect((await post("/v1/ide/git/clone", { url: "acme/widgets", parentDir: "relative" })).statusCode).toBe(400);
    expect((await post("/v1/ide/git/publish", { name: "x", visibility: "secret" })).statusCode).toBe(400);
  });
});

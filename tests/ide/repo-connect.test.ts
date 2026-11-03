import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectRepoUrl,
  defaultProjectsFolder,
  ensureRepo,
  getProjectsFolder,
  pickRepoTarget,
  projectPath,
  remoteKey,
  resolveProjectsFolder,
  setProjectsFolder,
} from "../../src/apps/ide/repo-connect.js";
import { GitSetupError, repoNameFromUrl } from "../../src/apps/ide/git-setup.js";

const TOKEN = "repo-connect-test-token";
process.env.IDE_PROVIDER_TOKEN = TOKEN;
delete process.env.IDE_PROVIDER_HOST;
delete process.env.MESH_AUTH_TOKEN;
const { ideProviderServer: app } = await import("../../src/apps/ide/provider-server.js");
const headers = { host: "127.0.0.1:4304", authorization: `Bearer ${TOKEN}` };

let tmp: string;
let projects: string;
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
function identity(dir: string) {
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
}
/** A bare remote at <tmp>/<name>.git with one commit on main, and a working clone to push from. */
function remote(name: string): { bare: string; work: string; commit: (file: string, text: string) => void } {
  const bare = join(tmp, "remotes", `${name}.git`);
  mkdirSync(join(tmp, "remotes"), { recursive: true });
  git(tmp, "init", "-q", "--bare", "-b", "main", bare);
  const work = join(tmp, "work", name);
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  identity(work);
  git(work, "remote", "add", "origin", bare);
  const commit = (file: string, text: string) => {
    writeFileSync(join(work, file), text);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", `edit ${file}`);
    git(work, "push", "-q", "origin", "main");
  };
  commit("README.md", "one\n");
  return { bare, work, commit };
}

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "repoconnect-"));
  projects = join(tmp, "Projects");
  process.env.EDGECODER_IDE_SETTINGS_FILE = join(tmp, "ide-settings.json");
  delete process.env.EDGECODER_PROJECTS_DIR;
});
afterEach(() => {
  delete process.env.EDGECODER_IDE_SETTINGS_FILE;
  delete process.env.EDGECODER_PROJECTS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("projects folder", () => {
  it("defaults to ~/EdgeCoder and persists a new choice", () => {
    expect(getProjectsFolder()).toEqual({ path: join(homedir(), "EdgeCoder"), source: "default" });
    expect(defaultProjectsFolder()).toBe(join(homedir(), "EdgeCoder"));
    const saved = setProjectsFolder(join(tmp, "Code", "mine"));
    expect(saved).toBe(join(tmp, "Code", "mine"));
    expect(existsSync(saved)).toBe(true);
    expect(JSON.parse(readFileSync(join(tmp, "ide-settings.json"), "utf8")).projectsFolder).toBe(saved);
    expect(getProjectsFolder()).toEqual({ path: saved, source: "setting" });
  });

  it("resolves ~ and normalizes, and refuses relative paths, .. and the root", () => {
    expect(resolveProjectsFolder("~/EdgeCoder")).toBe(join(homedir(), "EdgeCoder"));
    expect(resolveProjectsFolder(`${tmp}//a/./b/`)).toBe(join(tmp, "a", "b"));
    for (const bad of ["EdgeCoder", "./x", "../x", `${tmp}/../etc`, "~/../../etc", "~/a/..", "/", "", "  ", `${tmp}/a\nb`]) {
      expect(() => resolveProjectsFolder(bad), JSON.stringify(bad)).toThrow(GitSetupError);
    }
  });

  it("falls back to the default when the saved value is bad", () => {
    writeFileSync(join(tmp, "ide-settings.json"), JSON.stringify({ projectsFolder: "../escape" }));
    expect(getProjectsFolder().source).toBe("default");
  });

  it("keeps repo folders inside the projects folder", () => {
    expect(projectPath(projects, "widgets")).toBe(join(projects, "widgets"));
    for (const bad of ["..", ".", "a/b", "../x", "-rf", "a\\b", ""]) expect(() => projectPath(projects, bad), bad).toThrow(GitSetupError);
  });
});

describe("remote keys", () => {
  it("treats https, scp-like and ssh:// URLs of one repo as the same remote", () => {
    const k = remoteKey("https://github.com/Acme/Widgets.git");
    expect(remoteKey("git@github.com:acme/widgets")).toBe(k);
    expect(remoteKey("ssh://git@github.com/acme/widgets.git/")).toBe(k);
    expect(remoteKey("https://github.com/acme/gadgets.git")).not.toBe(k);
    expect(remoteKey("https://gitlab.com/acme/widgets.git")).not.toBe(k);
  });

  it("names the folder from URLs and from local paths on any OS", () => {
    expect(repoNameFromUrl("https://github.com/acme/widgets.git")).toBe("widgets");
    expect(repoNameFromUrl("git@github.com:acme/widgets")).toBe("widgets");
    expect(repoNameFromUrl("/tmp/remotes/widgets.git")).toBe("widgets");
    expect(repoNameFromUrl("C:\\Users\\me\\remotes\\widgets.git")).toBe("widgets");
  });
});

describe("name collisions", () => {
  it("adds -2, -3 when other remotes or plain folders hold the name", async () => {
    mkdirSync(projects, { recursive: true });
    const url = "https://github.com/acme/widgets.git";
    expect(await pickRepoTarget(projects, "widgets", url)).toEqual({ path: join(projects, "widgets"), exists: false });
    mkdirSync(join(projects, "widgets"));
    expect(await pickRepoTarget(projects, "widgets", url)).toEqual({ path: join(projects, "widgets-2"), exists: false });
    mkdirSync(join(projects, "widgets-2"));
    git(join(projects, "widgets-2"), "init", "-q");
    git(join(projects, "widgets-2"), "remote", "add", "origin", "https://github.com/other/widgets.git");
    writeFileSync(join(projects, "widgets-3"), "a file");
    expect((await pickRepoTarget(projects, "widgets", url)).path).toBe(join(projects, "widgets-4"));
    // a symlink is never followed into
    symlinkSync(tmp, join(projects, "widgets-4"));
    expect((await pickRepoTarget(projects, "widgets", url)).path).toBe(join(projects, "widgets-5"));
  });

  it("finds the existing checkout of the same repo, whatever URL form it was cloned with", async () => {
    mkdirSync(join(projects, "widgets"), { recursive: true });
    git(join(projects, "widgets"), "init", "-q");
    git(join(projects, "widgets"), "remote", "add", "origin", "git@github.com:acme/widgets.git");
    expect(await pickRepoTarget(projects, "widgets", "https://github.com/acme/widgets.git")).toEqual({ path: join(projects, "widgets"), exists: true });
  });
});

describe("connecting a repository", () => {
  it("clones when it isn't there, creating the projects folder", async () => {
    const r = remote("widgets");
    const lines: string[] = [];
    const c = await connectRepoUrl(r.bare, { projectsFolder: projects, onProgress: (l) => lines.push(l) });
    expect(c).toMatchObject({ path: join(projects, "widgets"), name: "widgets", action: "cloned", branch: "main", dirty: false });
    expect(readFileSync(join(projects, "widgets", "README.md"), "utf8")).toBe("one\n");
    expect(lines[0]).toContain("Cloning into");
  });

  it("fast-forwards a clean copy", async () => {
    const r = remote("widgets");
    await connectRepoUrl(r.bare, { projectsFolder: projects });
    r.commit("README.md", "two\n");
    const c = await connectRepoUrl(r.bare, { projectsFolder: projects });
    expect(c).toMatchObject({ action: "updated", branch: "main", dirty: false, fastForwarded: true, behind: 0, ahead: 0 });
    expect(readFileSync(join(projects, "widgets", "README.md"), "utf8")).toBe("two\n");
  });

  it("leaves a dirty copy alone and reports it and how far behind it is", async () => {
    const r = remote("widgets");
    await connectRepoUrl(r.bare, { projectsFolder: projects });
    const local = join(projects, "widgets");
    writeFileSync(join(local, "notes.txt"), "mine\n");
    writeFileSync(join(local, "README.md"), "local edit\n");
    const headBefore = git(local, "rev-parse", "HEAD");
    r.commit("other.txt", "upstream\n");
    const c = await connectRepoUrl(r.bare, { projectsFolder: projects });
    expect(c).toMatchObject({ action: "updated", dirty: true, fastForwarded: false, behind: 1 });
    expect(c.message).toMatch(/local changes/);
    expect(git(local, "rev-parse", "HEAD")).toBe(headBefore);
    expect(readFileSync(join(local, "README.md"), "utf8")).toBe("local edit\n");
    expect(readFileSync(join(local, "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(local, "other.txt"))).toBe(false);
  });

  it("clones next to a same-named folder that has a different origin", async () => {
    const a = remote("widgets");
    await connectRepoUrl(a.bare, { projectsFolder: projects });
    // another remote also named widgets
    const otherBare = join(tmp, "elsewhere", "widgets.git");
    mkdirSync(join(tmp, "elsewhere"));
    git(tmp, "clone", "-q", "--bare", a.bare, otherBare);
    const c = await connectRepoUrl(otherBare, { projectsFolder: projects });
    expect(c).toMatchObject({ path: join(projects, "widgets-2"), action: "cloned" });
    // and connecting the first again still finds the first
    expect((await connectRepoUrl(a.bare, { projectsFolder: projects })).path).toBe(join(projects, "widgets"));
  });

  it("ensureRepo validates what it's given before touching git", async () => {
    for (const bad of ["file:///etc", "/tmp/x", "--upload-pack=touch /tmp/p", "ext::sh -c id", "https://u:p@github.com/a/b"]) {
      await expect(ensureRepo(bad, { projectsFolder: projects }), bad).rejects.toThrow(GitSetupError);
    }
    expect(existsSync(projects)).toBe(false);
  });
});

describe("routes", () => {
  it("validates the repo for /v1/ide/repos/connect", async () => {
    for (const payload of [{}, { repo: "" }, { repo: "file:///etc/passwd" }, { repo: "--upload-pack=x" }, { repo: "ext::sh" }, { repo: 5 }]) {
      const res = await app.inject({ method: "POST", url: "/v1/ide/repos/connect", headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("reads and saves the projects folder, refusing escapes", async () => {
    const get = await app.inject({ method: "GET", url: "/v1/ide/settings/projects-folder", headers });
    expect(get.json()).toMatchObject({ path: join(homedir(), "EdgeCoder"), source: "default" });
    for (const path of ["relative/dir", "../up", `${tmp}/../x`]) {
      const res = await app.inject({ method: "POST", url: "/v1/ide/settings/projects-folder", headers, payload: { path } });
      expect(res.statusCode, path).toBe(400);
    }
    const ok = await app.inject({ method: "POST", url: "/v1/ide/settings/projects-folder", headers, payload: { path: projects } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().path).toBe(projects);
    expect(existsSync(projects)).toBe(true);
  });
});

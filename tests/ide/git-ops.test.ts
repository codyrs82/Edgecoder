import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, GitOps } from "../../src/apps/ide/git-ops.js";

let root: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gitops-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  // Windows runners default to core.autocrlf=true, which rewrites "one\n" as "one\r\n" on restore.
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "b.txt"), "bee\n");
  git("add", ".");
  git("commit", "-qm", "init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("GitOps", () => {
  it("splits staged and unstaged changes and lists branches", async () => {
    const g = new GitOps(root);
    writeFileSync(join(root, "a.txt"), "two\n");
    writeFileSync(join(root, "new.txt"), "n\n");
    git("rm", "-q", "b.txt");
    const st = (await g.state())!;
    expect(st.branch).toBe("main");
    expect(st.staged).toEqual([{ path: "b.txt", status: "D" }]);
    expect(st.unstaged).toEqual([{ path: "a.txt", status: "M" }, { path: "new.txt", status: "U" }]);
    expect(st.branches).toEqual(["main"]);
  });

  it("stages, unstages, commits and shows HEAD content", async () => {
    const g = new GitOps(root);
    writeFileSync(join(root, "a.txt"), "two\n");
    await g.stage(["a.txt"]);
    expect((await g.state())!.staged).toEqual([{ path: "a.txt", status: "M" }]);
    await g.unstage(["a.txt"]);
    expect((await g.state())!.staged).toEqual([]);
    expect(await g.headContent("a.txt")).toBe("one\n");
    expect(await g.headContent("missing.txt")).toBeNull();
    const sha = await g.commit("change a\n\nwith body", { all: true });
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(git("log", "-1", "--format=%B").trim()).toBe("change a\n\nwith body");
    await expect(g.commit("  ")).rejects.toBeInstanceOf(GitError);
  });

  it("discards tracked edits and deletes untracked files, only inside the project", async () => {
    const g = new GitOps(root);
    writeFileSync(join(root, "a.txt"), "changed\n");
    writeFileSync(join(root, "junk.txt"), "x\n");
    await g.discard(["a.txt", "junk.txt"]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(root, "junk.txt"))).toBe(false);
    await expect(g.discard(["../outside.txt"])).rejects.toThrow(/escapes/);
  });

  it("creates and switches branches, rejecting bad names", async () => {
    const g = new GitOps(root);
    await g.checkout("feature/x", true);
    expect((await g.state())!.branch).toBe("feature/x");
    await g.checkout("main");
    expect((await g.state())!.branches.sort()).toEqual(["feature/x", "main"]);
    await expect(g.checkout("bad..name", true)).rejects.toThrow(/not a valid branch/);
  });

  it("is null outside a repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    try {
      expect(await new GitOps(plain).state()).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

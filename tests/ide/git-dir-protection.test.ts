import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolExecutor, classifyRelativePath, protectedToolPath } from "../../src/apps/ide/tool-executor.js";
import { ProjectFs } from "../../src/apps/ide/project-fs.js";
import { GitOps } from "../../src/apps/ide/git-ops.js";
import { hardenedGitArgs, hardenedGitEnv } from "../../src/apps/ide/git-safe.js";
import { makeToolRunner } from "../../src/apps/ide/agent-loop.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const posix = process.platform !== "win32";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "ec-gitdir-"));
  made.push(root);
  if (hasGit) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  } else {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "");
  }
  writeFileSync(join(root, "a.txt"), "a\n");
  return root;
}

describe("classifyRelativePath", () => {
  it("flags any .git segment, however spelled", () => {
    for (const p of [".git/config", ".GIT/config", "sub/.git/hooks/x", ".git", "./.git/hooks/pre-commit", ".git./config", ".git /config", "GIT~1/config", ".g\u200cit/config", "a\\.git\\config", ".git::$INDEX_ALLOCATION/config"]) {
      expect(classifyRelativePath(p), p).toBe("git_dir");
    }
  });
  it("needs approval for files tooling executes", () => {
    for (const p of [".gitmodules", ".gitattributes", "sub/.gitattributes", ".envrc", ".husky/pre-commit", ".vscode/tasks.json", ".pre-commit-config.yaml", "lefthook.yml"]) {
      expect(classifyRelativePath(p), p).toBe("needs_approval");
    }
  });
  it("leaves ordinary files alone", () => {
    for (const p of ["src/index.ts", ".gitignore", ".github/workflows/ci.yml", "git/config", "my.git/x", "husky.txt"]) {
      expect(classifyRelativePath(p), p).toBeNull();
    }
  });
});

describe("agent writes into .git are refused", () => {
  it("write_file and edit_file on .git paths, even when approved", async () => {
    const root = repo();
    const exec = new ToolExecutor(root);
    const before = readFileSync(join(root, ".git", "config"), "utf8");
    for (const path of [".git/config", ".GIT/config", "sub/.git/hooks/x", ".git/hooks/pre-commit"]) {
      const r = await exec.execute("write_file", { path, content: "[core]\n\tfsmonitor = touch pwned\n" }, { approved: true });
      expect(r.error, path).toMatch(/git directory/);
    }
    const e = await exec.execute("edit_file", { path: ".git/config", old_string: "[core]", new_string: "[core]\n\tfsmonitor = x" }, { approved: true });
    expect(e.error).toMatch(/git directory/);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(before);
    expect(existsSync(join(root, "sub"))).toBe(false);
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it.skipIf(!posix)("through a symlink to .git (directory or leaf)", async () => {
    const root = repo();
    symlinkSync(".git", join(root, "gitlink"), "dir");
    symlinkSync(join(".git", "config"), join(root, "cfg"));
    const exec = new ToolExecutor(root);
    expect((await exec.execute("write_file", { path: "gitlink/config", content: "x" }, { approved: true })).error).toMatch(/git directory/);
    expect((await exec.execute("write_file", { path: "gitlink/hooks/post-checkout", content: "x" }, { approved: true })).error).toMatch(/git directory/);
    expect((await exec.execute("write_file", { path: "cfg", content: "x" }, { approved: true })).error).toMatch(/git directory/);
    expect(existsSync(join(root, ".git", "hooks", "post-checkout"))).toBe(false);
  });

  it("protects a .git file's gitdir target", async () => {
    const base = mkdtempSync(join(tmpdir(), "ec-gitfile-"));
    made.push(base);
    const root = join(base, "proj");
    mkdirSync(join(root, "meta"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: meta\n");
    const exec = new ToolExecutor(root);
    expect((await exec.execute("write_file", { path: "meta/config", content: "x" }, { approved: true })).error).toMatch(/git directory/);
  });

  it("needs explicit approval for .gitmodules / .gitattributes / .husky", async () => {
    const root = repo();
    const exec = new ToolExecutor(root);
    for (const path of [".gitmodules", ".gitattributes", ".husky/pre-commit"]) {
      expect((await exec.execute("write_file", { path, content: "x" }, { approved: false })).error, path).toMatch(/explicit approval/);
      expect((await exec.execute("write_file", { path, content: "x" }, { approved: true })).error, path).toBeUndefined();
    }
    expect((await exec.execute("write_file", { path: "src/ok.ts", content: "x" }, { approved: false })).error).toBeUndefined();
  });

  it("auto-approved edits still ask for protected paths", async () => {
    const asked: string[] = [];
    const seen: Array<{ approved: boolean }> = [];
    const run = makeToolRunner({
      execute: async (_t, _a, opts) => {
        seen.push(opts);
        return { result: "ok" };
      },
      sendEvent: () => {},
      waitForApproval: async (_id, _tool, args) => {
        asked.push(String(args.path));
        return true;
      },
      captureBeforeWrite: () => null,
      turnId: "t",
      autoApproveEdits: true,
      allowShellAutoApprove: false,
    });
    await run("write_file", { path: "src/a.ts", content: "x" });
    await run("write_file", { path: ".gitattributes", content: "x" });
    await run("edit_file", { path: ".Git/config", old_string: "a", new_string: "b" });
    await run("run_shell", { command: "ls" });
    expect(asked).toEqual([".gitattributes", ".Git/config", "undefined"]);
    // The auto-approved edit is not reported to the executor as user-approved.
    expect(seen[0]).toEqual({ approved: false });
    expect(protectedToolPath("src/a.ts")).toBeNull();
  });
});

describe.skipIf(!hasGit || !posix)("IDE git calls ignore repository fsmonitor and hooks", () => {
  function plant(root: string): { fsmonitorMarker: string; hookMarker: string } {
    const fsmonitorMarker = join(root, "..", `${root.split("/").pop()}-fsmonitor-ran`);
    const hookMarker = join(root, "..", `${root.split("/").pop()}-hook-ran`);
    made.push(fsmonitorMarker, hookMarker);
    execFileSync("git", ["config", "core.fsmonitor", `touch '${fsmonitorMarker}'; false`], { cwd: root });
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o755 });
    for (const name of ["post-commit", "post-checkout", "commit-msg"]) writeFileSync(join(root, ".git", "hooks", name), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o755 });
    return { fsmonitorMarker, hookMarker };
  }

  it("the planted fsmonitor would run without the hardening (control)", () => {
    const root = repo();
    const { fsmonitorMarker } = plant(root);
    try {
      execFileSync("git", ["status", "--porcelain"], { cwd: root, stdio: "ignore" });
    } catch {
      // the fsmonitor command fails on purpose
    }
    expect(existsSync(fsmonitorMarker)).toBe(true);
  });

  it("ProjectFs.gitStatus, GitOps.state and git_status don't run it", async () => {
    const root = repo();
    const { fsmonitorMarker } = plant(root);
    writeFileSync(join(root, "b.txt"), "b\n");
    const st = new ProjectFs(root).gitStatus();
    expect(st?.branch).toBe("main");
    expect(st?.files["b.txt"]).toBe("U");
    expect(await new GitOps(root).state()).not.toBeNull();
    expect((await new ToolExecutor(root).execute("git_status", {})).result).toContain("b.txt");
    expect((await new ToolExecutor(root).execute("run_shell", { command: "git status --porcelain" }, { approved: true })).result).toContain("b.txt");
    expect(existsSync(fsmonitorMarker)).toBe(false);
  });

  it("commits and checkouts made by the IDE work and skip hooks", async () => {
    const root = repo();
    const { fsmonitorMarker, hookMarker } = plant(root);
    const ops = new GitOps(root);
    await ops.stage(["a.txt"]);
    const sha = await ops.commit("first");
    expect(sha).toMatch(/^[0-9a-f]+$/);
    const exec = new ToolExecutor(root);
    writeFileSync(join(root, "c.txt"), "c\n");
    expect((await exec.execute("git_commit", { message: "second", files: "c.txt" })).error).toBeUndefined();
    expect((await exec.execute("git_branch", { name: "feature", create: true })).error).toBeUndefined();
    expect((await exec.execute("git_log", { count: 5 })).result).toContain("second");
    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(fsmonitorMarker)).toBe(false);
  });

  it("an approved shell command running git inherits the hardening through the environment", () => {
    const root = repo();
    const { fsmonitorMarker } = plant(root);
    execFileSync("sh", ["-c", "git status --porcelain >/dev/null"], { cwd: root, env: hardenedGitEnv(process.env) });
    expect(existsSync(fsmonitorMarker)).toBe(false);
  });

  it("doesn't treat a non-repository project as an implicit bare repository", () => {
    const root = mkdtempSync(join(tmpdir(), "ec-bare-"));
    made.push(root);
    execFileSync("git", ["init", "-q", "--bare", root]);
    expect(() => execFileSync("git", hardenedGitArgs(["rev-parse", "--git-dir"]), { cwd: root, stdio: "pipe" })).toThrow();
  });
});

describe("hardenedGitEnv", () => {
  it("appends to existing GIT_CONFIG_COUNT entries", () => {
    const env = hardenedGitEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" });
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_KEY_1).toBe("core.fsmonitor");
    expect(Number(env.GIT_CONFIG_COUNT)).toBeGreaterThan(2);
    expect(hardenedGitArgs(["status"]).slice(-1)).toEqual(["status"]);
    expect(hardenedGitArgs(["status"])).toContain("protocol.ext.allow=never");
  });
});

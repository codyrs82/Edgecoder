import { execFileSync as realExecFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const execCalls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
      if (file === "git") execCalls.push({ args, env: opts?.env });
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, opts);
    }
  };
});

const { ToolExecutor, clampLogCount, rejectGitOptionArgs } = await import("../../src/apps/ide/tool-executor.js");
const { githubTokenCredentialEnv, GIT_TOKEN_ENV } = await import("../../src/apps/ide/git-safe.js");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ide-gitargs-"));
  realExecFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("git tool arguments", () => {
  it("refuses option-like refs, remotes and branch names", async () => {
    const root = repo();
    const marker = join(root, "..", `pwned-${Date.now()}`);
    const t = new ToolExecutor(root);
    const fetch = await t.execute("git_fetch", { remote: `--upload-pack=touch ${marker}` });
    expect(fetch.error).toMatch(/looks like an option/);
    expect(existsSync(marker)).toBe(false);
    expect((await t.execute("git_diff", { ref: `--output=${marker}` })).error).toMatch(/looks like an option/);
    expect((await t.execute("git_log", { ref: "--output=x" })).error).toMatch(/looks like an option/);
    expect((await t.execute("git_push", { remote: "origin", branch: "--receive-pack=x" })).error).toMatch(/looks like an option/);
    expect((await t.execute("git_pull", { remote: "--upload-pack=x" })).error).toMatch(/looks like an option/);
    expect((await t.execute("git_branch", { name: "--help" })).error).toMatch(/looks like an option/);
    expect(existsSync(marker)).toBe(false);
  });

  it("validates and clamps helper inputs", () => {
    expect(rejectGitOptionArgs({ ref: "main" })).toBeNull();
    expect(rejectGitOptionArgs({ ref: "" })).toBeNull();
    expect(rejectGitOptionArgs({ ref: "-n" })).not.toBeNull();
    expect(clampLogCount(1e9)).toBe(500);
    expect(clampLogCount(-3)).toBe(1);
    expect(clampLogCount("5")).toBe(10);
    expect(clampLogCount(7.9)).toBe(7);
  });

  it("passes the GitHub token through the environment, not argv", async () => {
    const root = repo();
    execCalls.length = 0;
    const token = "ghp_secret_token_value_123";
    await new ToolExecutor(root, token).execute("git_fetch", { remote: "origin" });
    const call = execCalls.find((c) => c.args.includes("fetch"));
    expect(call).toBeDefined();
    expect(call!.args.join(" ")).not.toContain(token);
    expect(call!.env?.[GIT_TOKEN_ENV]).toBe(token);
    const values = Object.entries(call!.env ?? {}).filter(([k]) => k.startsWith("GIT_CONFIG_VALUE_")).map(([, v]) => v);
    expect(values.join(" ")).not.toContain(token);
  });

  it("the credential helper answers github.com with the token", () => {
    const root = repo();
    const env = githubTokenCredentialEnv("tok-abc", { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: root });
    const out = realExecFileSync("git", ["credential", "fill"], { cwd: root, env, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
    expect(out).toContain("username=x-access-token");
    expect(out).toContain("password=tok-abc");
  });
});

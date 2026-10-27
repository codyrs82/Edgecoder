import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const spawnSpy = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnSpy(...args);
      return actual.spawn(...args);
    }
  };
});

const { ToolExecutor, evaluateShellCommand, parseArgv, scrubShellEnv } = await import("../../src/apps/ide/tool-executor.js");

describe("run_shell policy (#4)", () => {
  const root = mkdtempSync(join(tmpdir(), "ide-tool-"));

  it("rejects metacharacter commands without approval and spawns nothing", async () => {
    spawnSpy.mockClear();
    const res = await new ToolExecutor(root).execute("run_shell", { command: "rm -rf / ; echo" });
    expect(res.error).toMatch(/rejected/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted binaries without approval", async () => {
    spawnSpy.mockClear();
    const res = await new ToolExecutor(root).execute("run_shell", { command: "rm -rf /" });
    expect(res.error).toMatch(/allowlist/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("runs an allowlisted ls with shell:false and a scrubbed env", async () => {
    spawnSpy.mockClear();
    process.env.FAKE_SERVICE_TOKEN = "should-not-leak";
    try {
      const res = await new ToolExecutor(root).execute("run_shell", { command: "ls -a" });
      expect(res.error).toBeUndefined();
      expect(JSON.parse(res.result!).exit_code).toBe(0);
      const [cmd, args, opts] = spawnSpy.mock.calls[0];
      expect(cmd).toBe("ls");
      expect(args).toEqual(["-a"]);
      expect(opts.shell).toBe(false);
      expect(opts.env.FAKE_SERVICE_TOKEN).toBeUndefined();
    } finally {
      delete process.env.FAKE_SERVICE_TOKEN;
    }
  });

  it("git: read-only subcommands allowed, others need approval", () => {
    expect(evaluateShellCommand("git status").allowed).toBe(true);
    expect(evaluateShellCommand("git push origin main").allowed).toBe(false);
    expect(evaluateShellCommand("git push origin main", { approved: true }).allowed).toBe(true);
  });

  it("IDE_SHELL_ALLOW overrides the allowlist", () => {
    expect(evaluateShellCommand("ls", { env: { IDE_SHELL_ALLOW: "make" } }).allowed).toBe(false);
    expect(evaluateShellCommand("make test", { env: { IDE_SHELL_ALLOW: "make" } }).allowed).toBe(true);
  });

  it("approved metacharacter commands are allowed via shell", () => {
    expect(evaluateShellCommand("npm test && echo ok", { approved: true })).toMatchObject({ allowed: true, useShell: true });
  });

  it("parseArgv handles quotes", () => {
    expect(parseArgv(`rg "hello world" src`)).toEqual(["rg", "hello world", "src"]);
    expect(parseArgv(`echo ''`)).toEqual(["echo", ""]);
  });

  it("scrubShellEnv strips secrets", () => {
    expect(scrubShellEnv({ PATH: "/bin", GITHUB_TOKEN: "x", ADMIN_SECRET: "y", OPENAI_API_KEY: "z" })).toEqual({ PATH: "/bin" });
  });
});

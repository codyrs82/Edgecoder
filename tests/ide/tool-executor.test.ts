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

  it("runs an allowlisted command with shell:false and an allowlisted env", async () => {
    spawnSpy.mockClear();
    process.env.FAKE_SERVICE_TOKEN = "should-not-leak";
    try {
      // `node --version` works on every CI OS (ls does not exist on Windows).
      const res = await new ToolExecutor(root).execute("run_shell", { command: "node --version" });
      expect(res.error).toBeUndefined();
      expect(JSON.parse(res.result!).exit_code).toBe(0);
      const [cmd, args, opts] = spawnSpy.mock.calls[0];
      expect(cmd).toBe("node");
      expect(args).toEqual(["--version"]);
      expect(opts.shell).toBe(false);
      expect(opts.env.FAKE_SERVICE_TOKEN).toBeUndefined();
    } finally {
      delete process.env.FAKE_SERVICE_TOKEN;
    }
  });

  it("unapproved: blocks inline-code interpreters, npx, npm exec, cargo/go run", () => {
    for (const cmd of [
      "node -e process.exit(0)",
      "node --eval=1",
      "node -p 1",
      "node",
      "python3 -c print(1)",
      "python3 -m http.server",
      "npx some-package",
      "npm exec foo",
      "cargo run",
      "go run main.go",
      "/bin/ls"
    ]) {
      expect(evaluateShellCommand(cmd, { root }).allowed, cmd).toBe(false);
    }
    expect(evaluateShellCommand("node -e 1", { approved: true, root }).allowed).toBe(true);
  });

  it("unapproved: blocks path arguments outside the project root", () => {
    for (const cmd of ["cat /etc/passwd", "cat ~/.ssh/id_rsa", "cat ../secret", "head -n 5 ../../x", "rg foo /home", "grep --file=/etc/x y"]) {
      expect(evaluateShellCommand(cmd, { root }).allowed, cmd).toBe(false);
    }
    for (const cmd of ["cat README.md", "cat src/../package.json", "rg foo src", "ls -la"]) {
      expect(evaluateShellCommand(cmd, { root }).allowed, cmd).toBe(true);
    }
    expect(evaluateShellCommand("cat /etc/hosts", { approved: true, root }).allowed).toBe(true);
  });

  it("git: modifying remote/branch/--output need approval", () => {
    for (const cmd of ["git remote add x y", "git remote set-url origin z", "git branch -D main", "git branch new-branch", "git diff --output=x.txt"]) {
      expect(evaluateShellCommand(cmd).allowed, cmd).toBe(false);
    }
    for (const cmd of ["git remote", "git remote -v", "git branch", "git branch -a", "git diff HEAD~1"]) {
      expect(evaluateShellCommand(cmd).allowed, cmd).toBe(true);
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

  it("scrubShellEnv passes only allowlisted variables", () => {
    expect(
      scrubShellEnv({
        PATH: "/bin",
        HOME: "/h",
        LC_ALL: "C",
        GITHUB_TOKEN: "x",
        AWS_SECRET_ACCESS_KEY: "y",
        DATABASE_URL: "postgres://u:p@h/db",
        SENTRY_DSN: "z"
      })
    ).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C" });
    expect(scrubShellEnv({ PATH: "/bin", MY_VAR: "1", IDE_SHELL_ENV_PASS: "MY_VAR" })).toEqual({ PATH: "/bin", MY_VAR: "1" });
  });
});

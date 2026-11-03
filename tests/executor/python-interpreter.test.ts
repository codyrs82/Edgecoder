import { afterEach, describe, expect, it } from "vitest";
import { pythonCandidates, resetPythonCache, resolvePython, PYTHON_NOT_FOUND } from "../../src/executor/python-interpreter.js";
import { astTimeoutMs, validatePythonAst } from "../../src/executor/ast-python.js";
import { runCode } from "../../src/executor/run.js";

afterEach(() => resetPythonCache());

describe("pythonCandidates (#112)", () => {
  it("tries python3 first on POSIX", () => {
    expect(pythonCandidates("linux", {}).map((c) => c.command)).toEqual(["python3", "python"]);
    expect(pythonCandidates("darwin", {})[0]).toEqual({ command: "python3", args: [] });
  });

  it("prefers python and the py launcher over the Store python3 alias on Windows", () => {
    expect(pythonCandidates("win32", {})).toEqual([
      { command: "python", args: [] },
      { command: "py", args: ["-3"] },
      { command: "python3", args: [] }
    ]);
  });

  it("EDGECODER_PYTHON overrides the search", () => {
    expect(pythonCandidates("win32", { EDGECODER_PYTHON: " C:\\Python312\\python.exe " })).toEqual([
      { command: "C:\\Python312\\python.exe", args: [] }
    ]);
  });
});

describe("resolvePython (#112)", () => {
  it("returns the first candidate whose probe succeeds and caches it", async () => {
    const tried: string[] = [];
    const probe = async (c: { command: string }) => {
      tried.push(c.command);
      return c.command === "python";
    };
    const found = await resolvePython(probe);
    expect(found?.command).toBe("python");
    expect(await resolvePython(async () => false)).toBe(found);
    expect(tried.length).toBeGreaterThan(0);
  });

  it("does not cache 'none found', so a slow or later-installed interpreter is picked up", async () => {
    expect(await resolvePython(async () => false)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect((await resolvePython(async () => true))?.command).toBeDefined();
  });
});

describe("Python spawn failures fail closed instead of crashing (#112)", () => {
  // The probe "finds" a command that does not exist: spawn then emits ENOENT, which used to be an
  // unhandled 'error' event that killed the worker process.
  const missing = async () => {
    resetPythonCache();
    await resolvePython(async () => true);
  };

  it("validatePythonAst reports the spawn error", async () => {
    const prev = process.env.EDGECODER_PYTHON;
    process.env.EDGECODER_PYTHON = "edgecoder-no-such-python-112";
    try {
      await missing();
      const result = await validatePythonAst("x = 1");
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/could not run edgecoder-no-such-python-112/);
    } finally {
      if (prev === undefined) delete process.env.EDGECODER_PYTHON;
      else process.env.EDGECODER_PYTHON = prev;
    }
  });

  it("runCode reports a missing interpreter as a failed run", async () => {
    const prev = process.env.EDGECODER_PYTHON;
    process.env.EDGECODER_PYTHON = "edgecoder-no-such-python-112";
    try {
      resetPythonCache();
      const result = await runCode("python", "x = 1", 2000, "host", undefined, "local");
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain(PYTHON_NOT_FOUND.split(":")[0]);
    } finally {
      if (prev === undefined) delete process.env.EDGECODER_PYTHON;
      else process.env.EDGECODER_PYTHON = prev;
    }
  });
});

describe("astTimeoutMs (#112)", () => {
  it("defaults to 10 s and honours EDGECODER_PYTHON_AST_TIMEOUT_MS", () => {
    expect(astTimeoutMs({})).toBe(10_000);
    expect(astTimeoutMs({ EDGECODER_PYTHON_AST_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(astTimeoutMs({ EDGECODER_PYTHON_AST_TIMEOUT_MS: "abc" })).toBe(10_000);
  });
});

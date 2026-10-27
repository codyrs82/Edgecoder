import { describe, expect, it, vi } from "vitest";

const spawnSpy = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => { spawnSpy(...args); return actual.spawn(...args); } };
});

const { runCode } = await import("../../src/executor/run.js");

describe("runCode origin gate (#45)", () => {
  it("refuses host execution for remote tasks without spawning", async () => {
    spawnSpy.mockClear();
    const res = await runCode("python", "print('x')", 4000, "host", undefined, "remote");
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe("sandbox_required_for_remote_task");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("defaults to the remote origin", async () => {
    const res = await runCode("javascript", "console.log(1)", 4000, "host");
    expect(res.stderr).toBe("sandbox_required_for_remote_task");
  });

  it("allows host execution for local origin", async () => {
    const res = await runCode("javascript", "console.log(1)", 4000, "host", undefined, "local");
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("1");
  });
});

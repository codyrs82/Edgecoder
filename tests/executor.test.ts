import { describe, expect, it } from "vitest";
import { runCode } from "../src/executor/run.js";

describe("executor", () => {
  it("runs safe python", async () => {
    const result = await runCode("python", "print('ok')", 2000);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("blocks python outside subset", async () => {
    const result = await runCode("python", "import os\nprint('x')", 2000);
    expect(result.queueForCloud).toBe(true);
    expect(result.queueReason).toBe("outside_subset");
  });

  it("runs safe javascript", async () => {
    const result = await runCode("javascript", "console.log('ok')", 2000);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("blocks python code that bypasses regex but fails AST (globals)", async () => {
    const result = await runCode("python", "x = globals()", 2000);
    expect(result.queueForCloud).toBe(true);
    expect(result.queueReason).toBe("outside_subset");
  });

  it("blocks javascript new Function constructor via AST", async () => {
    const result = await runCode("javascript", 'const f = new Function("return 1"); console.log(f());', 2000);
    expect(result.queueForCloud).toBe(true);
    expect(result.queueReason).toBe("outside_subset");
  });
});

import { describe, expect, it } from "vitest";
import { cleanCompletion } from "../../src/apps/ide/complete.js";

describe("cleanCompletion", () => {
  it("stops where the model starts repeating the code after the cursor", () => {
    const c = "if n <= 1:\n        return n\n    return fib(n-1) + fib(n-2)\n\nprint(fib(10))";
    expect(cleanCompletion(c, "\n\nprint(fib(10))\n")).toBe("if n <= 1:\n        return n\n    return fib(n-1) + fib(n-2)");
  });
  it("drops a repeated rest-of-line", () => {
    expect(cleanCompletion("total + x)", ")")).toBe("total + x");
  });
  it("caps the length and trailing blank lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    expect(cleanCompletion(many, "").split("\n")).toHaveLength(12);
    expect(cleanCompletion("x = 1\n\n", "")).toBe("x = 1");
  });
});

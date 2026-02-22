import { describe, expect, it } from "vitest";
import { validatePythonAst } from "../../src/executor/ast-python.js";

describe("Python AST validation", () => {
  it("allows safe code", async () => {
    const result = await validatePythonAst("x = 1 + 2\nprint(x)");
    expect(result.safe).toBe(true);
  });

  it("allows functions and loops", async () => {
    const result = await validatePythonAst(
      "def add(a, b):\n    return a + b\nfor i in range(5):\n    print(add(i, 1))"
    );
    expect(result.safe).toBe(true);
  });

  it("blocks import statements", async () => {
    const result = await validatePythonAst("import os\nprint(os.getcwd())");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Import");
  });

  it("blocks from-import statements", async () => {
    const result = await validatePythonAst("from pathlib import Path");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Import");
  });

  it("blocks open() builtin calls", async () => {
    const result = await validatePythonAst("f = open('test.txt')");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("open");
  });

  it("blocks eval() builtin calls", async () => {
    const result = await validatePythonAst("eval('1+1')");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("eval");
  });

  it("blocks exec() builtin calls", async () => {
    const result = await validatePythonAst("exec('print(1)')");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("exec");
  });

  it("allows list comprehensions", async () => {
    const result = await validatePythonAst("squares = [x*x for x in range(10)]");
    expect(result.safe).toBe(true);
  });

  it("returns parse error for invalid syntax", async () => {
    const result = await validatePythonAst("def (broken");
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

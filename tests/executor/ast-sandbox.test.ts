import { describe, expect, it } from "vitest";
import { validatePythonAst } from "../../src/executor/ast-python.js";
import { validateJavaScriptAst } from "../../src/executor/ast-javascript.js";

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

describe("JavaScript AST validation", () => {
  it("allows safe code", () => {
    const result = validateJavaScriptAst("const x = 1 + 2;\nconsole.log(x);");
    expect(result.safe).toBe(true);
  });

  it("allows arrow functions and loops", () => {
    const result = validateJavaScriptAst(
      "const add = (a, b) => a + b;\nfor (let i = 0; i < 5; i++) { console.log(add(i, 1)); }"
    );
    expect(result.safe).toBe(true);
  });

  it("blocks import declarations", () => {
    const result = validateJavaScriptAst('import fs from "fs";');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Import");
  });

  it("blocks dynamic import()", () => {
    const result = validateJavaScriptAst('const m = import("fs");');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Import");
  });

  it("blocks process global access", () => {
    const result = validateJavaScriptAst("console.log(process.env.HOME);");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("process");
  });

  it("blocks require calls", () => {
    const result = validateJavaScriptAst('const fs = require("fs");');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("require");
  });

  it("blocks eval calls", () => {
    const result = validateJavaScriptAst('eval("1+1");');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("eval");
  });

  it("blocks new expression (constructor injection)", () => {
    const result = validateJavaScriptAst('const f = new Function("return 1");');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("New");
  });

  it("allows template literals", () => {
    const result = validateJavaScriptAst("const name = `hello ${1 + 2}`;");
    expect(result.safe).toBe(true);
  });

  it("returns parse error for invalid syntax", () => {
    const result = validateJavaScriptAst("function (broken {");
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

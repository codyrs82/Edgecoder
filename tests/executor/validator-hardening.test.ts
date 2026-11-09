import { describe, expect, it } from "vitest";
import { validatePythonAst } from "../../src/executor/ast-python.js";
import { validateJavaScriptAst } from "../../src/executor/ast-javascript.js";

// Accept/reject decisions only: nothing here is executed. These close the constructor and
// __subclasses__ families as hardening; the validators are still not a sandbox (see run.ts).

describe("JavaScript validator: constructor and prototype families", () => {
  it.each([
    ["arrow constructor", 'console.log((()=>{}).constructor("return 1")())'],
    ["host function constructor", 'console.log(console.log.constructor("return 1")())'],
    ["string-key constructor", 'console.log((()=>{})["constructor"]("return 1")())'],
    ["template-key constructor", "console.log((()=>{})[`constructor`]('return 1')())"],
    ["__proto__", "const o = {}; console.log(o.__proto__)"],
    ["prototype", "console.log(Array.prototype)"],
    ["string-key global", 'const g = {}; console.log(g["process"])'],
    ["global in an object property value", "const o = { p: process }; console.log(o)"]
  ])("rejects %s", (_label, code) => {
    expect(validateJavaScriptAst(code).safe).toBe(false);
  });

  it("still accepts ordinary code with objects, indexing and strings", () => {
    const code = 'const o = { a: 1, b: [2, 3] };\nconst k = "a";\nconsole.log(o[k] + o.b[1], `x${o.a}`, "process done");';
    expect(validateJavaScriptAst(code)).toEqual({ safe: true });
  });
});

describe("Python validator: dunder attributes and aliased builtins", () => {
  it.each([
    ["__subclasses__ chain", 'print([c for c in ().__class__.__base__.__subclasses__() if c.__name__ == "x"])'],
    ["__self__", "print(print.__self__)"],
    ["__globals__", "def f():\n    pass\nprint(f.__globals__)"],
    ["aliased eval through a subscript callee", 'd = {"a": eval}\nprint(d["a"]("1+1"))'],
    ["aliased getattr", "g = getattr\nprint(g(1, 'real'))"],
    ["__builtins__ name", "print(__builtins__)"]
  ])("rejects %s", async (_label, code) => {
    expect((await validatePythonAst(code)).safe).toBe(false);
  });

  it("still accepts ordinary code, including the __name__ guard", async () => {
    const code = 'def main():\n    xs = [i * i for i in range(4)]\n    print(sum(xs))\nif __name__ == "__main__":\n    main()';
    expect(await validatePythonAst(code)).toEqual({ safe: true });
  });
});

import { describe, expect, it } from "vitest";
import { extractCode } from "../../src/model/extract.js";

describe("extractCode", () => {
  it("returns code as-is if no fences", () => {
    expect(extractCode("print('hello')", "python")).toBe("print('hello')");
  });

  it("strips markdown python fences", () => {
    const raw = "Here is the code:\n```python\nprint('hello')\n```\nDone.";
    expect(extractCode(raw, "python")).toBe("print('hello')");
  });

  it("strips markdown js fences", () => {
    const raw = "```javascript\nconsole.log('hi');\n```";
    expect(extractCode(raw, "javascript")).toBe("console.log('hi');");
  });

  it("strips generic fences", () => {
    const raw = "```\nprint('hi')\n```";
    expect(extractCode(raw, "python")).toBe("print('hi')");
  });

  it("handles multiple fence blocks by taking the first", () => {
    const raw = "```python\nprint(1)\n```\nsome text\n```python\nprint(2)\n```";
    expect(extractCode(raw, "python")).toBe("print(1)");
  });

  it("trims whitespace", () => {
    const raw = "\n\n  print('hello')  \n\n";
    expect(extractCode(raw, "python")).toBe("print('hello')");
  });
});

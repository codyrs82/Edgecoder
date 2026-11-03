import { describe, expect, it } from "vitest";
import { cleanInlineEdit, inlineEditMessages } from "../../src/apps/ide/inline-edit.js";

describe("inline edit", () => {
  it("marks the selection, or the cursor, in context", () => {
    const sel = inlineEditMessages({ path: "a.py", language: "python", prefix: "x = 1\n", selection: "y = 2\n", suffix: "z = 3\n", instruction: "double it" });
    expect(sel[1].content).toContain("x = 1\n<selection>\ny = 2\n\n</selection>z = 3");
    expect(sel[1].content).toContain("Instruction: double it");
    const ins = inlineEditMessages({ path: "a.py", language: "python", prefix: "a\n", selection: "", suffix: "b\n", instruction: "add c" });
    expect(ins[1].content).toContain("a\n<cursor/>b");
    expect(ins[0].content).toContain("insert at <cursor/>");
  });

  it("strips fences, tags and think blocks, keeping the selection's trailing newline", () => {
    expect(cleanInlineEdit("```python\ny = 4\n```", "y = 2\n")).toBe("y = 4\n");
    expect(cleanInlineEdit("<selection>\ny = 4\n</selection>", "y = 2")).toBe("y = 4");
    expect(cleanInlineEdit("<think>hmm</think>\ny = 4\n\n", "y = 2\n")).toBe("y = 4\n");
    expect(cleanInlineEdit("\n\nc = 3\n", "")).toBe("c = 3");
  });
});

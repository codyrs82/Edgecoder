import { describe, expect, it } from "vitest";
import { EdgeCoderLocalProvider } from "../../src/model/providers.js";

describe("EdgeCoderLocalProvider", () => {
  it("returns runnable python for plain-language tasks", async () => {
    const provider = new EdgeCoderLocalProvider();
    const out = await provider.generate({
      prompt: "Write python code for this task:\nhello world"
    });
    expect(out.text.startsWith("print(")).toBe(true);
  });

  it("passes through code-like python tasks unchanged", async () => {
    const provider = new EdgeCoderLocalProvider();
    const snippet = "for i in range(2):\n    print(i)";
    const out = await provider.generate({
      prompt: `Write python code for this task:\n${snippet}`
    });
    expect(out.text).toBe(snippet);
  });
});

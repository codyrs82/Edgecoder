import { describe, expect, it } from "vitest";
import { EdgeCoderLocalProvider, ProviderRegistry } from "../../src/model/providers.js";

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

describe("ProviderRegistry tiers", () => {
  it("supports ollama-edge tier", () => {
    const registry = new ProviderRegistry();
    registry.use("ollama-edge");
    expect(registry.current().kind).toBe("ollama-local");
  });

  it("supports ollama-coordinator tier", () => {
    const registry = new ProviderRegistry();
    registry.use("ollama-coordinator");
    expect(registry.current().kind).toBe("ollama-local");
  });

  it("lists available providers", () => {
    const registry = new ProviderRegistry();
    const available = registry.availableProviders();
    expect(available).toContain("edgecoder-local");
    expect(available).toContain("ollama-edge");
    expect(available).toContain("ollama-coordinator");
  });
});

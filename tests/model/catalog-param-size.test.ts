import { describe, it, expect } from "vitest";
import { paramSizeBillions } from "../../src/model/catalog.js";
import { MODEL_CATALOG } from "../../src/model/catalog.js";

describe("paramSizeBillions", () => {
  it("should extract size from catalog entries", () => {
    // Test with models from the catalog
    expect(paramSizeBillions("qwen3-coder:30b", MODEL_CATALOG)).toBe(30);
    expect(paramSizeBillions("qwen2.5-coder:7b", MODEL_CATALOG)).toBe(7);
    expect(paramSizeBillions("gpt-oss:20b", MODEL_CATALOG)).toBe(21); // 21B (3.6B active) -> 21
    expect(paramSizeBillions("qwen3.5:9b", MODEL_CATALOG)).toBe(9);
    expect(paramSizeBillions("qwen3.5:4b", MODEL_CATALOG)).toBe(4);
    expect(paramSizeBillions("qwen3.5:0.8b", MODEL_CATALOG)).toBe(0.8);
  });

  it("should extract size from tags not in catalog", () => {
    // Test with tags that are not in the catalog but contain size info
    expect(paramSizeBillions("qwen2.5-coder:7b")).toBe(7);
    expect(paramSizeBillions("llama3:70b-instruct")).toBe(70);
    expect(paramSizeBillions("some-model:1.5b")).toBe(1.5);
    expect(paramSizeBillions("another-model:24b")).toBe(24);
  });

  it("should return 0 for unknown tags", () => {
    // Test with unknown tags
    expect(paramSizeBillions("unknown-model:latest")).toBe(0);
    expect(paramSizeBillions("some-model")).toBe(0);
    expect(paramSizeBillions("model-with-no-size")).toBe(0);
    expect(paramSizeBillions("")).toBe(0);
  });
});
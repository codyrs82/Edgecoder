import { describe, expect, it } from "vitest";
import { isOllamaLibraryModelName } from "../../src/model/ollama-installer.js";

describe("isOllamaLibraryModelName", () => {
  it("accepts library names with optional namespace and tag", () => {
    for (const m of ["qwen3.5:9b", "llama3", "deepseek-r1:14b", "library/qwen2.5-coder:7b-instruct-q4_K_M", "user/model"]) {
      expect(isOllamaLibraryModelName(m)).toBe(true);
    }
  });
  it("rejects registry hosts, extra segments and bad characters", () => {
    for (const m of ["evil.example.com/x/y", "registry.io/model", "host:5000/model", "a/b/c", "", "-rf", "model:tag with space", "model;rm", "../x", "x:", 42]) {
      expect(isOllamaLibraryModelName(m)).toBe(false);
    }
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, MODEL_CATALOG, catalogEntryForTag, defaultModelForMemory } from "../../src/model/catalog.js";
import { renderDesktopCatalog } from "../../scripts/sync-model-catalog.mjs";

const ROOT = resolve(__dirname, "../..");

describe("model catalog", () => {
  it("every entry is an official-looking Ollama tag with the fields the Model Manager renders", () => {
    const ids = new Set<string>();
    for (const m of MODEL_CATALOG) {
      expect(m.modelId).toMatch(/^[a-z0-9][a-z0-9._-]*:[a-z0-9._-]+$/);
      expect(ids.has(m.modelId), `duplicate ${m.modelId}`).toBe(false);
      ids.add(m.modelId);
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.paramSize.length).toBeGreaterThan(0);
      expect(m.diskSize).toMatch(/^\d+(\.\d+)? GB$/);
      expect(m.description.length).toBeGreaterThan(20);
      expect(Object.keys(CATEGORY_LABELS)).toContain(m.category);
      expect(m.minMemoryGb).toBeGreaterThan(0);
      expect(m.contextTokens).toBeGreaterThanOrEqual(8192);
      expect(m.license.length).toBeGreaterThan(0);
    }
  });

  it("each category has at least one recommended model", () => {
    for (const category of Object.keys(CATEGORY_LABELS)) {
      expect(MODEL_CATALOG.some((m) => m.category === category && m.recommended), category).toBe(true);
    }
  });

  it("the default model (qwen3.5:9b) is in the catalog and recommended", () => {
    const def = MODEL_CATALOG.find((m) => m.modelId === "qwen3.5:9b");
    expect(def?.recommended).toBe(true);
  });

  it("picks the largest recommended model that fits the machine", () => {
    expect(defaultModelForMemory(8)).toBe("qwen3.5:4b");
    expect(defaultModelForMemory(16)).toBe("qwen3.5:9b");
    expect(defaultModelForMemory(32)).toBe("qwen3-coder:30b");
    expect(defaultModelForMemory(1)).toBe("qwen3.5:0.8b");
  });

  it("maps installed tags (including :latest) back to catalog entries", () => {
    expect(catalogEntryForTag("qwen3.5:9b")?.name).toBe("Qwen 3.5 9B");
    expect(catalogEntryForTag("qwen3-coder:latest")?.modelId).toBe("qwen3-coder:30b");
    expect(catalogEntryForTag("qwen3.5:122b")).toBeUndefined();
    expect(catalogEntryForTag("mistral:7b")).toBeUndefined();
  });

  it("desktop/src/lib/models.ts is the generated copy of the shared catalog", () => {
    const shared = readFileSync(resolve(ROOT, "src/model/catalog.ts"), "utf8");
    const desktop = readFileSync(resolve(ROOT, "desktop/src/lib/models.ts"), "utf8");
    expect(desktop).toBe(renderDesktopCatalog(shared));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HELPERS, effectiveHelpers, helpersDefaults, helpersLabel, helpersOn, setHelpersDefaults } from "../src/lib/helpers";

const CLAUDE = "frontier/anthropic/claude-opus-5-5";

afterEach(() => vi.unstubAllGlobals());

describe("the Code view's Helpers switch", () => {
  it("is on by default when the lead is a frontier model, off otherwise", () => {
    expect(helpersOn(undefined, CLAUDE, DEFAULT_HELPERS)).toBe(true);
    expect(helpersOn(undefined, "auto", DEFAULT_HELPERS)).toBe(false);
    expect(helpersOn(undefined, "network/qwen3-coder:30b@gpu", DEFAULT_HELPERS)).toBe(false);
    expect(helpersOn(undefined, undefined, DEFAULT_HELPERS)).toBe(false);
    expect(helpersOn({}, CLAUDE, DEFAULT_HELPERS)).toBe(true);
  });

  it("keeps the user's own choice for the chat, whatever the lead", () => {
    expect(helpersOn({ enabled: false }, CLAUDE, DEFAULT_HELPERS)).toBe(false);
    expect(helpersOn({ enabled: true }, "auto", DEFAULT_HELPERS)).toBe(true);
  });

  it("follows Settings' default when the chat has no choice", () => {
    expect(helpersOn(undefined, "auto", { ...DEFAULT_HELPERS, when: "always" })).toBe(true);
    expect(helpersOn(undefined, CLAUDE, { ...DEFAULT_HELPERS, when: "never" })).toBe(false);
  });

  it("sends 4 at once and 100 cSats by default, the chat's own numbers when set", () => {
    expect(effectiveHelpers(undefined, CLAUDE, DEFAULT_HELPERS)).toEqual({ enabled: true, maxParallel: 4, budgetCSats: 100 });
    expect(effectiveHelpers({ maxParallel: 2, budgetCSats: 40 }, "auto", DEFAULT_HELPERS)).toEqual({ enabled: false, maxParallel: 2, budgetCSats: 40 });
    expect(effectiveHelpers({ maxParallel: 99 }, "auto", DEFAULT_HELPERS).maxParallel).toBe(16);
    expect(helpersLabel({ enabled: true, maxParallel: 4, budgetCSats: 100 })).toBe("Helpers · 4 · 100 cSats");
    expect(helpersLabel({ enabled: false, maxParallel: 4, budgetCSats: 100 })).toBe("Helpers off");
  });

  it("keeps Settings' default in local storage, and falls back without it", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(helpersDefaults()).toEqual(DEFAULT_HELPERS);
    expect(setHelpersDefaults({ when: "always", maxParallel: 0, budgetCSats: 30 })).toEqual({ when: "always", maxParallel: 1, budgetCSats: 30 });
    expect(helpersDefaults()).toEqual({ when: "always", maxParallel: 1, budgetCSats: 30 });
    expect(helpersOn(undefined, "auto")).toBe(true);
  });
});

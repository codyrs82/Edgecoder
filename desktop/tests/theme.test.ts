import { beforeEach, describe, expect, it } from "vitest";
import { initTheme, setTheme, getThemePreference, onThemeChange, THEME_STORAGE_KEY, DEFAULT_THEME } from "../src/lib/theme";

function fakeEnv(systemDark: boolean, stored: string | null = null) {
  const store = new Map<string, string>();
  if (stored !== null) store.set(THEME_STORAGE_KEY, stored);
  const handlers = new Set<() => void>();
  const mql = {
    matches: systemDark,
    addEventListener: (_: string, h: () => void) => handlers.add(h),
    removeEventListener: (_: string, h: () => void) => handlers.delete(h),
  };
  const env = {
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    root: { dataset: {} as Record<string, string | undefined> },
    matchMedia: () => mql as any,
  };
  const flip = (dark: boolean) => { mql.matches = dark; for (const h of handlers) h(); };
  return { env, store, flip };
}

describe("desktop theme (#23)", () => {
  let f: ReturnType<typeof fakeEnv>;
  beforeEach(() => { f = fakeEnv(true); initTheme(f.env); });

  it("defaults to dark (until light mode is QA'd), regardless of the OS", () => {
    expect(DEFAULT_THEME).toBe("dark");
    const g = fakeEnv(false);
    initTheme(g.env);
    expect(getThemePreference()).toBe("dark");
    expect(g.env.root.dataset.theme).toBe("dark");
  });

  it('"system" follows prefers-color-scheme', () => {
    setTheme("system");
    expect(f.env.root.dataset.theme).toBe("dark");
    f.flip(false);
    expect(f.env.root.dataset.theme).toBe("light");
  });

  it('setTheme("light") sets data-theme and persists', () => {
    setTheme("light");
    expect(f.env.root.dataset.theme).toBe("light");
    expect(f.store.get(THEME_STORAGE_KEY)).toBe("light");
    f.flip(true); // explicit choice ignores the OS
    expect(f.env.root.dataset.theme).toBe("light");
  });

  it("restores a persisted choice and ignores garbage", () => {
    const g = fakeEnv(false, "dark");
    initTheme(g.env);
    expect(g.env.root.dataset.theme).toBe("dark");
    const h = fakeEnv(false, "neon");
    initTheme(h.env);
    expect(getThemePreference()).toBe("dark");
    expect(h.env.root.dataset.theme).toBe("dark");
  });

  it("notifies subscribers (Monaco) and unsubscribes", () => {
    const seen: string[] = [];
    const off = onThemeChange((t) => seen.push(t));
    setTheme("light");
    off();
    setTheme("dark");
    expect(seen).toEqual(["light"]);
  });

  it("rejects invalid values", () => {
    expect(() => setTheme("neon" as any)).toThrow();
  });
});

// #23: light/dark/system theme. Persists the choice, sets <html data-theme>,
// and follows prefers-color-scheme while in "system" mode.
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "edgecoder-theme";
/** Dark until light mode has had a visual QA pass (#85 checklist); then switch to "system". */
export const DEFAULT_THEME: ThemePreference = "dark";
const QUERY = "(prefers-color-scheme: dark)";

interface Env {
  storage: Pick<Storage, "getItem" | "setItem">;
  root: { dataset: Record<string, string | undefined> };
  matchMedia: (q: string) => Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
}

let env: Env | null = null;
let preference: ThemePreference = DEFAULT_THEME;
let mql: ReturnType<Env["matchMedia"]> | null = null;
const listeners = new Set<(t: ResolvedTheme) => void>();

function defaultEnv(): Env {
  return { storage: localStorage, root: document.documentElement, matchMedia: (q) => window.matchMedia(q) };
}

function isPref(v: unknown): v is ThemePreference {
  return v === "system" || v === "light" || v === "dark";
}

export function resolvedTheme(): ResolvedTheme {
  if (preference !== "system") return preference;
  return mql?.matches ? "dark" : "light";
}

function apply(): void {
  if (!env) return;
  const t = resolvedTheme();
  env.root.dataset.theme = t;
  for (const fn of listeners) fn(t);
}

const onSystemChange = () => {
  if (preference === "system") apply();
};

/** Call once at startup (main.ts). `e` is injectable for tests. */
export function initTheme(e: Env = defaultEnv()): ResolvedTheme {
  if (mql) mql.removeEventListener("change", onSystemChange);
  env = e;
  let stored: string | null = null;
  try { stored = e.storage.getItem(THEME_STORAGE_KEY); } catch { /* storage unavailable */ }
  preference = isPref(stored) ? stored : DEFAULT_THEME;
  mql = e.matchMedia(QUERY);
  mql.addEventListener("change", onSystemChange);
  apply();
  return resolvedTheme();
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setTheme(p: ThemePreference): ResolvedTheme {
  if (!isPref(p)) throw new Error(`invalid theme: ${String(p)}`);
  preference = p;
  try { env?.storage.setItem(THEME_STORAGE_KEY, p); } catch { /* ignore */ }
  apply();
  return resolvedTheme();
}

/** Subscribe to resolved-theme changes (e.g. Monaco). Returns an unsubscribe fn. */
export function onThemeChange(fn: (t: ResolvedTheme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

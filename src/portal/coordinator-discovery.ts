// #35: the portal's coordinator list comes from config, with a fallback to the EU seed.
// COORDINATOR_DISCOVERY_URLS is a comma list; the legacy single COORDINATOR_DISCOVERY_URL
// is still honoured.

export const DEFAULT_DISCOVERY_URL = "https://edgecoder-seed-eu.fly.dev";

export function parseDiscoveryUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.COORDINATOR_DISCOVERY_URLS ?? env.COORDINATOR_DISCOVERY_URL ?? DEFAULT_DISCOVERY_URL;
  const urls = raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return [...new Set(urls)];
}

/** True when the operator configured discovery explicitly (not just the built-in default). */
export function discoveryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.COORDINATOR_DISCOVERY_URLS ?? env.COORDINATOR_DISCOVERY_URL ?? "").trim());
}

export interface PickerOptions {
  urls: string[];
  /** Resolves true when `url` is healthy. Must apply its own timeout. */
  probe: (url: string) => Promise<boolean>;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Try each URL in order and cache the first healthy one for `ttlMs` (60 s).
 * Returns null when none is healthy (nothing is cached in that case).
 */
export function createCoordinatorPicker(opts: PickerOptions): () => Promise<string | null> {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let cached: { url: string; at: number } | null = null;
  return async () => {
    if (cached && now() - cached.at < ttl) return cached.url;
    cached = null;
    for (const url of opts.urls) {
      let ok = false;
      try {
        ok = await opts.probe(url);
      } catch {
        ok = false;
      }
      if (ok) {
        cached = { url, at: now() };
        return url;
      }
    }
    return null;
  };
}

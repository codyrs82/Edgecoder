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
  /** How long a "none healthy" result is cached (default 15 s). */
  negativeTtlMs?: number;
  now?: () => number;
}

/**
 * Try each URL in order and cache the first healthy one for `ttlMs` (60 s).
 * When none is healthy, cache that result for `negativeTtlMs` (15 s) so every request
 * doesn't re-probe all URLs serially. Concurrent callers share one in-flight probe.
 */
export function createCoordinatorPicker(opts: PickerOptions): () => Promise<string | null> {
  const ttl = opts.ttlMs ?? 60_000;
  const negTtl = opts.negativeTtlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  let cached: { url: string | null; at: number } | null = null;
  let inFlight: Promise<string | null> | null = null;
  const probeAll = async (): Promise<string | null> => {
    for (const url of opts.urls) {
      let ok = false;
      try {
        ok = await opts.probe(url);
      } catch {
        ok = false;
      }
      if (ok) return url;
    }
    return null;
  };
  return async () => {
    if (cached && now() - cached.at < (cached.url ? ttl : negTtl)) return cached.url;
    if (!inFlight) {
      inFlight = probeAll()
        .then((url) => {
          cached = { url, at: now() };
          return url;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}

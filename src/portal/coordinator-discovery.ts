// #35: the portal's coordinator list comes from config, with a fallback to the EU seed.
// COORDINATOR_DISCOVERY_URLS is a comma list; the legacy single COORDINATOR_DISCOVERY_URL
// is still honoured.

import { createDiscoveringSelector, type FetchLike } from "../discovery/index.js";
import { discoveryDomainsFromEnv } from "../discovery/dns.js";
import { nostrRelaysFromEnv } from "../discovery/nostr.js";

export const DEFAULT_DISCOVERY_URL = "https://coordinator.edgecoder.io";

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

export type PickerMode = "ordered" | "selector";

/** PORTAL_DISCOVERY=selector switches the picker to the scored selector; anything else keeps the ordered list. */
export function pickerModeFromEnv(env: NodeJS.ProcessEnv = process.env): PickerMode {
  return (env.PORTAL_DISCOVERY ?? "").trim().toLowerCase() === "selector" ? "selector" : "ordered";
}

/** PORTAL_DISCOVERY_SOURCES: comma list of static, dns, nostr (default: static only). */
export function pickerSourcesFromEnv(env: NodeJS.ProcessEnv = process.env): { dns: boolean; nostr: boolean } {
  const raw = (env.PORTAL_DISCOVERY_SOURCES ?? "static").toLowerCase();
  const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return { dns: set.has("dns"), nostr: set.has("nostr") };
}

export interface SelectorPickerOptions {
  /** Headers sent to /capacity and /economy/market/book (x-mesh-token / x-portal-service-token). */
  meshToken?: string;
  portalToken?: string;
  computeClass?: string;
  /** Switch coordinators only when a candidate scores better by this fraction (default 0.2). */
  stickinessMargin?: number;
  /** Per-probe timeout (default 3 s). */
  timeoutMs?: number;
  /** Extra sources beyond the static list. Default from PORTAL_DISCOVERY_SOURCES (static only). */
  dns?: boolean;
  nostr?: boolean;
  fetch?: FetchLike;
}

export interface PickerOptions {
  urls: string[];
  /** Resolves true when `url` is healthy. Must apply its own timeout. Used by the ordered picker. */
  probe: (url: string) => Promise<boolean>;
  ttlMs?: number;
  /** How long a "none healthy" result is cached (default 15 s). */
  negativeTtlMs?: number;
  now?: () => number;
  /** Default: `pickerModeFromEnv(env)`, i.e. the ordered list unless PORTAL_DISCOVERY=selector. */
  mode?: PickerMode;
  env?: NodeJS.ProcessEnv;
  selector?: SelectorPickerOptions;
}

/**
 * Try each URL in order and cache the first healthy one for `ttlMs` (60 s).
 * When none is healthy, cache that result for `negativeTtlMs` (15 s) so every request
 * doesn't re-probe all URLs serially. Concurrent callers share one in-flight probe.
 */
export function createCoordinatorPicker(opts: PickerOptions): () => Promise<string | null> {
  const mode = opts.mode ?? pickerModeFromEnv(opts.env);
  if (mode === "selector") return createSelectorCoordinatorPicker(opts);
  return createOrderedCoordinatorPicker(opts);
}

/**
 * Scored picker (architecture step 3): probes every candidate in parallel, scores health,
 * latency, queue depth vs capacity, market price and key pins, caches the ranking for `ttlMs`
 * and keeps the current coordinator unless another wins by `stickinessMargin`. Static URLs are
 * always candidates; DNS and Nostr sources are added when enabled (PORTAL_DISCOVERY_SOURCES).
 */
export function createSelectorCoordinatorPicker(opts: PickerOptions): () => Promise<string | null> {
  const env = opts.env ?? process.env;
  const sel = opts.selector ?? {};
  const sources = pickerSourcesFromEnv(env);
  const useDns = sel.dns ?? sources.dns;
  const useNostr = sel.nostr ?? sources.nostr;
  const negTtl = opts.negativeTtlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const discovering = createDiscoveringSelector({
    staticUrls: opts.urls,
    domain: useDns ? discoveryDomainsFromEnv(env) : false,
    relays: useNostr ? nostrRelaysFromEnv(env) : false,
    expandPeers: useDns || useNostr,
    meshToken: sel.meshToken,
    portalToken: sel.portalToken,
    computeClass: sel.computeClass,
    stickinessMargin: sel.stickinessMargin,
    timeoutMs: sel.timeoutMs ?? 3000,
    ttlMs: opts.ttlMs ?? 60_000,
    fetch: sel.fetch,
    now
  });
  let current: string | null = null;
  let lastEmptyAt: number | null = null;
  let inFlight: Promise<string | null> | null = null;
  return async () => {
    if (lastEmptyAt !== null && now() - lastEmptyAt < negTtl) return null;
    if (!inFlight) {
      inFlight = discovering
        .select(current ?? undefined)
        .then((picked) => {
          if (picked) {
            current = picked.url;
            lastEmptyAt = null;
          } else {
            discovering.selector.invalidate();
            lastEmptyAt = now();
          }
          return picked?.url ?? null;
        })
        .catch(() => null)
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}

/** The #35 ordered picker: first healthy URL in order, cached for `ttlMs`. */
export function createOrderedCoordinatorPicker(opts: PickerOptions): () => Promise<string | null> {
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

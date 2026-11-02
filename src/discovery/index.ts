// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Coordinator discovery entry points: merge static, DNS and Nostr sources, then rank with the
// selector. Agents and portals call `selectCoordinator` (or `selectCoordinatorFromEnv`) instead
// of trusting a single hard-coded URL.

import { resolveDnsSeeds, discoveryDomainsFromEnv, type DnsResolver } from "./dns.js";
import { fetchNostrAnnouncements, nostrRelaysFromEnv, type WsConnect } from "./nostr.js";
import { applyStickiness, createCoordinatorSelector, rankCoordinators, type CoordinatorSelector, type FetchLike, type RankedCoordinator, type SelectorOptions } from "./selector.js";
import { candidateFromAnnouncement, mergeCandidates, normalizeCoordinatorUrl, parseAnnouncement, verifyAnnouncement, type CoordinatorCandidate } from "./types.js";

export * from "./types.js";
export * from "./dns.js";
export * from "./nostr.js";
export * from "./selector.js";

export interface DiscoverOptions {
  /** Operator-configured URLs (COORDINATOR_DISCOVERY_URLS / COORDINATOR_BOOTSTRAP_URLS). */
  staticUrls?: string[];
  /** DNS domain(s); `false` disables DNS. Default edgecoder.io. */
  domain?: string | string[] | false;
  /** Nostr relays; `false` or an empty list disables Nostr. */
  relays?: string[] | false;
  /** Only accept Nostr events from these pubkeys (hex). */
  nostrAuthors?: string[];
  /** The coordinator currently in use; always included as a candidate. */
  currentUrl?: string;
  /** Ask each discovered coordinator for /discovery/peers (one hop). Default true. */
  expandPeers?: boolean;
  /** Cap on the merged candidate list (default 32). */
  maxCandidates?: number;
  timeoutMs?: number;
  resolver?: DnsResolver;
  connect?: WsConnect;
  fetch?: FetchLike;
  now?: () => number;
}

export function parseStaticUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = [env.COORDINATOR_DISCOVERY_URLS, env.COORDINATOR_BOOTSTRAP_URLS, env.COORDINATOR_DISCOVERY_URL]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(",");
  const urls = raw
    .split(",")
    .map((s) => normalizeCoordinatorUrl(s))
    .filter((u): u is string => Boolean(u));
  return [...new Set(urls)];
}

async function fetchPeerAnnouncements(url: string, fetchImpl: FetchLike, timeoutMs: number, now: () => number): Promise<CoordinatorCandidate[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/discovery/peers`, { method: "GET", headers: {}, signal: ctl.signal });
    if (res.status < 200 || res.status >= 300) return [];
    const body = (await res.json()) as { peers?: unknown };
    if (!Array.isArray(body?.peers)) return [];
    const out: CoordinatorCandidate[] = [];
    for (const raw of body.peers.slice(0, 64)) {
      const a = parseAnnouncement(raw);
      if (!a || !verifyAnnouncement(a, { now }).ok) continue;
      const c = candidateFromAnnouncement(a, "peer");
      if (c) out.push(c);
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Gather candidates from every enabled source and merge them (de-duplicated by peerId/url). */
export async function discoverCoordinators(opts: DiscoverOptions = {}): Promise<CoordinatorCandidate[]> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);

  const current: CoordinatorCandidate[] = [];
  if (opts.currentUrl) {
    const u = normalizeCoordinatorUrl(opts.currentUrl);
    if (u) current.push({ url: u, source: "current" });
  }
  const statics: CoordinatorCandidate[] = (opts.staticUrls ?? [])
    .map((u) => normalizeCoordinatorUrl(u))
    .filter((u): u is string => Boolean(u))
    .map((url) => ({ url, source: "static" as const }));

  const dnsPromise: Promise<CoordinatorCandidate[]> =
    opts.domain === false ? Promise.resolve([]) : resolveDnsSeeds({ domain: opts.domain, resolver: opts.resolver, timeoutMs }).catch(() => []);
  const relays = opts.relays === false ? [] : opts.relays ?? nostrRelaysFromEnv();
  const nostrPromise: Promise<CoordinatorCandidate[]> =
    relays.length === 0
      ? Promise.resolve([])
      : fetchNostrAnnouncements({ relays, timeoutMs, connect: opts.connect, authors: opts.nostrAuthors, verify: { now } })
          .then((list) => list.map((a) => candidateFromAnnouncement(a, "nostr")).filter((c): c is CoordinatorCandidate => Boolean(c)))
          .catch(() => []);
  const [fromDns, fromNostr] = await Promise.all([dnsPromise, nostrPromise]);

  let merged = mergeCandidates(current, statics, fromDns, fromNostr);
  if (opts.expandPeers !== false && merged.length > 0) {
    const seeds = merged.filter((c) => c.source !== "nostr").slice(0, 8);
    const peerLists = await Promise.all(seeds.map((c) => fetchPeerAnnouncements(c.url, fetchImpl, timeoutMs, now)));
    merged = mergeCandidates(merged, ...peerLists);
  }
  return merged.slice(0, opts.maxCandidates ?? 32);
}

export type SelectOptions = DiscoverOptions &
  Omit<SelectorOptions, "candidates"> & {
    stickinessMargin?: number;
    /** Drop candidates before ranking (strict trust mode: only coordinators whose key is listed). */
    acceptCandidate?: (c: CoordinatorCandidate) => boolean;
  };

/** Discover, rank and pick one coordinator (stickiness against `currentUrl`). Null when none is healthy. */
export async function selectCoordinator(opts: SelectOptions = {}): Promise<RankedCoordinator | null> {
  const accept = opts.acceptCandidate;
  const candidates = (await discoverCoordinators(opts)).filter((c) => !accept || accept(c));
  if (candidates.length === 0) return null;
  const ranked = await rankCoordinators({ ...opts, candidates });
  return applyStickiness(ranked, opts.currentUrl, opts.stickinessMargin);
}

export interface EnvDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  currentUrl?: string;
  meshToken?: string;
  portalToken?: string;
  computeClass?: string;
  fetch?: FetchLike;
  resolver?: DnsResolver;
  connect?: WsConnect;
  now?: () => number;
  acceptCandidate?: (c: CoordinatorCandidate) => boolean;
}

/**
 * Build options from the environment:
 *   COORDINATOR_DISCOVERY_URLS / COORDINATOR_BOOTSTRAP_URLS  static seeds
 *   EDGECODER_DISCOVERY_DOMAIN (default edgecoder.io; "off" disables DNS)
 *   EDGECODER_NOSTR_RELAYS (comma list; "off" disables Nostr)
 *   EDGECODER_NOSTR_AUTHORS (comma list of trusted relay pubkeys, optional)
 *   EDGECODER_COORDINATOR_PINS (comma list of PEM fingerprints or peerIds)
 *   EDGECODER_DISCOVERY_TIMEOUT_MS, EDGECODER_DISCOVERY_MARGIN (fraction, default 0.2)
 */
export function selectOptionsFromEnv(o: EnvDiscoveryOptions = {}): SelectOptions {
  const env = o.env ?? process.env;
  const domainRaw = (env.EDGECODER_DISCOVERY_DOMAIN ?? "").trim().toLowerCase();
  const relaysRaw = (env.EDGECODER_NOSTR_RELAYS ?? "").trim().toLowerCase();
  const pins = (env.EDGECODER_COORDINATOR_PINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const authors = (env.EDGECODER_NOSTR_AUTHORS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
  const timeoutMs = Number(env.EDGECODER_DISCOVERY_TIMEOUT_MS ?? "4000");
  const margin = Number(env.EDGECODER_DISCOVERY_MARGIN ?? "0.2");
  return {
    staticUrls: parseStaticUrls(env),
    domain: domainRaw === "off" || domainRaw === "0" || domainRaw === "false" ? false : discoveryDomainsFromEnv(env),
    relays: relaysRaw === "off" || relaysRaw === "0" || relaysRaw === "false" ? false : nostrRelaysFromEnv(env),
    nostrAuthors: authors.length > 0 ? authors : undefined,
    currentUrl: o.currentUrl,
    meshToken: o.meshToken,
    portalToken: o.portalToken,
    computeClass: o.computeClass ?? env.EDGECODER_COMPUTE_CLASS,
    pinnedKeys: pins.filter((p) => /^[0-9a-f]{64}$/i.test(p) || p.includes("BEGIN")),
    pinnedPeerIds: pins.filter((p) => !/^[0-9a-f]{64}$/i.test(p) && !p.includes("BEGIN")),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 100 ? timeoutMs : 4000,
    stickinessMargin: Number.isFinite(margin) && margin >= 0 ? margin : 0.2,
    fetch: o.fetch,
    resolver: o.resolver,
    connect: o.connect,
    now: o.now,
    acceptCandidate: o.acceptCandidate
  };
}

/** One-shot selection driven by the environment; never throws (returns null on any failure). */
export async function selectCoordinatorFromEnv(o: EnvDiscoveryOptions = {}): Promise<RankedCoordinator | null> {
  try {
    return await selectCoordinator(selectOptionsFromEnv(o));
  } catch {
    return null;
  }
}

/** Long-lived selector (60 s cache + stickiness) that re-discovers candidates on each call. */
export function createDiscoveringSelector(base: SelectOptions & { ttlMs?: number } = {}): {
  selector: CoordinatorSelector;
  select(currentUrl?: string): Promise<RankedCoordinator | null>;
} {
  const selector = createCoordinatorSelector(base);
  let lastCandidates: { at: number; list: CoordinatorCandidate[] } | null = null;
  const now = base.now ?? Date.now;
  const ttl = base.ttlMs ?? 60_000;
  return {
    selector,
    async select(currentUrl) {
      if (!lastCandidates || now() - lastCandidates.at >= ttl) {
        const list = await discoverCoordinators({ ...base, currentUrl: currentUrl ?? base.currentUrl });
        lastCandidates = { at: now(), list };
      }
      return selector.select(lastCandidates.list, currentUrl);
    }
  };
}

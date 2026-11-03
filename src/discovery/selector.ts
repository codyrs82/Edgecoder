// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Coordinator selector: probe candidates in parallel, score them, rank them, and keep the
// current coordinator unless a better one wins by a margin. Pure: fetch and clock are injectable.

import type { CoordinatorCandidate, CandidateSource } from "./types.js";
import { pinMatchesKey } from "./types.js";
import { normalizeComputeClass } from "../economy/compute-classes.js";

export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponseLike>;

export interface ScoreWeights {
  latency: number;
  load: number;
  price: number;
  pinned: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { latency: 0.35, load: 0.3, price: 0.2, pinned: 0.15 };

export interface SelectorOptions {
  candidates: CoordinatorCandidate[];
  fetch?: FetchLike;
  now?: () => number;
  /** Per-request timeout (default 3 s). */
  timeoutMs?: number;
  /** Compute class whose market price is scored (default cpu). A legacy id (gpu.c8, ...) is sent as-is; new coordinators map it. */
  computeClass?: string;
  /** Sent as x-mesh-token to /capacity and /economy/market/book when set. */
  meshToken?: string;
  /** Sent as x-portal-service-token to /economy/market/book when set. */
  portalToken?: string;
  /** Operator-pinned coordinator public keys (PEM or sha256 fingerprint) or peerIds. */
  pinnedKeys?: string[];
  pinnedPeerIds?: string[];
  weights?: Partial<ScoreWeights>;
  /** Latency at or above which the latency component scores 0 (default 2000 ms). */
  latencyCeilingMs?: number;
}

export interface RankedCoordinator {
  url: string;
  peerId?: string;
  region?: string;
  source: CandidateSource;
  healthy: boolean;
  latencyMs: number | null;
  queued: number | null;
  capacity: number | null;
  agents: number | null;
  priceMsatPerCredit: number | null;
  pinned: boolean;
  /** 0..1; 0 when unhealthy. */
  score: number;
  components: { latency: number; load: number; price: number; pinned: number };
  error?: string;
}

interface Probe {
  healthy: boolean;
  latencyMs: number | null;
  queued: number | null;
  agents: number | null;
  capacity: number | null;
  priceMsatPerCredit: number | null;
  error?: string;
}

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: ctl.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one coordinator: /health/runtime (latency + health), /capacity, /economy/market/book. */
export async function probeCoordinator(url: string, opts: Omit<SelectorOptions, "candidates">): Promise<Probe> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const base = url.replace(/\/+$/, "");
  const tokenHeaders: Record<string, string> = {};
  if (opts.meshToken) tokenHeaders["x-mesh-token"] = opts.meshToken;
  if (opts.portalToken) tokenHeaders["x-portal-service-token"] = opts.portalToken;

  const started = now();
  const health = await getJson(fetchImpl, `${base}/health/runtime`, {}, timeoutMs);
  const latencyMs = now() - started;
  if (!health || health.status < 200 || health.status >= 300) {
    return { healthy: false, latencyMs: health ? latencyMs : null, queued: null, agents: null, capacity: null, priceMsatPerCredit: null, error: health ? `health_${health.status}` : "unreachable" };
  }
  const hb = (health.body ?? {}) as { ok?: unknown; coordinator?: { queued?: unknown; agents?: unknown } };
  if (hb.ok === false) {
    return { healthy: false, latencyMs, queued: null, agents: null, capacity: null, priceMsatPerCredit: null, error: "health_not_ok" };
  }
  let queued = asNumber(hb.coordinator?.queued);
  let agents = asNumber(hb.coordinator?.agents);

  const [capacity, book] = await Promise.all([
    getJson(fetchImpl, `${base}/capacity`, tokenHeaders, timeoutMs),
    opts.meshToken || opts.portalToken
      ? getJson(fetchImpl, `${base}/economy/market/book?computeClass=${encodeURIComponent(opts.computeClass ?? "cpu")}`, tokenHeaders, timeoutMs)
      : Promise.resolve(null)
  ]);

  let totalCapacity: number | null = null;
  if (capacity && capacity.status >= 200 && capacity.status < 300) {
    const cb = (capacity.body ?? {}) as { totals?: { totalCapacity?: unknown; agentsConnected?: unknown } };
    totalCapacity = asNumber(cb.totals?.totalCapacity);
    agents ??= asNumber(cb.totals?.agentsConnected);
  }
  queued ??= null;

  let price: number | null = null;
  if (book && book.status >= 200 && book.status < 300) {
    const bb = (book.body ?? {}) as { books?: Array<{ computeClass?: unknown; clearingMsatPerCredit?: unknown; midMsatPerCredit?: unknown; referenceMsatPerCredit?: unknown }> };
    const wanted = opts.computeClass ?? "cpu";
    // A new coordinator answers a legacy id with the mapped class, so compare on the current class.
    const target = normalizeComputeClass(wanted) ?? wanted;
    const entry = (bb.books ?? []).find((b) => b.computeClass === wanted) ?? (bb.books ?? []).find((b) => typeof b.computeClass === "string" && normalizeComputeClass(b.computeClass) === target) ?? bb.books?.[0];
    if (entry) price = asNumber(entry.clearingMsatPerCredit) ?? asNumber(entry.midMsatPerCredit) ?? asNumber(entry.referenceMsatPerCredit);
  }
  return { healthy: true, latencyMs, queued, agents, capacity: totalCapacity, priceMsatPerCredit: price };
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Probe every candidate in parallel, score, and return the list sorted best-first. */
export async function rankCoordinators(opts: SelectorOptions): Promise<RankedCoordinator[]> {
  const weights: ScoreWeights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const ceiling = opts.latencyCeilingMs ?? 2000;
  const pins = (opts.pinnedKeys ?? []).map((p) => p.trim()).filter(Boolean);
  const pinnedPeers = new Set((opts.pinnedPeerIds ?? []).map((p) => p.trim()).filter(Boolean));
  const pinsConfigured = pins.length > 0 || pinnedPeers.size > 0;

  const probes = await Promise.all(opts.candidates.map((c) => probeCoordinator(c.url, opts)));
  const healthyPrices = probes.filter((p) => p.healthy && p.priceMsatPerCredit !== null && p.priceMsatPerCredit > 0).map((p) => p.priceMsatPerCredit as number);
  const cheapest = healthyPrices.length > 0 ? Math.min(...healthyPrices) : null;

  const ranked = opts.candidates.map((c, i): RankedCoordinator => {
    const p = probes[i];
    const pinned =
      (c.peerId !== undefined && pinnedPeers.has(c.peerId)) || (c.publicKeyPem !== undefined && pins.some((pin) => pinMatchesKey(pin, c.publicKeyPem as string)));
    const latency = p.latencyMs === null ? 0 : clamp01(1 - p.latencyMs / ceiling);
    // Queue depth vs capacity. Without a token /capacity is unauthorized, so the agent count from
    // /health/runtime stands in for capacity (each agent runs at least one task).
    const effectiveCapacity = p.capacity !== null ? p.capacity : p.agents;
    let load: number;
    if (effectiveCapacity !== null && effectiveCapacity > 0) load = clamp01(1 - (p.queued ?? 0) / effectiveCapacity);
    else if (effectiveCapacity === 0) load = (p.queued ?? 0) > 0 ? 0 : 0.25;
    else load = 0.5; // nothing known: neutral
    let price: number;
    if (cheapest !== null && p.priceMsatPerCredit !== null && p.priceMsatPerCredit > 0) price = clamp01(cheapest / p.priceMsatPerCredit);
    else price = 0.5;
    const pinnedScore = pinned ? 1 : 0;
    // When no pins are configured the pinned component is dropped and the rest is renormalized.
    const active = pinsConfigured ? weights : { ...weights, pinned: 0 };
    const total = active.latency + active.load + active.price + active.pinned;
    const raw = total > 0 ? (active.latency * latency + active.load * load + active.price * price + active.pinned * pinnedScore) / total : 0;
    const score = p.healthy ? Number(raw.toFixed(4)) : 0;
    return {
      url: c.url,
      peerId: c.peerId,
      region: c.region,
      source: c.source,
      healthy: p.healthy,
      latencyMs: p.latencyMs,
      queued: p.queued,
      capacity: p.capacity,
      agents: p.agents,
      priceMsatPerCredit: p.priceMsatPerCredit,
      pinned,
      score,
      components: { latency, load, price, pinned: pinnedScore },
      error: p.error
    };
  });
  return ranked.sort((a, b) => b.score - a.score || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
}

/**
 * Stickiness: keep `currentUrl` while it is healthy unless the best candidate beats it by
 * more than `margin` (fraction, default 0.2 = 20%). Returns null when nothing is healthy.
 */
export function applyStickiness(ranked: RankedCoordinator[], currentUrl: string | undefined, margin = 0.2): RankedCoordinator | null {
  const best = ranked.find((r) => r.healthy) ?? null;
  if (!best) return null;
  if (!currentUrl) return best;
  const normalized = currentUrl.replace(/\/+$/, "");
  const current = ranked.find((r) => r.healthy && r.url === normalized);
  if (!current) return best;
  if (best.url === current.url) return current;
  return best.score > current.score * (1 + margin) ? best : current;
}

export interface SelectorCacheOptions extends Omit<SelectorOptions, "candidates"> {
  /** How long a ranking is reused (default 60 s). */
  ttlMs?: number;
  /** Stickiness margin (default 0.2). */
  stickinessMargin?: number;
}

export interface CoordinatorSelector {
  /** Rank `candidates` (cached per candidate set for ttlMs; concurrent callers share one probe). */
  rank(candidates: CoordinatorCandidate[]): Promise<RankedCoordinator[]>;
  /** Pick the coordinator to use, applying stickiness against `currentUrl` (or the last pick). */
  select(candidates: CoordinatorCandidate[], currentUrl?: string): Promise<RankedCoordinator | null>;
  /** Drop the cache (e.g. after the current coordinator failed). */
  invalidate(): void;
  current(): string | null;
}

export function createCoordinatorSelector(opts: SelectorCacheOptions = {}): CoordinatorSelector {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const margin = opts.stickinessMargin ?? 0.2;
  let cache: { key: string; at: number; ranked: RankedCoordinator[] } | null = null;
  let inFlight: { key: string; promise: Promise<RankedCoordinator[]> } | null = null;
  let currentUrl: string | null = null;
  const keyOf = (candidates: CoordinatorCandidate[]) => [...new Set(candidates.map((c) => c.url))].sort().join("|");
  const rank = async (candidates: CoordinatorCandidate[]): Promise<RankedCoordinator[]> => {
    const key = keyOf(candidates);
    if (cache && cache.key === key && now() - cache.at < ttl) return cache.ranked;
    if (inFlight && inFlight.key === key) return inFlight.promise;
    const promise = rankCoordinators({ ...opts, candidates })
      .then((ranked) => {
        cache = { key, at: now(), ranked };
        return ranked;
      })
      .finally(() => {
        if (inFlight && inFlight.key === key) inFlight = null;
      });
    inFlight = { key, promise };
    return promise;
  };
  return {
    rank,
    async select(candidates, current) {
      const ranked = await rank(candidates);
      const pick = applyStickiness(ranked, current ?? currentUrl ?? undefined, margin);
      currentUrl = pick?.url ?? currentUrl;
      return pick;
    },
    invalidate() {
      cache = null;
    },
    current: () => currentUrl
  };
}

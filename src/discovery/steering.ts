// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// Client-side steering behind the one platform URL (docs/ROADMAP.md, "Global coordinator entry
// points"): fetch the signed registry from coordinator.edgecoder.io (or the portal, or the cache),
// verify it against the pinned registry key, measure /identity round trips to the healthy
// coordinators, check each one's identity key against the registry, and pick the fastest, with
// hysteresis so clients don't flap. When the registry is missing or invalid, or nothing in it is
// usable, the configured URL (the seeds) is used. Steering, not proxying: the client talks to the
// chosen coordinator directly.

import { fingerprintMatches, publicKeyFingerprint } from "../security/key-fingerprint.js";
import { EDGECODER_NETWORK_DOMAIN } from "../trust/seed-keys.js";
import type { FetchLike } from "./selector.js";
import { normalizeCoordinatorUrl } from "./types.js";
import { memberSteerable, memberTrusted, verifySignedRegistry, type RegistryEntry, type RegistryPayload } from "./registry.js";

export interface RegistryCache {
  read(): string | null;
  write(text: string): void;
}

export interface LoadedRegistry {
  registry: RegistryPayload;
  /** The registry URL it came from, or "cache". */
  from: string;
  /** The exact signed document (what the cache stores). */
  raw: string;
}

export interface LoadRegistryOptions {
  /** Registry URLs, tried in order (e.g. https://coordinator.edgecoder.io/network/registry, then the portal's). */
  urls: string[];
  publicKeys: readonly string[];
  fetch?: FetchLike;
  cache?: RegistryCache;
  now?: () => number;
  timeoutMs?: number;
  /** Reject a fetched registry older than this one (replay of an old, still-unexpired document). */
  minIssuedAtMs?: number;
}

export type LoadRegistryResult = { ok: true; loaded: LoadedRegistry; errors: string[] } | { ok: false; errors: string[] };

const MAX_REGISTRY_BYTES = 1_000_000;

async function fetchText(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<{ status: number; text: string } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal });
    const body = await res.json();
    return { status: res.status, text: JSON.stringify(body) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and verify the registry from the first URL that serves a valid one; fall back to the cache
 * (verified again, expiry included). A newer valid registry replaces the cache.
 */
export async function loadRegistry(opts: LoadRegistryOptions): Promise<LoadRegistryResult> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const errors: string[] = [];
  const check = (text: string) => {
    if (text.length > MAX_REGISTRY_BYTES) return { ok: false as const, reason: "too_large" };
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return { ok: false as const, reason: "malformed" };
    }
    return verifySignedRegistry(doc, { publicKeys: opts.publicKeys, now });
  };

  let cached: LoadedRegistry | null = null;
  const cachedText = opts.cache?.read() ?? null;
  if (cachedText) {
    const v = check(cachedText);
    if (v.ok) cached = { registry: v.registry, from: "cache", raw: cachedText };
    else errors.push(`cache: ${v.reason}`);
  }
  const floor = Math.max(opts.minIssuedAtMs ?? 0, cached?.registry.issuedAtMs ?? 0);

  for (const url of opts.urls) {
    const res = await fetchText(fetchImpl, url, timeoutMs);
    if (!res) {
      errors.push(`${url}: unreachable`);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      errors.push(`${url}: http_${res.status}`);
      continue;
    }
    const v = check(res.text);
    if (!v.ok) {
      errors.push(`${url}: ${v.reason}`);
      continue;
    }
    if (v.registry.issuedAtMs < floor) {
      errors.push(`${url}: older_than_known`);
      continue;
    }
    try {
      opts.cache?.write(res.text);
    } catch {
      // a read-only cache is not fatal
    }
    return { ok: true, loaded: { registry: v.registry, from: url, raw: res.text }, errors };
  }
  if (cached) return { ok: true, loaded: cached, errors };
  return { ok: false, errors };
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  /** Median /identity round trip over the successful samples. */
  latencyMs: number | null;
  samples: number;
  /** identity_mismatch (wrong peerId or key), unreachable, http_<status>, malformed. */
  error?: string;
}

/**
 * Probe one coordinator URL of a registry entry: `samples` sequential GET /identity round trips.
 * Every answer must carry the entry's peerId and a key matching its fingerprint; a majority of
 * the samples must succeed.
 */
export async function probeRegistryEntry(
  entry: Pick<RegistryEntry, "peerId" | "publicKeyFingerprint">,
  url: string,
  opts: { fetch?: FetchLike; now?: () => number; samples?: number; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  const samples = Math.max(1, Math.min(10, opts.samples ?? 3));
  const timeoutMs = opts.timeoutMs ?? 3000;
  const base = url.replace(/\/+$/, "");
  const times: number[] = [];
  let lastError: string | undefined;
  for (let i = 0; i < samples; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const started = now();
    try {
      const res = await fetchImpl(`${base}/identity`, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal });
      const body = (await res.json().catch(() => null)) as { peerId?: unknown; publicKeyPem?: unknown; draining?: unknown } | null;
      const elapsed = now() - started;
      if (res.status < 200 || res.status >= 300) {
        lastError = `http_${res.status}`;
        continue;
      }
      if (!body || typeof body.peerId !== "string" || typeof body.publicKeyPem !== "string") {
        lastError = "malformed";
        continue;
      }
      // Stopping for a deploy or restart (#524): not a coordinator to move to now; another one is
      // picked, and the next steering round comes back to it once it is up.
      if (body.draining === true) {
        clearTimeout(timer);
        return { url: base, ok: false, latencyMs: null, samples: times.length, error: "draining" };
      }
      // A wrong key is an impersonation attempt, not a slow sample: disqualify immediately.
      if (body.peerId !== entry.peerId || !fingerprintMatches(entry.publicKeyFingerprint, body.publicKeyPem)) {
        return { url: base, ok: false, latencyMs: null, samples: times.length, error: "identity_mismatch" };
      }
      times.push(elapsed);
    } catch {
      lastError = "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }
  if (times.length * 2 <= samples) {
    return { url: base, ok: false, latencyMs: null, samples: times.length, error: lastError ?? "unreachable" };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { url: base, ok: true, latencyMs: Math.round(median), samples: times.length };
}

export interface MeasuredCandidate {
  entry: RegistryEntry;
  url: string;
  latencyMs: number;
}

export interface Hysteresis {
  /** Keep the current coordinator unless the best is faster by more than this fraction (default 0.25). */
  ratio: number;
  /** ... and by more than this many ms (default 25), so tiny absolute gaps never cause a switch. */
  minGainMs: number;
}

export const DEFAULT_HYSTERESIS: Hysteresis = { ratio: 0.25, minGainMs: 25 };

/**
 * Pure choice: the lowest-latency verified candidate, except that the current coordinator is kept
 * while it is still a verified candidate and the best one does not beat it by both margins.
 */
export function chooseCandidate(
  candidates: MeasuredCandidate[],
  current: { peerId?: string; url?: string } | null,
  hysteresis: Hysteresis = DEFAULT_HYSTERESIS
): { pick: MeasuredCandidate; kept: boolean } | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => a.latencyMs - b.latencyMs || a.entry.peerId.localeCompare(b.entry.peerId));
  const best = sorted[0];
  if (!current || (!current.peerId && !current.url)) return { pick: best, kept: false };
  const curUrl = current.url ? normalizeCoordinatorUrl(current.url) : null;
  // Same peer at the same URL first, then the same peer at another of its URLs.
  const mine =
    sorted.find((c) => (current.peerId ? c.entry.peerId === current.peerId && (!curUrl || c.url === curUrl) : c.url === curUrl)) ??
    (current.peerId ? sorted.find((c) => c.entry.peerId === current.peerId) : undefined);
  if (!mine) return { pick: best, kept: false };
  if (mine === best) return { pick: mine, kept: true };
  const gain = mine.latencyMs - best.latencyMs;
  const switchWorth = best.latencyMs < mine.latencyMs / (1 + hysteresis.ratio) && gain > hysteresis.minGainMs;
  return switchWorth ? { pick: best, kept: false } : { pick: mine, kept: true };
}

export interface SteeringResult {
  url: string;
  /**
   * registry: chosen from the signed registry; configured: the operator's own COORDINATOR_URL,
   * kept because it answered and is trusted; fallback: the configured URL, steering found nothing.
   */
  source: "registry" | "configured" | "fallback";
  peerId?: string;
  publicKeyFingerprint?: string;
  region?: string;
  latencyMs?: number;
  operator?: RegistryEntry["operator"];
  /** True when hysteresis kept the previous pick. */
  kept?: boolean;
  /** Why the fallback was used, or "" for a registry pick. */
  reason: string;
  /** With `configuredUrl`: that coordinator and why it was not kept (unreachable, not trusted, draining). */
  configuredProblem?: { url: string; problem: string };
  registry?: { issuedAtMs: number; expiresAtMs: number; from: string; coordinators: number; healthy: number; verified: number };
  decidedAtMs: number;
}

export interface SteeringOptions {
  registryUrls: string[];
  publicKeys: readonly string[];
  /** The configured coordinator URL (coordinator.edgecoder.io, i.e. the seeds). */
  fallbackUrl: string;
  fetch?: FetchLike;
  cache?: RegistryCache;
  now?: () => number;
  samples?: number;
  timeoutMs?: number;
  hysteresis?: Partial<Hysteresis>;
  /** Most entries probed per round (default 16). */
  maxProbes?: number;
  /**
   * Also steer to active community (outside) coordinators. Off: only EdgeCoder's own active
   * coordinators are picked, as long as outside coordinators cannot bill (docs/discovery.md).
   */
  includeOutside?: boolean;
  /**
   * A coordinator the operator chose explicitly (COORDINATOR_URL other than the platform URL).
   * Steering keeps it while it answers /identity and is trusted: listed in the verified registry
   * with that key, or accepted by `trustsConfigured` (the agent's own allowlist). Only when it is
   * unreachable or not trusted does steering pick from the registry instead.
   */
  configuredUrl?: string;
  /** Whether the agent's trust settings accept this key (not consulted for a registry-listed peer). */
  trustsConfigured?: (peerId: string, publicKeyPem: string) => boolean;
}

/** The platform URL every default install points at (DEFAULT_COORDINATOR_URL); steering is free to move agents off it. */
export const PLATFORM_COORDINATOR_URL = `https://coordinator.${EDGECODER_NETWORK_DOMAIN}`;

/**
 * The operator's explicitly configured coordinator, or null for a default install: unset, the
 * platform URL (installer and desktop default), or a loopback coordinator (steering is off there).
 */
export function explicitCoordinatorUrl(configured: string | undefined | null): string | null {
  const url = configured ? normalizeCoordinatorUrl(configured) : null;
  if (!url) return null;
  if (url === normalizeCoordinatorUrl(PLATFORM_COORDINATOR_URL)) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.")) return null;
  } catch {
    return null;
  }
  return url;
}

type ConfiguredCheck =
  | { ok: true; url: string; peerId: string; publicKeyFingerprint: string; latencyMs: number }
  | { ok: false; url: string; problem: string };

/** One /identity round trip to the configured coordinator, judged against the registry and the allowlist. */
async function checkConfigured(
  url: string,
  registry: RegistryPayload | null,
  opts: Pick<SteeringOptions, "fetch" | "now" | "timeoutMs" | "trustsConfigured">
): Promise<ConfiguredCheck> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 3000);
  const started = now();
  let body: { peerId?: unknown; publicKeyPem?: unknown; draining?: unknown } | null;
  try {
    const res = await fetchImpl(`${url}/identity`, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal });
    body = (await res.json().catch(() => null)) as typeof body;
    if (res.status < 200 || res.status >= 300) return { ok: false, url, problem: `unreachable (http_${res.status})` };
  } catch {
    return { ok: false, url, problem: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = now() - started;
  if (!body || typeof body.peerId !== "string" || typeof body.publicKeyPem !== "string") return { ok: false, url, problem: "unreachable (malformed identity)" };
  if (body.draining === true) return { ok: false, url, problem: "draining" };
  const peerId = body.peerId;
  const pem = body.publicKeyPem;
  const listed = registry?.coordinators.find((c) => c.peerId === peerId);
  if (listed) {
    // The registry speaks for this peer: its key must match, and a suspended member is not trusted.
    if (!fingerprintMatches(listed.publicKeyFingerprint, pem)) return { ok: false, url, problem: "not trusted (identity_mismatch with the registry)" };
    if (!memberTrusted(listed)) return { ok: false, url, problem: "not trusted (suspended in the registry)" };
    return { ok: true, url, peerId, publicKeyFingerprint: listed.publicKeyFingerprint, latencyMs };
  }
  if (opts.trustsConfigured?.(peerId, pem)) return { ok: true, url, peerId, publicKeyFingerprint: publicKeyFingerprint(pem), latencyMs };
  return { ok: false, url, problem: "not trusted (not in the registry and not allowlisted)" };
}

export interface CoordinatorSteering {
  /** Run one round: load + verify the registry, probe, choose. Never throws. */
  steer(): Promise<SteeringResult>;
  /** The last result (null before the first round). */
  last(): SteeringResult | null;
  /** Peer → fingerprint for every entry in the last verified registry (for the trust store). */
  trustedEntries(): Map<string, string>;
  /** Forget the current pick (e.g. after it failed), so the next round chooses afresh. */
  forgetCurrent(): void;
}

export function createCoordinatorSteering(opts: SteeringOptions): CoordinatorSteering {
  const now = opts.now ?? Date.now;
  const hysteresis: Hysteresis = { ...DEFAULT_HYSTERESIS, ...opts.hysteresis };
  let last: SteeringResult | null = null;
  let current: { peerId: string; url: string } | null = null;
  let highestIssuedAt = 0;
  let entries = new Map<string, string>();

  const fallback = (reason: string, registry?: SteeringResult["registry"]): SteeringResult => ({
    url: normalizeCoordinatorUrl(opts.fallbackUrl) ?? opts.fallbackUrl,
    source: "fallback",
    reason,
    registry,
    decidedAtMs: now()
  });

  const configuredUrl = opts.configuredUrl ? normalizeCoordinatorUrl(opts.configuredUrl) : null;
  const keepConfigured = (c: Extract<ConfiguredCheck, { ok: true }>, registry?: SteeringResult["registry"]): SteeringResult => {
    current = null;
    return {
      url: c.url,
      source: "configured",
      peerId: c.peerId,
      publicKeyFingerprint: c.publicKeyFingerprint,
      latencyMs: c.latencyMs,
      reason: "",
      registry,
      decidedAtMs: now()
    };
  };

  const steer = async (): Promise<SteeringResult> => {
    try {
      if (opts.publicKeys.length === 0) {
        if (configuredUrl) {
          const c = await checkConfigured(configuredUrl, null, opts);
          if (c.ok) return (last = keepConfigured(c));
        }
        return (last = fallback("no_registry_key"));
      }
      const loaded = await loadRegistry({
        urls: opts.registryUrls,
        publicKeys: opts.publicKeys,
        fetch: opts.fetch,
        cache: opts.cache,
        now,
        timeoutMs: opts.timeoutMs,
        minIssuedAtMs: highestIssuedAt
      });
      if (!loaded.ok) {
        const reason = `registry_unavailable: ${loaded.errors.join("; ").slice(0, 300)}`;
        if (configuredUrl) {
          const c = await checkConfigured(configuredUrl, null, opts);
          if (c.ok) return (last = keepConfigured(c));
          return (last = { ...fallback(reason), configuredProblem: { url: c.url, problem: c.problem } });
        }
        return (last = fallback(reason));
      }
      const reg = loaded.loaded.registry;
      highestIssuedAt = Math.max(highestIssuedAt, reg.issuedAtMs);
      // Suspended members are listed so peers drop them; they are never trusted or picked.
      entries = new Map(reg.coordinators.filter((c) => memberTrusted(c)).map((c) => [c.peerId, c.publicKeyFingerprint]));
      let configuredProblem: SteeringResult["configuredProblem"];
      if (configuredUrl) {
        const c = await checkConfigured(configuredUrl, reg, opts);
        if (c.ok) {
          return (last = keepConfigured(c, {
            issuedAtMs: reg.issuedAtMs,
            expiresAtMs: reg.expiresAtMs,
            from: loaded.loaded.from,
            coordinators: reg.coordinators.length,
            healthy: reg.coordinators.filter((e) => e.health.status === "healthy").length,
            verified: 0
          }));
        }
        configuredProblem = { url: c.url, problem: c.problem };
      }
      const healthy = reg.coordinators.filter((c) => c.health.status === "healthy" && memberSteerable(c, opts.includeOutside === true));
      const pairs: Array<{ entry: RegistryEntry; url: string }> = [];
      for (const entry of healthy) {
        for (const raw of entry.urls.slice(0, 2)) {
          const url = normalizeCoordinatorUrl(raw);
          if (url) pairs.push({ entry, url });
        }
      }
      const probed = pairs.slice(0, opts.maxProbes ?? 16);
      const results = await Promise.all(
        probed.map((p) => probeRegistryEntry(p.entry, p.url, { fetch: opts.fetch, now, samples: opts.samples, timeoutMs: opts.timeoutMs }))
      );
      const measured: MeasuredCandidate[] = [];
      results.forEach((r, i) => {
        if (r.ok && r.latencyMs !== null) measured.push({ entry: probed[i].entry, url: probed[i].url, latencyMs: r.latencyMs });
      });
      const summary = {
        issuedAtMs: reg.issuedAtMs,
        expiresAtMs: reg.expiresAtMs,
        from: loaded.loaded.from,
        coordinators: reg.coordinators.length,
        healthy: healthy.length,
        verified: new Set(measured.map((m) => m.entry.peerId)).size
      };
      const choice = chooseCandidate(measured, current, hysteresis);
      if (!choice) return (last = { ...fallback(healthy.length === 0 ? "no_healthy_coordinators" : "no_verified_coordinators", summary), configuredProblem });
      const { pick, kept } = choice;
      current = { peerId: pick.entry.peerId, url: pick.url };
      return (last = {
        url: pick.url,
        source: "registry",
        peerId: pick.entry.peerId,
        publicKeyFingerprint: pick.entry.publicKeyFingerprint,
        region: pick.entry.region,
        latencyMs: pick.latencyMs,
        operator: pick.entry.operator,
        kept,
        reason: "",
        configuredProblem,
        registry: summary,
        decidedAtMs: now()
      });
    } catch (err) {
      return (last = fallback(`steering_error: ${String(err).slice(0, 200)}`));
    }
  };

  return {
    steer,
    last: () => last,
    trustedEntries: () => new Map(entries),
    forgetCurrent() {
      current = null;
    }
  };
}

/** Registry URLs for a client: EDGECODER_REGISTRY_URLS, else <platform URL>/network/registry, then the portal's. */
export function registryUrlsFor(platformUrl: string, portalUrl?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = (env.EDGECODER_REGISTRY_URLS ?? env.EDGECODER_REGISTRY_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s));
  if (explicit.length > 0) return [...new Set(explicit)];
  const out: string[] = [];
  const p = normalizeCoordinatorUrl(platformUrl);
  if (p) out.push(`${p}/network/registry`);
  const portal = portalUrl ? normalizeCoordinatorUrl(portalUrl) : null;
  if (portal) out.push(`${portal}/network/registry`);
  return [...new Set(out)];
}

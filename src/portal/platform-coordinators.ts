// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

// Which coordinator GET /nodes/discover-coordinator hands a new agent: only the platform's own
// coordinators. Candidates are a configured list (PORTAL_PLATFORM_COORDINATOR_URLS, else
// COORDINATOR_DISCOVERY_URLS, else the US and EU seeds) plus, when the signed registry is configured
// (REGISTRY_SIGNING_KEY_PEM), its EdgeCoder-operated members that passed the registry's identity and
// health check. Enrolled coordinators are never picked by recency or by their DNS records.

import { normalizeCoordinatorUrl } from "../discovery/types.js";
import { memberSteerable, type RegistryPayload } from "../discovery/registry.js";
import { discoveryConfigured, parseDiscoveryUrls } from "./coordinator-discovery.js";

export interface PlatformCoordinator {
  url: string;
  /** Region code ("us", "eu", ...) or "unknown". */
  region: string;
  /** The registry member's peerId, when it came from the registry. */
  nodeId?: string;
  source: "config" | "registry";
  /** The registry member's operator (community members carry their operator's user id). */
  operator?: { id: string; kind: "edgecoder" | "community" };
}

/** The US and EU seeds; PORTAL_PLATFORM_COORDINATOR_URLS or COORDINATOR_DISCOVERY_URLS override it. */
export const DEFAULT_PLATFORM_COORDINATOR_URLS = "https://coordinator.edgecoder.io=us,https://coordinator-eu.edgecoder.io=eu";

const REGION_CODES = new Set(["us", "eu", "ap", "sa", "af", "me", "oc"]);

/** A region code from a hostname label (coordinator-eu.example -> "eu"), else "unknown". */
export function regionFromUrl(url: string): string {
  try {
    const labels = new URL(url).hostname.toLowerCase().split(/[-.]/);
    return labels.find((l) => REGION_CODES.has(l)) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The configured platform coordinators: `url[=region]` entries, comma separated. A missing region is
 * read from the hostname (a `-eu` / `.us.` label), else "unknown".
 */
export function parsePlatformCoordinators(env: NodeJS.ProcessEnv = process.env): PlatformCoordinator[] {
  const explicit = (env.PORTAL_PLATFORM_COORDINATOR_URLS ?? "").trim();
  const raw = explicit || (discoveryConfigured(env) ? parseDiscoveryUrls(env).join(",") : DEFAULT_PLATFORM_COORDINATOR_URLS);
  const out: PlatformCoordinator[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.lastIndexOf("=");
    const rawUrl = eq > 0 ? entry.slice(0, eq) : entry;
    const url = normalizeCoordinatorUrl(rawUrl);
    if (!url || out.some((c) => c.url === url)) continue;
    const region = eq > 0 ? entry.slice(eq + 1).trim().toLowerCase() || "unknown" : regionFromUrl(url);
    out.push({ url, region, source: "config" });
  }
  return out;
}


const EUROPE = new Set(
  "AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS SE SI SK SM UA VA XK".split(" ")
);
const NORTH_AMERICA = new Set("US CA MX PR".split(" "));

/** The region an agent's country maps to ("eu", "us"), or null when unknown. */
export function regionForCountry(countryCode: string | undefined | null): string | null {
  const cc = (countryCode ?? "").trim().toUpperCase();
  if (EUROPE.has(cc)) return "eu";
  if (NORTH_AMERICA.has(cc)) return "us";
  return null;
}

/** Fly.io edge regions -> the platform region they serve ("us", "eu"); others are null (no regional pick). */
const FLY_REGION_AREA: Record<string, "us" | "eu"> = {
  iad: "us", ord: "us", lax: "us", sjc: "us", sea: "us", dfw: "us", den: "us", ewr: "us", atl: "us", mia: "us", bos: "us", phx: "us", chi: "us", yyz: "us", yul: "us", qro: "us",
  lhr: "eu", ams: "eu", fra: "eu", cdg: "eu", mad: "eu", arn: "eu", waw: "eu", otp: "eu",
};

/** The platform region of a Fly edge region code ("lhr" -> "eu"), or null when unknown. */
export function regionForFlyRegion(code: string | undefined | null): string | null {
  return FLY_REGION_AREA[(code ?? "").trim().toLowerCase()] ?? null;
}

function headerValue(raw: unknown): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? v : undefined;
}

/**
 * Network run 22 (every enrolment answered region "unknown", so lhr and fra agents got the US
 * coordinator): where the request itself came from, for an agent whose country is not known. Cloudflare's
 * CF-IPCountry (when the portal sits behind Cloudflare), else Fly's Fly-Region (the edge region the
 * request came in through). Null when neither names a known region. Either only steers the pick
 * among the platform's own coordinators.
 */
export function regionFromRequestHeaders(headers: Record<string, unknown> | undefined): { region: string; from: "cf-ipcountry" | "fly-region" } | null {
  if (!headers) return null;
  const cc = regionForCountry(headerValue(headers["cf-ipcountry"]));
  if (cc) return { region: cc, from: "cf-ipcountry" };
  const fly = regionForFlyRegion(headerValue(headers["fly-region"]));
  if (fly) return { region: fly, from: "fly-region" };
  return null;
}

export interface PlatformPickerOptions {
  coordinators: PlatformCoordinator[];
  /** Resolves true when `url` is healthy; must apply its own timeout. */
  probe: (url: string) => Promise<boolean>;
  /** The signed registry, when wired: used only while it is configured (a signing key is set). */
  registry?: () => { configured: boolean; snapshot(): RegistryPayload } | null;
  /**
   * Also hand new agents to active community (outside) registry members
   * (REGISTRY_STEER_OUTSIDE_MEMBERS). Off until outside coordinators can bill; probation members never.
   */
  includeOutside?: boolean;
  /** Caps each outside operator's share of new-agent assignments (used with includeOutside). */
  shareCap?: OperatorShareCap;
  ttlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

/**
 * Registry members the registry's last check found healthy (identity verified) that may get new
 * agents: EdgeCoder's own active coordinators, plus active community members when `includeOutside`.
 */
export function verifiedRegistryCoordinators(registry: { configured: boolean; snapshot(): RegistryPayload } | null | undefined, includeOutside = false): PlatformCoordinator[] {
  if (!registry?.configured) return [];
  return registry
    .snapshot()
    .coordinators.filter((c) => memberSteerable(c, includeOutside) && c.health.status === "healthy" && c.urls.length > 0)
    .map((c) => ({
      url: normalizeCoordinatorUrl(c.urls[0]) ?? c.urls[0],
      region: (c.region || "unknown").toLowerCase(),
      nodeId: c.peerId,
      source: "registry" as const,
      operator: { id: c.operator.id, kind: c.operator.kind }
    }));
}

/**
 * Each outside operator's share of new-agent assignments over a rolling window. An operator at or
 * above `maxShare` of the window's assignments is skipped (once the window holds `minSample`
 * assignments, so the first few do not lock everyone out). EdgeCoder's own are not counted against.
 */
export class OperatorShareCap {
  private readonly events: Array<{ atMs: number; operatorId: string | null }> = [];
  constructor(
    private readonly maxShare: number,
    private readonly windowMs = 60 * 60_000,
    private readonly minSample = 20,
    private readonly now: () => number = Date.now
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.events.length > 0 && this.events[0].atMs < cutoff) this.events.shift();
    if (this.events.length > 50_000) this.events.splice(0, this.events.length - 50_000);
  }

  /** Whether one more assignment may go to this outside operator. */
  allows(operatorId: string): boolean {
    this.prune();
    const total = this.events.length;
    if (total < this.minSample) return true;
    const mine = this.events.filter((e) => e.operatorId === operatorId).length;
    return (mine + 1) / (total + 1) <= this.maxShare;
  }

  /** Count an assignment (null: an EdgeCoder coordinator). */
  record(operatorId: string | null): void {
    this.events.push({ atMs: this.now(), operatorId });
    this.prune();
  }

  share(operatorId: string): number {
    this.prune();
    return this.events.length ? this.events.filter((e) => e.operatorId === operatorId).length / this.events.length : 0;
  }
}

/**
 * Picks a platform coordinator for an agent: candidates in the agent's region (its country, else the
 * `region` given, e.g. from the request) first, then the rest
 * in configured order; the first healthy one wins. Configured URLs are probed in parallel and each
 * result cached (60 s healthy, 15 s unhealthy); registry members carry the registry's own check.
 */
export function createPlatformCoordinatorPicker(opts: PlatformPickerOptions): (agent: { countryCode?: string | null; region?: string | null }) => Promise<PlatformCoordinator | null> {
  const ttl = opts.ttlMs ?? 60_000;
  const negTtl = opts.negativeTtlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { ok: boolean; at: number }>();
  const inFlight = new Map<string, Promise<boolean>>();

  const healthy = (url: string): Promise<boolean> => {
    const c = cache.get(url);
    if (c && now() - c.at < (c.ok ? ttl : negTtl)) return Promise.resolve(c.ok);
    let p = inFlight.get(url);
    if (!p) {
      p = opts
        .probe(url)
        .catch(() => false)
        .then((ok) => {
          cache.set(url, { ok, at: now() });
          return ok;
        })
        .finally(() => inFlight.delete(url));
      inFlight.set(url, p);
    }
    return p;
  };

  return async (agent) => {
    const fromRegistry = verifiedRegistryCoordinators(opts.registry?.() ?? null, opts.includeOutside === true);
    const candidates = opts.coordinators.map((c) => ({ ...c }));
    for (const r of fromRegistry) {
      const same = candidates.find((c) => c.url === r.url);
      if (same) Object.assign(same, { nodeId: same.nodeId ?? r.nodeId });
      else candidates.push(r);
    }
    // The agent's country first; else a region found from the request (regionFromRequestHeaders).
    const region = regionForCountry(agent.countryCode) ?? (agent.region ? agent.region.trim().toLowerCase() || null : null);
    const ordered = region ? [...candidates.filter((c) => c.region === region), ...candidates.filter((c) => c.region !== region)] : candidates;
    const registryUrls = new Set(fromRegistry.map((r) => r.url));
    const outside = (c: PlatformCoordinator) => c.operator?.kind === "community";
    // An outside operator over its share is skipped this time (its candidates stay for later picks).
    const allowed = ordered.filter((c) => !outside(c) || !opts.shareCap || opts.shareCap.allows(c.operator!.id));
    const results = await Promise.all(allowed.map((c) => (registryUrls.has(c.url) ? Promise.resolve(true) : healthy(c.url))));
    const index = results.findIndex(Boolean);
    if (index < 0) return null;
    const pick = allowed[index];
    opts.shareCap?.record(outside(pick) ? pick.operator!.id : null);
    return { ...pick };
  };
}

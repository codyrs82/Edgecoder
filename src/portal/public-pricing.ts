// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Public pricing for the marketing page: sats per credit-hour of the four compute classes and
 * per hour of every hardware tier (credit-hour × tier weight), with the USD conversion, taken from
 * the coordinator's current rate epoch (docs/economy-math.md). The page is
 * server-rendered (no inline script under the CSP), so the portal fetches the epoch with its
 * service token and caches it briefly. Without a coordinator the reference USD figures are shown
 * and the sats column says so.
 */
import { request } from "undici";
import { BASE_TIER, DEFAULT_COMPUTE_CLASSES, type ComputeClassId, type ComputeTierId } from "../economy/compute-classes.js";

export interface PublicTierPrice {
  id: ComputeTierId;
  label: string;
  /** Credits per measured second: one hour of this tier is this many credit-hours of the class. */
  creditsPerSecond: number;
  satsPerHour?: number;
  usdPerHour: number;
}

export interface PublicClassPrice {
  id: ComputeClassId;
  label: string;
  hardware: string;
  /** Sats per credit-hour (one hour of the base tier); undefined when no rate epoch is available. */
  satsPerHour?: number;
  usdPerHour: number;
  /** "reference" or the live source name from the oracle. */
  source: string;
  /** The weight table, base tier first. */
  tiers: PublicTierPrice[];
}

export interface PublicPricing {
  /** BTC/USD used for the conversion; undefined in reference mode. */
  btcUsd?: number;
  asOfMs?: number;
  /** "live": from the rate epoch. "reference": static USD references, no sats. */
  mode: "live" | "reference";
  classes: PublicClassPrice[];
}

/** Hardware descriptions shown next to each class on the public page. */
export const CLASS_HARDWARE: Record<ComputeClassId, string> = {
  cpu: "x86 / ARM cores, by core count and memory",
  apple: "M-series Macs, by unified memory",
  gpu: "Consumer cards, by VRAM",
  "gpu.dc": "A6000 / L40 / A100 / H100, a separate reliability tier"
};

/** The four pairs shown in the hero ticker, in order. */
export const HERO_CLASSES: ComputeClassId[] = ["cpu", "apple", "gpu", "gpu.dc"];

/** Minimal view of a rate epoch (the coordinator's /economy/rates/current response). */
export interface RateEpochView {
  btcUsd: number;
  createdAtMs: number;
  classRates: Partial<Record<string, { usdPerHour: number; satsPerUnitHour: number; source: string; tiers?: Array<{ tier: string; creditsPerSecond: number; satsPerHour: number }> }>>;
}

function tiersOf(id: ComputeClassId, usdPerHour: number, satsPerUnitHour: number | undefined, live?: Array<{ tier: string; creditsPerSecond: number }>): PublicTierPrice[] {
  return DEFAULT_COMPUTE_CLASSES[id].tiers.map((t) => {
    // The coordinator's weights win (they are env-overridable); the defaults label the tiers.
    const weight = live?.find((x) => x.tier === t.id)?.creditsPerSecond ?? t.creditsPerSecond;
    return {
      id: t.id,
      label: t.label,
      creditsPerSecond: weight,
      satsPerHour: satsPerUnitHour === undefined ? undefined : Number((satsPerUnitHour * weight).toFixed(3)),
      usdPerHour: Number((usdPerHour * weight).toFixed(6))
    };
  });
}

export function referencePricing(): PublicPricing {
  return {
    mode: "reference",
    classes: Object.values(DEFAULT_COMPUTE_CLASSES).map((spec) => ({
      id: spec.id,
      label: spec.label,
      hardware: CLASS_HARDWARE[spec.id],
      usdPerHour: spec.usdPerHourReference,
      source: "reference",
      tiers: tiersOf(spec.id, spec.usdPerHourReference, undefined)
    }))
  };
}

/**
 * A coordinator still on the nine-class build keys its rates by the legacy ids; the legacy base
 * tier (cpu.std, apple.m, gpu.c8, gpu.dc40) has exactly the class's credit-hour, so it stands in.
 */
export function pricingFromRateEpoch(epoch: RateEpochView): PublicPricing {
  const classes: PublicClassPrice[] = Object.values(DEFAULT_COMPUTE_CLASSES).map((spec) => {
    const rate = epoch.classRates[spec.id] ?? epoch.classRates[BASE_TIER[spec.id]];
    const usdPerHour = rate ? rate.usdPerHour : spec.usdPerHourReference;
    return {
      id: spec.id,
      label: spec.label,
      hardware: CLASS_HARDWARE[spec.id],
      satsPerHour: rate ? rate.satsPerUnitHour : undefined,
      usdPerHour,
      source: rate ? rate.source : "reference",
      tiers: tiersOf(spec.id, usdPerHour, rate?.satsPerUnitHour, rate?.tiers)
    };
  });
  return { mode: "live", btcUsd: epoch.btcUsd, asOfMs: epoch.createdAtMs, classes };
}

/** "32.4 sats/h", "1,240 sats/h"; sub-10 keeps one decimal. */
export function formatSats(sats: number): string {
  if (sats >= 100) return Math.round(sats).toLocaleString("en-US");
  if (sats >= 10) return sats.toFixed(1);
  return sats.toFixed(2);
}

/** "$0.02", "$1.80", "$77,931" */
export function formatUsd(usd: number): string {
  if (usd >= 1000) return "$" + Math.round(usd).toLocaleString("en-US");
  if (usd >= 1) return "$" + usd.toFixed(2);
  const two = usd.toFixed(2);
  return "$" + (two === "0.00" && usd > 0 ? usd.toFixed(3) : two);
}

/**
 * Cached pricing source for the portal: fetches the epoch at most once per `ttlMs`, keeps serving
 * the last good value while the coordinator is unreachable, and falls back to references.
 */
export function createPublicPricingSource(
  fetchEpoch: () => Promise<RateEpochView | null>,
  opts: { ttlMs?: number; now?: () => number } = {}
): () => Promise<PublicPricing> {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let cached: PublicPricing | null = null;
  let fetchedAt = 0;
  let inflight: Promise<PublicPricing> | null = null;
  return async () => {
    if (cached && now() - fetchedAt < ttlMs) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const epoch = await fetchEpoch();
        if (epoch && Number.isFinite(epoch.btcUsd) && epoch.btcUsd > 0) {
          cached = pricingFromRateEpoch(epoch);
          fetchedAt = now();
        }
      } catch {
        // keep the last good value
      } finally {
        inflight = null;
      }
      if (!cached) {
        fetchedAt = now(); // do not hammer an unreachable coordinator; retry after the TTL
        return referencePricing();
      }
      return cached;
    })();
    return inflight;
  };
}

/** The portal's pricing source: the first discovered coordinator's /economy/rates/current. */
export function coordinatorPricingSource(deps: {
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  PORTAL_SERVICE_TOKEN: string;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
}): () => Promise<PublicPricing> {
  return createPublicPricingSource(async () => {
    const urls = await deps.discoverCoordinatorUrlsForPortal();
    if (!urls.length) return null;
    const res = await request(`${urls[0].replace(/\/$/, "")}/economy/rates/current`, {
      method: "GET",
      headers: deps.PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": deps.PORTAL_SERVICE_TOKEN } : {},
      headersTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS
    });
    if (res.statusCode !== 200) {
      await res.body.text().catch(() => undefined);
      return null;
    }
    const body = (await res.body.json()) as { epoch?: RateEpochView | null };
    return body.epoch && body.epoch.classRates ? body.epoch : null;
  });
}

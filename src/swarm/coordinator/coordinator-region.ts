// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * This coordinator's region, as GET /network/world/local, GET /network/world and GET /identity
 * report it: INFRA_HOST_REGION, COORDINATOR_REGION, then Fly's FLY_REGION. A coordinator with none
 * of them (an outside operator's VM, say on Azure) looks its public address up once at start
 * (api.ipapi.is, keyless; COORDINATOR_REGION_LOOKUP=false turns it off) and takes the nearest
 * region code within REGION_MATCH_MAX_KM, plus the country. Before that answers, or when it fails,
 * the region is unknown, as before.
 */
import { request } from "undici";
import { CC } from "./context.js";
import { regionFromGeo, regionInfo, type CoordinatorPlace } from "../network-world.js";

export const REGION_LOOKUP_URL = "https://api.ipapi.is/";
export const REGION_LOOKUP_TIMEOUT_MS = 5_000;
/** A failed lookup is tried again after this long, at most REGION_LOOKUP_MAX_TRIES times. */
export const REGION_LOOKUP_RETRY_MS = 10 * 60_000;
export const REGION_LOOKUP_MAX_TRIES = 6;

/** The region an operator configured (lower case), or null. */
export function configuredCoordinatorRegion(env: NodeJS.ProcessEnv = process.env, infraHostRegion: string | undefined = CC.INFRA_HOST_REGION): string | null {
  const r = (infraHostRegion || env.COORDINATOR_REGION || env.FLY_REGION || "").trim().toLowerCase();
  return r || null;
}

let looked: { region: string | null; countryCode: string | null } | null = null;

/** Tests: set (or clear) what the address lookup found. */
export function setLookedUpRegion(v: { region: string | null; countryCode: string | null } | null): void {
  looked = v;
}

/** This coordinator's region code: the configured one, else the looked-up one, else null. */
export function coordinatorRegion(): string | null {
  return configuredCoordinatorRegion() ?? looked?.region ?? null;
}

/** Region, country and continent for this coordinator. */
export function coordinatorPlace(): CoordinatorPlace {
  const configured = configuredCoordinatorRegion();
  return regionInfo(configured ?? looked?.region ?? null, configured ? null : looked?.countryCode ?? null);
}

export type GeoFetch = (url: string, timeoutMs: number) => Promise<{ status: number; json: unknown }>;

const undiciGeoFetch: GeoFetch = async (url, timeoutMs) => {
  const res = await request(url, { method: "GET", headers: { accept: "application/json" }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.body.text();
  if (text.length > 64 * 1024) return { status: 502, json: null };
  return { status: res.statusCode, json: text ? JSON.parse(text) : null };
};

/** Look this machine's public address up once. True when it named a region or a country. */
export async function lookupCoordinatorRegion(fetchGeo: GeoFetch = undiciGeoFetch): Promise<boolean> {
  try {
    const r = await fetchGeo(REGION_LOOKUP_URL, REGION_LOOKUP_TIMEOUT_MS);
    if (r.status !== 200) return false;
    const found = regionFromGeo(r.json);
    if (!found.region && !found.countryCode) return false;
    looked = found;
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the lookup when no region is configured and it is not turned off; retried a few times on
 * failure. Returns a stop function.
 */
export function startCoordinatorRegionLookup(opts: {
  enabled?: boolean;
  fetchGeo?: GeoFetch;
  retryMs?: number;
  maxTries?: number;
  log?: { info: (o: object, m: string) => void };
} = {}): () => void {
  if (opts.enabled === false || configuredCoordinatorRegion() !== null) return () => {};
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const attempt = async () => {
    tries++;
    const ok = await lookupCoordinatorRegion(opts.fetchGeo);
    if (stopped) return;
    if (ok) opts.log?.info({ region: looked?.region ?? null, country: looked?.countryCode ?? null }, "coordinator_region_looked_up");
    else if (tries < (opts.maxTries ?? REGION_LOOKUP_MAX_TRIES)) {
      timer = setTimeout(() => void attempt(), opts.retryMs ?? REGION_LOOKUP_RETRY_MS);
      timer.unref?.();
    }
  };
  void attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

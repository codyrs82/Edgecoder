// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Where a region is, roughly, for locality-aware routing (#526): the buyer's region (Fly-Region of
 * the edge it came in through, its own x-edgecoder-client-region, or CF-IPCountry as "cc-<code>";
 * common/coordinator-choice.ts clientRegionOf) against a host's (the Fly region it reported, else
 * its country, else its coordinator's region).
 *
 * Coordinates are a city per Fly region and a population centre per country: good to a few hundred
 * km, which is all the routing needs (is this host on the buyer's side of the world?). Unknown codes
 * give null, and callers then leave locality out of the decision.
 */

/** Fly.io region code -> [lat, lon]. */
const FLY: Record<string, readonly [number, number]> = {
  iad: [38.9, -77.4], ord: [41.9, -87.9], lax: [33.9, -118.4], sjc: [37.4, -121.9], sea: [47.4, -122.3], dfw: [32.9, -97.0],
  den: [39.9, -104.7], ewr: [40.7, -74.2], atl: [33.6, -84.4], mia: [25.8, -80.3], bos: [42.4, -71.0], phx: [33.4, -112.0],
  chi: [41.9, -87.6], yyz: [43.7, -79.6], yul: [45.5, -73.7], qro: [20.6, -100.4], gru: [-23.4, -46.5], gig: [-22.8, -43.2],
  scl: [-33.4, -70.8], eze: [-34.8, -58.5], bog: [4.7, -74.1], lhr: [51.5, -0.5], ams: [52.3, 4.8], fra: [50.0, 8.6],
  cdg: [49.0, 2.5], mad: [40.5, -3.6], arn: [59.7, 17.9], waw: [52.2, 21.0], otp: [44.6, 26.1], sin: [1.4, 103.99],
  nrt: [35.8, 140.4], hkg: [22.3, 113.9], bom: [19.1, 72.9], syd: [-33.9, 151.2], jnb: [-26.1, 28.2],
};

/** ISO country -> [lat, lon] of a main population centre (countries buyers and hosts are likely in). */
const COUNTRY: Record<string, readonly [number, number]> = {
  US: [39.8, -98.6], CA: [45.4, -75.7], MX: [19.4, -99.1], BR: [-23.5, -46.6], AR: [-34.6, -58.4], CL: [-33.4, -70.7],
  CO: [4.7, -74.1], PE: [-12.0, -77.0], GB: [51.5, -0.1], IE: [53.3, -6.3], FR: [48.9, 2.4], DE: [50.1, 8.7],
  NL: [52.4, 4.9], BE: [50.8, 4.4], CH: [47.4, 8.5], AT: [48.2, 16.4], IT: [45.5, 9.2], ES: [40.4, -3.7],
  PT: [38.7, -9.1], SE: [59.3, 18.1], NO: [59.9, 10.8], DK: [55.7, 12.6], FI: [60.2, 24.9], PL: [52.2, 21.0],
  CZ: [50.1, 14.4], HU: [47.5, 19.0], RO: [44.4, 26.1], GR: [37.98, 23.7], UA: [50.5, 30.5], TR: [41.0, 29.0],
  IL: [32.1, 34.8], AE: [25.2, 55.3], SA: [24.7, 46.7], IN: [19.1, 72.9], PK: [24.9, 67.0], SG: [1.35, 103.8],
  MY: [3.1, 101.7], TH: [13.8, 100.5], VN: [10.8, 106.7], PH: [14.6, 121.0], ID: [-6.2, 106.8], CN: [31.2, 121.5],
  HK: [22.3, 114.2], TW: [25.0, 121.5], KR: [37.6, 127.0], JP: [35.7, 139.7], AU: [-33.9, 151.2], NZ: [-36.8, 174.8],
  ZA: [-26.2, 28.0], NG: [6.5, 3.4], KE: [-1.3, 36.8], EG: [30.0, 31.2], MA: [33.6, -7.6],
};

/** [lat, lon] of a region code ("lhr"), a country as "cc-gb", or a bare country code ("GB"); null when unknown. */
export function regionPoint(code: string | null | undefined): readonly [number, number] | null {
  if (typeof code !== "string") return null;
  const c = code.trim();
  if (!c) return null;
  const fly = FLY[c.toLowerCase()];
  if (fly) return fly;
  const cc = /^cc-([a-z]{2})$/i.exec(c)?.[1] ?? (/^[a-z]{2}$/i.test(c) ? c : null);
  return cc ? COUNTRY[cc.toUpperCase()] ?? null : null;
}

/** Great-circle distance in km between two region codes; null when either is unknown. */
export function regionDistanceKm(a: string | null | undefined, b: string | null | undefined): number | null {
  const p = regionPoint(a);
  const q = regionPoint(b);
  if (!p || !q) return null;
  const rad = Math.PI / 180;
  const dLat = (q[0] - p[0]) * rad;
  const dLon = (q[1] - p[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p[0] * rad) * Math.cos(q[0] * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * A round trip estimated from distance: light in fibre covers ~200 km per ms one way, and real
 * routes are ~1.5-2x the great circle, so about 1 ms of round trip per 70 km.
 */
export const KM_PER_RTT_MS = 70;
export function distanceRttMs(km: number): number {
  return Math.round(Math.max(0, km) / KM_PER_RTT_MS);
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The app's Network page: the coordinator's anonymized world view (GET /network/world, through
 * this machine's agent, signed) plus this computer's own round trip to every coordinator in it.
 *
 * "Latency to me" for an agent is then an estimate the app makes: this computer's round trip to
 * the agent's coordinator plus the coordinator's measured round trip to the agent (WebSocket
 * pings). Agents never talk to the app directly, so that sum is also the path work takes.
 *
 * The round trip to a coordinator is timed here (the IDE provider runs on the same computer as
 * the app): two GETs of its public /identity, the faster one counted, so connection setup is left
 * out. Only http(s) URLs from the coordinator's own answer are probed, and only that path.
 */
import { request } from "undici";
import { call, type NetworkDeps } from "./network-inference.js";

export const COORDINATOR_PROBE_TIMEOUT_MS = 2_500;
export const COORDINATOR_PROBE_CACHE_MS = 30_000;
const MAX_PROBED = 16;

/** Round trip to a coordinator in ms, or null when it did not answer. */
export type CoordinatorProbe = (url: string) => Promise<number | null>;

function probeTarget(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return `${u.origin}/identity`;
  } catch {
    return null;
  }
}

/** Two timed GETs of {url}/identity; the faster one (the second reuses the connection). */
export const timedIdentityProbe: CoordinatorProbe = async (url) => {
  const target = probeTarget(url);
  if (!target) return null;
  let best: number | null = null;
  for (let i = 0; i < 2; i++) {
    const started = performance.now();
    try {
      const res = await request(target, { method: "GET", headersTimeout: COORDINATOR_PROBE_TIMEOUT_MS, bodyTimeout: COORDINATOR_PROBE_TIMEOUT_MS, signal: AbortSignal.timeout(COORDINATOR_PROBE_TIMEOUT_MS) });
      await res.body.text();
      if (res.statusCode !== 200) continue;
      const ms = performance.now() - started;
      best = best === null ? ms : Math.min(best, ms);
    } catch {
      // Unreachable from here: no figure.
    }
  }
  return best === null ? null : Math.round(best);
};

const probeCache = new Map<string, { atMs: number; value: Promise<number | null> }>();

function cachedProbe(probe: CoordinatorProbe, url: string, nowMs: number): Promise<number | null> {
  const hit = probeCache.get(url);
  if (hit && nowMs - hit.atMs < COORDINATOR_PROBE_CACHE_MS) return hit.value;
  const value = probe(url).catch(() => null);
  probeCache.set(url, { atMs: nowMs, value });
  while (probeCache.size > 64) probeCache.delete(probeCache.keys().next().value as string);
  return value;
}

/** Tests. */
export function resetCoordinatorProbeCache(): void {
  probeCache.clear();
}

/**
 * The world view with `myRttMs` on each coordinator (this computer's measured round trip; null when
 * it did not answer). Non-200 answers from the coordinator are passed through as they are.
 */
export async function networkWorld(d: NetworkDeps, probe: CoordinatorProbe = timedIdentityProbe, nowMs = Date.now()): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await call(d, "GET", "/network/world");
  if (r.status !== 200) return r;
  const coordinators = Array.isArray(r.json.coordinators) ? (r.json.coordinators as Array<Record<string, unknown>>) : [];
  // Hosted (transport) callers are not on the user's computer; their timings would be the server's.
  const measure = !d.transport;
  const timed = await Promise.all(
    coordinators.map((c, i) => (measure && i < MAX_PROBED && typeof c.url === "string" && c.reachable !== false ? cachedProbe(probe, c.url, nowMs) : Promise.resolve(null)))
  );
  return {
    status: 200,
    json: {
      ...r.json,
      coordinators: coordinators.map((c, i) => ({ ...c, myRttMs: timed[i] })),
      latency: {
        measuredFrom: measure ? "this computer" : null,
        note: "Latency to a machine is an estimate: your round trip to its coordinator plus the coordinator's measured round trip to the machine."
      }
    }
  };
}

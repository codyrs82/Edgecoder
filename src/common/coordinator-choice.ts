// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Why the portal sent a network call to one coordinator rather than another (latency-aware
 * coordinator choice, src/portal/coordinator-latency.ts). The portal sends it with the call
 * (/inference/submit `coordinatorChoice`, honoured only with the portal service token) and the
 * coordinator keeps it on the call's routing decision, so the admin Network page shows when the
 * EU coordinator was chosen and why. Shared by the portal (writes it) and the coordinator (reads it).
 */

/**
 * - load: today's choice (most free model slots; a tie goes to more agents); latency did not beat it by the margin.
 * - latency: a coordinator with a free slot is faster for this call by more than the margin.
 * - overflow: the load choice had no free slot (calls queue there) and another is faster even after the distance.
 * - single: only one coordinator could take the call.
 * - locality: another coordinator has a free host nearer the buyer (by more than the margin, #526).
 */
export type CoordinatorChoiceRule = "load" | "latency" | "overflow" | "single" | "locality";

/** One coordinator as the portal scored it (milliseconds; null when not known). */
export interface CoordinatorChoiceCandidate {
  /** Host of the coordinator (no scheme). */
  coordinator: string;
  /** Portal <-> coordinator round trip, measured on the portal's own capacity probes. */
  rttMs: number | null;
  /** Expected wait before an agent starts: pickup p90, plus queued rounds when no slot is free. */
  queueMs: number | null;
  /** Coordinator <-> agent round trip for agents holding the model (the coordinator measures it). */
  agentRttMs: number | null;
  /** rttMs + queueMs + agentRttMs; null when the round trip is unknown or the load report is stale. */
  expectedMs: number | null;
  /** Free model slots after calls waiting and calls the portal sent since the report (may be negative). */
  free: number;
  waiting: number;
  agents: number;
  /** The load report was older than LOAD_REPORT_MAX_AGE_MS: not used for the latency comparison. */
  stale?: boolean;
  /** Distance (km) from the buyer to this coordinator's nearest host with a free slot, when both are known (#526). */
  nearKm?: number;
}

export interface CoordinatorChoice {
  /** Host of the coordinator the call went to. */
  chosen: string;
  rule: CoordinatorChoiceRule;
  /** One line: why this coordinator. */
  reason: string;
  /** Where the buyer came in (Fly-Region of the edge, CF-IPCountry, or the client's own region header); scored by the locality rule. */
  clientRegion: string | null;
  /** Region of the portal machine that chose (FLY_REGION): the round trips above are measured from here. */
  portalRegion: string | null;
  candidates: CoordinatorChoiceCandidate[];
}

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
export const coordinatorHost = host;

const REGION_RE = /^[a-z0-9-]{2,24}$/i;
/** A region or country code as sent in a header: short and plain, else null. */
export function cleanRegion(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return REGION_RE.test(t) ? t : null;
}

/**
 * Where a buyer's request came in, for the record: the client's own region header
 * (x-edgecoder-client-region; the load generator sends its Fly region), else Fly's edge region
 * (fly-region), else Cloudflare's country (cf-ipcountry, as "cc-<code>"). Null when none is sent.
 * The portal relays every call, so the client <-> portal leg is the same whichever coordinator is
 * chosen; what the region decides is which coordinator has a free host near the buyer (the locality
 * rule, portal/coordinator-latency.ts), and which of its hosts is preferred (coordinator locality.ts).
 */
export function clientRegionOf(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null;
  const own = cleanRegion(headers["x-edgecoder-client-region"]);
  if (own) return own;
  const fly = cleanRegion(headers["fly-region"]);
  if (fly) return fly;
  const cc = cleanRegion(headers["cf-ipcountry"]);
  return cc && cc !== "xx" && cc !== "t1" ? `cc-${cc}` : null;
}

const RULES: readonly CoordinatorChoiceRule[] = ["load", "latency", "overflow", "single", "locality"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const num = (v: unknown) => numOrNull(v) ?? 0;

/** What a coordinator keeps from a submitted choice: known fields only, bounded. Undefined when it is not a choice. */
export function sanitizeCoordinatorChoice(raw: unknown): CoordinatorChoice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const rule = RULES.find((x) => x === r.rule);
  const chosen = str(r.chosen, 200);
  if (!rule || !chosen) return undefined;
  const candidates = (Array.isArray(r.candidates) ? r.candidates : [])
    .slice(0, 8)
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c): CoordinatorChoiceCandidate => ({
      coordinator: str(c.coordinator, 200),
      rttMs: numOrNull(c.rttMs),
      queueMs: numOrNull(c.queueMs),
      agentRttMs: numOrNull(c.agentRttMs),
      expectedMs: numOrNull(c.expectedMs),
      free: num(c.free),
      waiting: num(c.waiting),
      agents: num(c.agents),
      ...(c.stale === true ? { stale: true } : {}),
      ...(numOrNull(c.nearKm) !== null ? { nearKm: Math.max(0, numOrNull(c.nearKm)!) } : {}),
    }));
  return { chosen, rule, reason: str(r.reason, 300), clientRegion: cleanRegion(r.clientRegion), portalRegion: cleanRegion(r.portalRegion), candidates };
}

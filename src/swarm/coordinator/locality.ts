// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * #526: locality for named-model calls, and the peer a named call can be sent to.
 *
 * nearestFreeHolder: a call that names its model used to go to whichever eligible agent pulled
 * first, wherever the buyer was (21.5% of calls landed on one of the two hosts nearest the client
 * in the 2026-11-24 run). Now, when the buyer's region is known (the portal passes it; else the
 * request's Fly-Region / CF-IPCountry), the free holder nearest the buyer is preferred for a moment
 * (dispatch.ts preferAgent: it is nudged first and others leave the call to it while it has room).
 * Only agents with a free slot are candidates, scored by distance plus a load term, so a near host
 * that is busy does not hold the call: the call overflows to the next nearest free one, and after
 * the preference lapses anyone eligible may take it, as before.
 *
 * Warm models (2026-11-24 run 2: 22% nearest, every US 1.5b call on the owner's Mac): the preferred
 * host is exempt from dispatch's model-affinity deferral, and the preference lasts longer than that
 * deferral (LOCALITY_PREFER_MS > DEFER_MS), so a near host with a free slot is not overruled by a far
 * host that has the model loaded. The cold load is weighed here instead: a candidate known to be cold
 * (it reports its loaded models, the model is not among them, and it has not served it within
 * WARM_MS) counts the load time as distance when another free candidate has the model warm. A host
 * that reports no loaded models is never assumed cold, and one that served the model lately is warm.
 *
 * peerWithFreeCapacity: a named model with no free slot here, which a peer coordinator's agents do
 * have free, is answered with route_elsewhere when the caller allows it (routeRedirect), before
 * anything is reserved, exactly as an Auto call whose best fit is on a peer: the caller resubmits
 * there once, so the requester is reserved and refunded once, by the coordinator that runs it, and
 * one host is credited.
 */

import type { ComputeClassId } from "../../economy/compute-classes.js";
import { classFamily } from "../../inference-api/auto-route.js";
import { regionDistanceKm } from "../../common/geo-regions.js";
import { agentHasModel } from "../model-catalog.js";
import { queue, reservations } from "./context.js";
import { agentCapabilities, activeBlacklistRecord } from "./agent-state.js";
import { agentContextWindow, agentLoadReport, freeModelSlots, modelKnownCold, modelWarmOn } from "./dispatch.js";
import { coldLoadMs } from "./best-fit.js";
import { KM_PER_RTT_MS } from "../../common/geo-regions.js";
import { effectiveHardware } from "./economy.js";
import { agentUnavailable, memoryAdmits } from "./memory-admission.js";
import { agentRegionCode, peerWorldViews, peerAgentViews } from "./routing.js";

/** How long the nearest free holder keeps a named-model call before anyone eligible may take it (longer than DEFER_MS). */
export const LOCALITY_PREFER_MS = 2_000;
/** A fully busy-but-free-slot agent counts as this many km farther (load against distance). */
export const LOCALITY_LOAD_KM = 1_500;

export interface LocalHolder {
  agentId: string;
  km: number;
  free: number;
}

/** This coordinator's agents that could start `model` now in `taskClass`, with their free slots. */
export interface FreeHolder {
  agentId: string;
  free: number;
  slots: number;
  region: string | null;
  /** The model is loaded there or it served it lately (dispatch.ts modelWarmOn). */
  warm?: boolean;
  /** Known not to have the model loaded (dispatch.ts modelKnownCold): it would pay a cold load. */
  cold?: boolean;
}

export function freeLocalHolders(model: string, taskClass: ComputeClassId | "any", neededTokens: number, nowMs = Date.now()): FreeHolder[] {
  const claims = queue.activeClaims();
  const out: FreeHolder[] = [];
  for (const [id, cap] of agentCapabilities) {
    if (!agentHasModel(cap, model)) continue;
    if (activeBlacklistRecord(id) || cap.hostApproved === false || reservations.isHeld(id, nowMs) || agentUnavailable(id, nowMs)) continue;
    if (nowMs - cap.lastSeenMs > 60_000) continue;
    const cls = effectiveHardware(id, cap)?.computeClass ?? cap.computeClass ?? "cpu";
    if (taskClass !== "any" && cls !== taskClass) continue;
    const ctx = agentContextWindow(id);
    if (ctx !== undefined && neededTokens > ctx) continue;
    if (!memoryAdmits(id, model, claims.get(id)?.inference ?? 0, nowMs)) continue;
    const free = freeModelSlots(id, claims);
    if (free <= 0) continue;
    out.push({ agentId: id, free, slots: Math.max(1, agentLoadReport(id)?.slots ?? cap.maxConcurrentTasks ?? 1), region: agentRegionCode(cap), warm: modelWarmOn(id, model, nowMs), cold: modelKnownCold(id, model, nowMs) });
  }
  return out;
}

/**
 * The free holder to prefer for a buyer in `clientRegion`: the smallest distance plus load term,
 * plus the cold-load time (as distance) for a candidate known to be cold when another has the model
 * warm. Undefined when the region or every candidate's region is unknown (no locality then).
 */
export function nearestFreeHolder(candidates: ReadonlyArray<FreeHolder>, clientRegion: string | null | undefined, model?: string): LocalHolder | undefined {
  if (!clientRegion) return undefined;
  const anyWarm = candidates.some((c) => c.warm);
  const coldKm = model ? coldLoadMs(model) * KM_PER_RTT_MS : 0;
  let best: (LocalHolder & { score: number }) | undefined;
  for (const c of candidates) {
    const km = regionDistanceKm(clientRegion, c.region);
    if (km === null) continue;
    const score = km + LOCALITY_LOAD_KM * (1 - c.free / Math.max(1, c.slots)) + (anyWarm && c.cold ? coldKm : 0);
    if (!best || score < best.score || (score === best.score && c.free > best.free)) best = { agentId: c.agentId, km, free: c.free, score };
  }
  return best ? { agentId: best.agentId, km: best.km, free: best.free } : undefined;
}

/**
 * A peer coordinator whose agents have a free slot for `model` (in the class), from the peers' world
 * views (bounded wait). Several: the one with the free agent nearest the buyer, else the most free slots.
 */
export async function peerWithFreeCapacity(model: string, computeClass: string, clientRegion: string | null | undefined, nowMs = Date.now()): Promise<{ coordinatorId: string; url: string } | null> {
  const worlds = await peerWorldViews(nowMs);
  if (!worlds.length) return null;
  const family = computeClass === "any" ? null : classFamily(computeClass);
  const by = new Map<string, { free: number; km: number }>();
  for (const a of peerAgentViews(worlds, nowMs)) {
    if (a.stale || a.freeSlots <= 0 || !a.models.includes(model)) continue;
    if (family && !family.includes(a.computeClass)) continue;
    const world = worlds.find((w) => w.world.coordinator.id === a.coordinatorId)?.world;
    const agent = world?.agents.find((x) => x.agentId === a.agentId);
    const km = clientRegion ? regionDistanceKm(clientRegion, agent?.region || agent?.country || world?.coordinator.region || null) : null;
    const e = by.get(a.coordinatorId) ?? { free: 0, km: Infinity };
    e.free += a.freeSlots;
    if (km !== null) e.km = Math.min(e.km, km);
    by.set(a.coordinatorId, e);
  }
  let best: { id: string; free: number; km: number } | undefined;
  for (const [id, e] of by) if (!best || e.km < best.km || (e.km === best.km && e.free > best.free)) best = { id, ...e };
  if (!best) return null;
  const url = worlds.find((w) => w.world.coordinator.id === best!.id)?.world.coordinator.url;
  return url ? { coordinatorId: best.id, url } : null;
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Account routes: summary, usage and agent reservations.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accruePricedJob,
  creditEngine,
  earnedMsat,
  grantCreditsIdempotent,
  rewardAccountForAgent,
  spendCredits
} from "../../../credits/store.js";
import { msatToCSats, ratePerSecondMsat, splitJobCost } from "../../../economy/job-pricing.js";
import { pgStore } from "../../../db/store.js";
import type { ComputeClassId } from "../../../economy/compute-classes.js";
import { summarizeUsage } from "../../../economy/usage.js";
import {
  RESERVATION_MAX_MINUTES,
  RESERVATION_MIN_MINUTES,
  claimReservationEnd,
  dueReservations,
  reservationPriceMsat,
  syncReservations,
  type Reservation,
  type ReservationEndReason
} from "../../../economy/reservations.js";
import { agentHasModel } from "../../model-catalog.js";
import { app, type CoordinatorApp } from "../app.js";
import { reservations, identity, COORDINATOR_PUBLIC_URL, saveUsage, usagePending, memoryUsage } from "../context.js";
import { agentCapabilities, activeBlacklistRecord } from "../agent-state.js";
import { callerAccount } from "../auth.js";
import { effectiveHardware, hardwareVerifier, NETWORK_FEE_BPS, classRefMsatPerCredit } from "../economy.js";
import { ownerVerificationView } from "../../hardware-verification.js";
import { directQuoteHolds } from "../direct-holds.js";

// ── Reserved capacity (src/economy/reservations.ts) ──

const reserveSchema = z.object({
  accountId: z.string().max(200).optional(),
  computeClass: z.enum(["cpu", "apple", "gpu", "gpu.dc"]),
  minutes: z.number().int().min(RESERVATION_MIN_MINUTES).max(RESERVATION_MAX_MINUTES),
  /** Only an agent that has this model installed. */
  model: z.string().min(1).max(200).optional(),
  minVramGb: z.number().min(0).max(1024).optional(),
});

/** Agents a lease is being made for right now (between choosing the agent and recording the lease). */
const reservingAgents = new Set<string>();

/** Agents that could be reserved now for an account: online, of the class, not held, not its own. */
export async function reservableAgents(accountId: string, cls: ComputeClassId, model?: string, minVramGb?: number) {
  const now = Date.now();
  const quoted = directQuoteHolds.agentIds();
  const out: Array<{ agentId: string; ownerAccountId: string; tier?: string; creditsPerSecond: number; vramGb?: number; models: string[] }> = [];
  for (const [id, cap] of agentCapabilities) {
    if (activeBlacklistRecord(id) || now - cap.lastSeenMs > 60_000 || reservations.isHeld(id, now) || quoted.has(id)) continue;
    // Not an approved host: its machines work only for their owner (src/portal/host-requests.ts).
    if (cap.hostApproved === false) continue;
    const eff = effectiveHardware(id, cap);
    if ((eff?.computeClass ?? "cpu") !== cls) continue;
    if (model && !agentHasModel(cap, model)) continue;
    if (minVramGb && (eff?.vramGb ?? 0) < minVramGb) continue;
    const owner = await rewardAccountForAgent(id);
    if (owner === accountId) continue;
    out.push({ agentId: id, ownerAccountId: owner, tier: eff?.tier, creditsPerSecond: eff?.creditsPerSecond ?? 1, vramGb: eff?.vramGb, models: [...(cap.localModelCatalog ?? [])].filter((m) => m && m !== "edgecoder-default") });
  }
  // Cheapest first (lowest tier weight), then most reliable.
  return out.sort((a, b) => a.creditsPerSecond - b.creditsPerSecond || (hardwareVerifier.reliability(b.agentId) ?? 0) - (hardwareVerifier.reliability(a.agentId) ?? 0));
}

export function publicReservation(r: Reservation) {
  const cSats = (msat: number | undefined) => (msat === undefined ? undefined : msatToCSats(msat));
  return {
    id: r.id, computeClass: r.computeClass, tier: r.tier, model: r.model, agentId: r.agentId, startMs: r.startMs, endMs: r.endMs,
    status: r.status, ...(r.endedAtMs !== undefined ? { endedAtMs: r.endedAtMs } : {}), endReason: r.endReason, cSatsPerSecond: cSats(r.ratePerSecondMsat), prepaidCSats: cSats(r.prepaidMsat),
    usedCSats: cSats(r.usedMsat), refundCSats: cSats(r.refundMsat), ...(r.direct ? { paidDirect: r.direct.rail, receiptIds: r.direct.receiptIds } : {}), models: [...(agentCapabilities.get(r.agentId)?.localModelCatalog ?? [])].filter((m) => m && m !== "edgecoder-default"),
  };
}

/** End a lease: pay the agent's owner for the time held (minus the network fee) and refund the rest. */
async function endReservation(id: string, reason: ReservationEndReason, atMs = Date.now()): Promise<Reservation | undefined> {
  // Coordinators sharing the database race to end a lease; only the one that wins the stored
  // compare-and-set pays and refunds (the loser's book takes the stored copy).
  let r: Reservation | undefined;
  try {
    r = await claimReservationEnd(reservations, pgStore, id, atMs, reason);
  } catch (err) {
    app.log.warn({ err, reservationId: id }, "reservation_end_claim_failed");
    return undefined;
  }
  if (!r) return undefined;
  if (r.direct) {
    // Paid buyer → host directly: no cSats move. Unused time after a host went offline is the
    // host's to refund (refundMsat is shown to both sides).
    app.log.info({ reservationId: r.id, reason, rail: r.direct.rail, usedMsat: r.usedMsat, hostOwesRefundMsat: reason === "agent_offline" ? r.refundMsat : 0 }, "direct_reservation_ended");
    return r;
  }
  const used = r.usedMsat ?? 0;
  const { agentMsat, feeMsat } = splitJobCost(used, NETWORK_FEE_BPS);
  const heldSeconds = Math.max(0, ((r.endedAtMs ?? atMs) - r.startMs) / 1000);
  try {
    await accruePricedJob(
      {
        reportId: `reservation:${r.id}`, agentId: r.agentAccountId, sourceAgentId: r.agentId, taskId: `reservation:${r.id}`,
        resourceClass: r.computeClass === "cpu" ? "cpu" : "gpu", cpuSeconds: r.computeClass === "cpu" ? heldSeconds : 0, gpuSeconds: r.computeClass === "cpu" ? 0 : heldSeconds,
        success: true, qualityScore: 1, timestampMs: Date.now(), hardwareWeight: r.creditsPerSecond,
      },
      { agentMsat, feeMsat }
    );
    if ((r.refundMsat ?? 0) > 0) await grantCreditsIdempotent(r.accountId, msatToCSats(r.refundMsat!), `reservation_refund:${r.id}`, `reservation_refund:${r.id}`);
  } catch (err) {
    app.log.error({ err, reservationId: r.id }, "reservation_settle_failed");
  }
  app.log.info({ reservationId: r.id, reason, usedMsat: used, refundMsat: r.refundMsat }, "reservation_ended");
  void saveUsage({
    id: `usage-${r.id}`, accountId: r.accountId, atMs: r.startMs, kind: "reservation", placement: "reserved", computeClass: r.computeClass,
    agentId: r.agentId, ...(r.model ? { model: r.model } : {}), source: "Reservation", ok: true, durationMs: heldSeconds * 1000, costMsat: used,
  });
  return r;
}

setInterval(async () => {
  const now = Date.now();
  try {
    // Leases made or ended on another coordinator, and heartbeats it saw, come from the shared store.
    await syncReservations(reservations, pgStore);
    const due = await dueReservations(reservations, pgStore, now, (agentId) => agentCapabilities.get(agentId)?.lastSeenMs);
    for (const { r, reason } of due) await endReservation(r.id, reason, now);
  } catch (err) {
    app.log.warn({ err }, "reservation_tick_failed");
  }
  reservations.prune(now);
  // Usage records whose task never settled (lost, timed out without a result): drop after a day.
  for (const [id, u] of usagePending) if (now - u.atMs > 86_400_000) usagePending.delete(id);
}, 30_000).unref?.();

export function registerAccountRoutes(app: CoordinatorApp): void {
  /** The signing agent's owner account: cSats balance, earnings and recent activity (for the app's Compute page). */
  app.post("/account/summary", async (req, reply) => {
    const caller = await callerAccount(req, "/account/summary", (req.body as { accountId?: string } | undefined)?.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    const accountId = caller.accountId;
    const balance = pgStore ? await pgStore.creditBalance(accountId) : creditEngine.balance(accountId);
    const history = pgStore ? await pgStore.creditHistory(accountId) : creditEngine.history(accountId);
    const recent = [...history].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, 25).map((t) => ({
      type: t.type, cSats: Number(t.credits), reason: t.reason, taskId: t.relatedTaskId, atMs: t.timestampMs,
    }));
    // Your machines as this coordinator sees them (the app's Mesh page and "My machines" in the compute picker).
    const owned = new Set([...((await pgStore?.listAgentOwnershipByAccount(accountId)) ?? []).map((o) => o.agentId), accountId]);
    const now = Date.now();
    const machines = [...owned]
      .map((agentId) => ({ agentId, cap: agentCapabilities.get(agentId) }))
      .filter((m) => m.cap)
      .map(({ agentId, cap }) => {
        const eff = effectiveHardware(agentId, cap);
        const lease = reservations.activeForAgent(agentId, now);
        // Hardware verification: what was claimed, what is paid (granted), and the evidence.
        const v = hardwareVerifier.get(agentId);
        return {
          agentId,
          ...(v
            ? {
                verification: {
                  // status, tiers, reason, nextCheckAtMs, checkSupported, flags: the app explains them (hardware-verification-copy.ts).
                  ...ownerVerificationView(v),
                  lastPassAtMs: v.lastPassAtMs ?? null, score: v.evidence.score ?? null, tokensPerSec: v.evidence.tokensPerSec ?? null,
                },
              }
            : {}),
          online: now - cap!.lastSeenMs < 2 * 60_000,
          lastSeenMs: cap!.lastSeenMs,
          computeClass: eff?.computeClass ?? cap!.computeClass,
          tier: eff?.tier ?? null,
          activeModel: cap!.activeModel ?? null,
          models: [...(cap!.localModelCatalog ?? [])].filter((m) => m && m !== "edgecoder-default"),
          reservedUntilMs: lease?.endMs ?? null,
          // false: the owner is not an approved host yet, so this machine runs only the owner's own work.
          hostsForNetwork: cap!.hostApproved !== false,
        };
      });
    let networkAgents = 0;
    for (const cap of agentCapabilities.values()) if (now - cap.lastSeenMs < 2 * 60_000) networkAgents++;
    return reply.send({ accountId, cSats: Number(balance.toFixed(3)), earnedSats: Math.floor((await earnedMsat(accountId)) / 1000), recent, machines, networkAgents, coordinator: { peerId: identity.peerId, url: COORDINATOR_PUBLIC_URL } });
  });

  /** Your usage over the last N days: totals, per day, per model / class / source / placement, newest records. */
  app.post("/account/usage", async (req, reply) => {
    const body = z.object({ accountId: z.string().max(200).optional(), days: z.number().int().min(1).max(90).default(30) }).parse(req.body ?? {});
    const caller = await callerAccount(req, "/account/usage", body.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    const now = Date.now();
    const since = now - body.days * 86_400_000;
    const records = pgStore ? await pgStore.listUsage(caller.accountId, since) : memoryUsage.forAccount(caller.accountId, since);
    return reply.send(summarizeUsage(records, since, now));
  });

  /** Your leases, and what you could reserve now per class (cheapest agent and how many are free). */
  app.post("/account/reservations/list", async (req, reply) => {
    const caller = await callerAccount(req, "/account/reservations/list", (req.body as { accountId?: string } | undefined)?.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    await syncReservations(reservations, pgStore).catch((err) => req.log.warn({ err }, "reservation_sync_failed"));
    const options: Record<string, { available: number; cSatsPerSecond?: number; tiers: string[]; models: string[] }> = {};
    for (const cls of ["cpu", "apple", "gpu", "gpu.dc"] as ComputeClassId[]) {
      const free = await reservableAgents(caller.accountId, cls);
      options[cls] = {
        available: free.length,
        ...(free[0] ? { cSatsPerSecond: msatToCSats(ratePerSecondMsat(classRefMsatPerCredit(cls), free[0].creditsPerSecond)) } : {}),
        tiers: [...new Set(free.map((a) => a.tier).filter((t): t is string => !!t))],
        models: [...new Set(free.flatMap((a) => a.models))].sort(),
      };
    }
    return reply.send({ reservations: reservations.listForAccount(caller.accountId).map(publicReservation), options, minMinutes: RESERVATION_MIN_MINUTES, maxMinutes: RESERVATION_MAX_MINUTES });
  });

  /** Reserve one agent of a class for some minutes, paid now in cSats (unused time comes back). */
  app.post("/account/reservations", async (req, reply) => {
    const body = reserveSchema.parse(req.body);
    const caller = await callerAccount(req, "/account/reservations", body.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    const accountId = caller.accountId;
    // The agent is taken (synchronously, after the awaits that listed it) before the debit is awaited,
    // so two leases made at once cannot both get it.
    const agent = (await reservableAgents(accountId, body.computeClass, body.model, body.minVramGb)).find((a) => !reservingAgents.has(a.agentId) && !reservations.isHeld(a.agentId, Date.now()));
    if (!agent) return reply.code(409).send({ error: "no_agent_available", computeClass: body.computeClass });
    reservingAgents.add(agent.agentId);
    try {
      const rate = ratePerSecondMsat(classRefMsatPerCredit(body.computeClass), agent.creditsPerSecond);
      const prepaid = reservationPriceMsat(body.minutes, rate);
      const id = `res-${randomUUID()}`;
      try {
        await spendCredits(accountId, msatToCSats(prepaid), "compute_reservation", id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("insufficient_credits")) return reply.code(402).send({ error: "insufficient_credits", neededCSats: msatToCSats(prepaid) });
        req.log.error({ err }, "reservation_debit_failed");
        return reply.code(500).send({ error: "credit_debit_failed" });
      }
      const now = Date.now();
      const r: Reservation = {
        id, accountId, agentId: agent.agentId, agentAccountId: agent.ownerAccountId, computeClass: body.computeClass, tier: agent.tier,
        creditsPerSecond: agent.creditsPerSecond, ...(body.model ? { model: body.model } : {}), startMs: now, endMs: now + body.minutes * 60_000,
        ratePerSecondMsat: rate, prepaidMsat: prepaid, status: "active",
      };
      reservations.add(r);
      await pgStore?.upsertReservation(r).catch((err) => req.log.error({ err }, "reservation_persist_failed"));
      app.log.info({ reservationId: id, agentId: agent.agentId, computeClass: body.computeClass, minutes: body.minutes, prepaidMsat: prepaid }, "reservation_created");
      return reply.send({ reservation: publicReservation(r) });
    } finally {
      reservingAgents.delete(agent.agentId);
    }
  });

  /** End a lease early; the unused time is refunded. */
  app.post("/account/reservations/cancel", async (req, reply) => {
    const body = z.object({ reservationId: z.string().min(1).max(100), accountId: z.string().max(200).optional() }).parse(req.body);
    const caller = await callerAccount(req, "/account/reservations/cancel", body.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    // Made on another coordinator (the portal moved seeds): read it from the shared store.
    if (!reservations.get(body.reservationId)) await syncReservations(reservations, pgStore).catch((err) => req.log.warn({ err }, "reservation_sync_failed"));
    const r = reservations.get(body.reservationId);
    if (!r || r.accountId !== caller.accountId) return reply.code(404).send({ error: "unknown_reservation" });
    const ended = r.status === "active" ? await endReservation(r.id, "cancelled") : r;
    // Lost the race to another coordinator: the book now holds the stored (already ended) copy.
    return reply.send({ reservation: publicReservation(ended ?? reservations.get(r.id) ?? r) });
  });
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Pricing routes: rate recalibration, credit quotes, and price proposals and consensus.
 */
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { PriceEpochRecord, ResourceClass } from "../../../common/types.js";
import { signPayload } from "../../../mesh/peer.js";
import { isAllowlistedKey, PEER_SIGNATURE_MAX_SKEW_MS } from "../../../mesh/peer-trust.js";
import { creditEngine } from "../../../credits/store.js";
import { pgStore } from "../../../db/store.js";
import { computeDynamicPricePerComputeUnitSats } from "../../../economy/pricing.js";
import {
  checkPriceEpoch,
  priceConsensusQuorum,
  resolvePriceConsensus,
  signPriceQuote,
  verifyPriceQuote
} from "../../../economy/price-epoch-guard.js";
import type { CoordinatorApp } from "../app.js";
import { queue, identity, peerScore, coordinatorKeys, mesh, MESH_PEER_ALLOWLIST, MESH_AUTH_TOKEN } from "../context.js";
import { authorizeAdmin, requireMeshToken } from "../auth.js";
import {
  recalibrateRateEpoch,
  previousPriceEpochSats,
  PRICE_EPOCH_BOUNDS,
  latestPriceEpochByResource,
  PRICE_CONSENSUS_QUORUM_OVERRIDE
} from "../economy.js";
import { isApprovedCoordinator } from "../peers.js";

export function registerPricingRoutes(app: CoordinatorApp): void {
  /** Admin: force a recalibration now (e.g. after changing sources). Daily-move clamp still applies. */
  app.post("/economy/rates/recalibrate", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    try {
      const epoch = await recalibrateRateEpoch();
      return { ok: true, epoch };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/economy/credits/:accountId/quote", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const params = z.object({ accountId: z.string().min(1) }).parse(req.params);
    const balance = pgStore ? await pgStore.creditBalance(params.accountId) : creditEngine.balance(params.accountId);
    // The balance is in cSats: 1 cSat = 1 sat of prepaid compute.
    return {
      accountId: params.accountId,
      credits: Number(balance.toFixed(3)),
      cSats: Number(balance.toFixed(3)),
      satsPerCredit: 1,
      msatPerCredit: 1000,
      estimatedSats: Math.floor(balance),
      quotedAtMs: Date.now()
    };
  });

  app.get("/economy/price/quote", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const query = z
      .object({
        resourceClass: z.enum(["cpu", "gpu"]).default("cpu"),
        cpuCapacity: z.coerce.number().nonnegative().default(Math.max(1, queue.status().agents)),
        gpuCapacity: z.coerce.number().nonnegative().default(0),
        queuedTasks: z.coerce.number().nonnegative().default(queue.status().queued),
        activeAgents: z.coerce.number().nonnegative().default(queue.status().agents)
      })
      .parse(req.query);
    const inputs = {
      cpuCapacity: query.cpuCapacity,
      gpuCapacity: query.gpuCapacity,
      queuedTasks: query.queuedTasks,
      activeAgents: query.activeAgents
    };
    const computed = computeDynamicPricePerComputeUnitSats(query.resourceClass, inputs);
    // #53: signed over the inputs and time so the asking coordinator can count it toward a quorum.
    const issuedAtMs = Date.now();
    const fields = { coordinatorId: identity.peerId, resourceClass: query.resourceClass, pricePerComputeUnitSats: computed, inputs, issuedAtMs };
    return {
      coordinatorId: identity.peerId,
      resourceClass: query.resourceClass,
      pricePerComputeUnitSats: computed,
      issuedAtMs,
      reputationWeight: peerScore.get(identity.peerId) ?? 120,
      signature: signPriceQuote(fields, coordinatorKeys.privateKeyPem)
    };
  });

  app.post("/economy/price/propose", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // operator: sets this coordinator's price epoch
    const body = z
      .object({
        coordinatorId: z.string(),
        cpuCapacity: z.number().nonnegative(),
        gpuCapacity: z.number().nonnegative(),
        queuedTasks: z.number().nonnegative(),
        activeAgents: z.number().nonnegative()
      })
      .parse(req.body);
    if (!isApprovedCoordinator(body.coordinatorId)) {
      return reply.code(403).send({ error: "coordinator_not_approved" });
    }
    const now = Date.now();
    const resources: ResourceClass[] = ["cpu", "gpu"];
    const proposed = new Map<ResourceClass, number>();
    // #53: an epoch outside the configured band, or moving more than the max step, is rejected whole.
    for (const resourceClass of resources) {
      const price = computeDynamicPricePerComputeUnitSats(resourceClass, body);
      const check = checkPriceEpoch(price, previousPriceEpochSats(resourceClass), PRICE_EPOCH_BOUNDS[resourceClass]);
      if (!check.ok) {
        return reply.code(422).send({ error: "price_out_of_bounds", resourceClass, reason: check.reason, proposed: price, previous: previousPriceEpochSats(resourceClass), bounds: PRICE_EPOCH_BOUNDS[resourceClass] });
      }
      proposed.set(resourceClass, price);
    }
    const created: PriceEpochRecord[] = [];
    for (const resourceClass of resources) {
      const pricePerComputeUnitSats = proposed.get(resourceClass)!;
      const payload = JSON.stringify({
        resourceClass,
        pricePerComputeUnitSats,
        coordinatorId: identity.peerId,
        createdAtMs: now
      });
      const epoch: PriceEpochRecord = {
        epochId: randomUUID(),
        coordinatorId: identity.peerId,
        resourceClass,
        pricePerComputeUnitSats,
        supplyIndex: resourceClass === "gpu" ? body.gpuCapacity : body.cpuCapacity,
        demandIndex: body.queuedTasks + body.activeAgents,
        negotiatedWith: [body.coordinatorId],
        signature: signPayload(payload, coordinatorKeys.privateKeyPem),
        createdAtMs: now
      };
      latestPriceEpochByResource.set(resourceClass, epoch);
      await pgStore?.upsertPriceEpoch(epoch);
      created.push(epoch);
    }
    return { ok: true, epochs: created };
  });

  app.post("/economy/price/consensus", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // operator: sets this coordinator's price epoch
    const body = z
      .object({
        cpuCapacity: z.number().nonnegative(),
        gpuCapacity: z.number().nonnegative(),
        queuedTasks: z.number().nonnegative(),
        activeAgents: z.number().nonnegative()
      })
      .parse(req.body);
    // #53: only coordinators on MESH_PEER_ALLOWLIST, presenting the allowlisted key, can sign a
    // quote that counts; a round needs a quorum of them and the result is bounded.
    const peers = mesh
      .listPeers()
      .filter((p) => isApprovedCoordinator(p.peerId) && isAllowlistedKey(MESH_PEER_ALLOWLIST, p.peerId, p.publicKeyPem));
    const quorum = priceConsensusQuorum(MESH_PEER_ALLOWLIST.keys(), identity.peerId, PRICE_CONSENSUS_QUORUM_OVERRIDE);
    const inputs = {
      cpuCapacity: body.cpuCapacity,
      gpuCapacity: body.gpuCapacity,
      queuedTasks: body.queuedTasks,
      activeAgents: body.activeAgents
    };

    const negotiate = async (resourceClass: ResourceClass) => {
      const localPrice = computeDynamicPricePerComputeUnitSats(resourceClass, inputs);
      const quotes: Array<{ coordinatorId: string; value: number }> = [{ coordinatorId: identity.peerId, value: localPrice }];
      const rejected: Array<{ coordinatorId: string; reason: string }> = [];
      await Promise.all(
        peers.map(async (peer) => {
          try {
            const url = new URL(`${peer.coordinatorUrl}/economy/price/quote`);
            url.searchParams.set("resourceClass", resourceClass);
            url.searchParams.set("cpuCapacity", String(inputs.cpuCapacity));
            url.searchParams.set("gpuCapacity", String(inputs.gpuCapacity));
            url.searchParams.set("queuedTasks", String(inputs.queuedTasks));
            url.searchParams.set("activeAgents", String(inputs.activeAgents));
            const res = await request(url.toString(), {
              method: "GET",
              headers: MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : undefined
            });
            if (res.statusCode < 200 || res.statusCode >= 300) return;
            const quote = (await res.body.json()) as {
              coordinatorId?: string;
              resourceClass?: ResourceClass;
              pricePerComputeUnitSats?: number;
              issuedAtMs?: number;
              signature?: string;
            };
            const verdict = verifyPriceQuote({
              quote,
              expectedCoordinatorId: peer.peerId,
              resourceClass,
              inputs,
              publicKeyPem: peer.publicKeyPem,
              nowMs: Date.now(),
              maxSkewMs: PEER_SIGNATURE_MAX_SKEW_MS
            });
            if (!verdict.ok) {
              rejected.push({ coordinatorId: peer.peerId, reason: verdict.reason });
              return;
            }
            quotes.push({ coordinatorId: peer.peerId, value: quote.pricePerComputeUnitSats! });
          } catch {
            return;
          }
        })
      );
      const outcome = resolvePriceConsensus({
        quotes,
        quorum,
        previous: previousPriceEpochSats(resourceClass),
        bounds: PRICE_EPOCH_BOUNDS[resourceClass]
      });
      return { resourceClass, outcome, quotes, rejected };
    };

    const rounds = await Promise.all([negotiate("cpu"), negotiate("gpu")]);
    const failed = rounds.find((r) => !r.outcome.ok);
    if (failed) {
      return reply.code(409).send({ error: "price_quorum_not_met", resourceClass: failed.resourceClass, outcome: failed.outcome, rejected: failed.rejected });
    }
    const now = Date.now();
    const result: Record<string, unknown> = {};
    for (const round of rounds) {
      if (!round.outcome.ok) continue;
      const { resourceClass } = round;
      const finalPrice = round.outcome.price;
      const payload = JSON.stringify({
        resourceClass,
        pricePerComputeUnitSats: finalPrice,
        coordinatorId: identity.peerId,
        createdAtMs: now
      });
      const epoch: PriceEpochRecord = {
        epochId: randomUUID(),
        coordinatorId: identity.peerId,
        resourceClass,
        pricePerComputeUnitSats: finalPrice,
        supplyIndex: resourceClass === "gpu" ? inputs.gpuCapacity : inputs.cpuCapacity,
        demandIndex: inputs.queuedTasks + inputs.activeAgents,
        negotiatedWith: round.outcome.signers,
        signature: signPayload(payload, coordinatorKeys.privateKeyPem),
        createdAtMs: now
      };
      latestPriceEpochByResource.set(resourceClass, epoch);
      await pgStore?.upsertPriceEpoch(epoch);
      result[resourceClass] = { epoch, quotes: round.quotes, rejected: round.rejected, medianPrice: round.outcome.medianPrice, clamped: round.outcome.clamped };
    }
    return { ok: true, quorum, ...result };
  });
}

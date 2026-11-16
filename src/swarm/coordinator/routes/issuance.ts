// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Treasury policy and issuance routes.
 */
import { z } from "zod";
import { pgStore } from "../../../db/store.js";
import { describeAnchor } from "../../../economy/anchor-status.js";
import { createTreasuryPolicy, signKeyCustodyEvent } from "../../../economy/treasury.js";
import type { CoordinatorApp } from "../app.js";
import {
  identity,
  coordinatorKeys,
  ISSUANCE_RECALC_MS,
  ISSUANCE_WINDOW_MS,
  ANCHOR_REQUIRED_CONFIRMATIONS
} from "../context.js";
import { mutable } from "../mutable-state.js";
import { authorizeAdmin, requireMeshToken } from "../auth.js";
import { paymentIntents } from "../economy.js";
import { keyCustodyEvents } from "../services.js";
import { currentAnchoringStatus } from "../stats-ledger.js";
import {
  runIssuanceTick,
  appendQuorumRecord,
  maybeFinalizeIssuanceEpoch,
  maybeAnchorLatestFinalizedEpoch
} from "../issuance.js";

export function registerIssuanceRoutes(app: CoordinatorApp): void {
  app.post("/economy/treasury/policies", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // operator: approvedCoordinatorIds drives the issuance quorum
    const body = z
      .object({
        treasuryAccountId: z.string().min(3),
        multisigDescriptor: z.string().min(12),
        quorumThreshold: z.number().int().positive(),
        totalCustodians: z.number().int().positive(),
        approvedCoordinatorIds: z.array(z.string()).default([]),
        keyRotationDays: z.number().int().positive().default(90),
        requestedBy: z.string().default(identity.peerId)
      })
      .parse(req.body);
    if (body.quorumThreshold > body.totalCustodians) {
      return reply.code(400).send({ error: "invalid_quorum_threshold" });
    }
    const created = createTreasuryPolicy(body);
    mutable.treasuryPolicy = created;
    await pgStore?.upsertTreasuryPolicy(created);
    const event = signKeyCustodyEvent({
      policyId: created.policyId,
      actorId: body.requestedBy,
      action: "create_policy",
      details: `treasury=${created.treasuryAccountId};quorum=${created.quorumThreshold}/${created.totalCustodians}`,
      privateKeyPem: coordinatorKeys.privateKeyPem
    });
    keyCustodyEvents.unshift(event);
    await pgStore?.persistKeyCustodyEvent(event);
    return reply.send({ ok: true, policy: created, event });
  });

  app.post("/economy/treasury/policies/:policyId/activate", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // operator
    const params = z.object({ policyId: z.string() }).parse(req.params);
    const body = z.object({ requestedBy: z.string().default(identity.peerId) }).parse(req.body);
    if (!mutable.treasuryPolicy || mutable.treasuryPolicy.policyId !== params.policyId) {
      return reply.code(404).send({ error: "policy_not_found" });
    }
    mutable.treasuryPolicy = {
      ...mutable.treasuryPolicy,
      status: "active",
      updatedAtMs: Date.now()
    };
    await pgStore?.upsertTreasuryPolicy(mutable.treasuryPolicy);
    const event = signKeyCustodyEvent({
      policyId: mutable.treasuryPolicy.policyId,
      actorId: body.requestedBy,
      action: "activate_policy",
      details: `policy_activated`,
      privateKeyPem: coordinatorKeys.privateKeyPem
    });
    keyCustodyEvents.unshift(event);
    await pgStore?.persistKeyCustodyEvent(event);
    return reply.send({ ok: true, policy: mutable.treasuryPolicy, event });
  });

  app.get("/economy/treasury", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const policy = mutable.treasuryPolicy ?? (await pgStore?.latestTreasuryPolicy()) ?? null;
    const events =
      policy != null
        ? (await pgStore?.listKeyCustodyEvents(policy.policyId, 100)) ?? keyCustodyEvents.slice(0, 100)
        : [];
    return reply.send({ policy, events });
  });

  app.post("/economy/issuance/recalculate", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // operator; the issuance timer runs it automatically
    const result = await runIssuanceTick();
    return { ok: true, epoch: result.epoch ?? null, allocations: result.allocations.length };
  });

  app.get("/economy/issuance/current", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const epoch = await pgStore?.latestIssuanceEpoch(false, ISSUANCE_RECALC_MS);
    if (!epoch || !pgStore) return { epoch: null, allocations: [] };
    const allocations = await pgStore.listIssuanceAllocations(epoch.issuanceEpochId);
    return { epoch, allocations };
  });

  app.get("/economy/issuance/history", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(48) }).parse(req.query);
    const epochs = (await pgStore?.listIssuanceEpochs(query.limit, ISSUANCE_RECALC_MS)) ?? [];
    return { epochs };
  });

  app.get("/economy/issuance/rolling/:accountId", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    if (!pgStore) return { accountId: null, shares: [] };
    const params = z.object({ accountId: z.string().min(1) }).parse(req.params);
    const now = Date.now();
    const shares = await pgStore.rollingContributionShares(now - ISSUANCE_WINDOW_MS, now);
    const account = shares.find((item) => item.accountId === params.accountId) ?? null;
    return { accountId: params.accountId, windowMs: ISSUANCE_WINDOW_MS, account };
  });

  app.post("/economy/issuance/quorum/vote", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // operator: the vote is cast with this coordinator's identity
    const body = z
      .object({
        epochId: z.string(),
        vote: z.enum(["approve", "reject"])
      })
      .parse(req.body);
    const record = await appendQuorumRecord({
      recordType: "issuance_vote",
      epochId: body.epochId,
      payload: {
        vote: body.vote,
        voterCoordinatorId: identity.peerId
      }
    });
    const store = pgStore;
    const epoch = await store?.getIssuanceEpoch(body.epochId);
    if (epoch && store) {
      await store.withIssuanceLock(() => maybeFinalizeIssuanceEpoch(epoch));
    }
    return { ok: true, record };
  });

  app.get("/economy/issuance/quorum/:epochId", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const params = z.object({ epochId: z.string() }).parse(req.params);
    const records = (await pgStore?.listQuorumLedgerByEpoch(params.epochId)) ?? [];
    return { epochId: params.epochId, records };
  });

  // #100: each call can spend real sats, so manual anchor triggers need the admin token
  // (a mesh token is not enough). The #46 per-checkpoint lock and daily budget still apply.
  app.post("/economy/issuance/anchor", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const anchor = await maybeAnchorLatestFinalizedEpoch();
    return { ok: true, anchoring: currentAnchoringStatus(), anchor: anchor ? describeAnchor(anchor, ANCHOR_REQUIRED_CONFIRMATIONS) : null };
  });

  app.get("/economy/issuance/anchors", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const anchors = (await pgStore?.listAnchors(50)) ?? [];
    // #46: read-time view; legacy simulated rows are labelled, not returned as "anchored".
    return { anchoring: currentAnchoringStatus(), anchors: anchors.map((a) => describeAnchor(a, ANCHOR_REQUIRED_CONFIRMATIONS)) };
  });

  app.post("/economy/issuance/reconcile", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    if (!pgStore) return { ok: true, scannedIntents: 0, payoutEvents: 0, drift: 0 };
    const intents = [...paymentIntents.values()];
    const payoutEvents = await pgStore.listIssuancePayoutEvents(undefined, 2000);
    const eventIntentIds = new Set(payoutEvents.map((item) => item.sourceIntentId).filter(Boolean));
    const settledIntentCount = intents.filter((item) => item.status === "settled").length;
    const drift = intents.filter((item) => item.status === "settled" && !eventIntentIds.has(item.intentId)).length;
    return { ok: true, scannedIntents: intents.length, settledIntentCount, payoutEvents: payoutEvents.length, drift };
  });
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Economy routes: current price and rates, payouts, infrastructure hosts, the fee pool and
 * ledger verification.
 */
import { z } from "zod";
import { readHeaderValue } from "../../coordinator-utils.js";
import { verifyOrderingChain } from "../../../ledger/verify.js";
import { NETWORK_FEE_POOL_ACCOUNT } from "../../../credits/store.js";
import { callbackPinStatus } from "../../../economy/lnurl-callback-pin.js";
import { validateLightningAddress } from "../../../economy/payout-destination.js";
import { pgStore } from "../../../db/store.js";
import { isRateEpochStale } from "../../../economy/rate-oracle.js";
import { HOST_HEARTBEAT_MAX_SKEW_MS, verifyHostHeartbeat } from "../../../economy/host-attestation.js";
import { verifyNonce } from "../../../security/nonce-verifier.js";
import type { CoordinatorApp } from "../app.js";
import {
  BITCOIN_NETWORK,
  identity,
  mesh,
  nonceStore,
  SECURITY_NONCE_TTL_MS,
  securityLog,
  CC,
  coordinatorKeys
} from "../context.js";
import { mutable } from "../mutable-state.js";
import { ordering } from "../agent-state.js";
import { requireMeshToken, requireMeshOrPortalToken, requirePortalServiceToken, authorizeAdmin } from "../auth.js";
import {
  latestPriceEpochByResource,
  quoteSatsPerCredit,
  RATE_ORACLE_ENABLED,
  RATE_RECALIBRATION_MS,
  rateOracleConfig,
  NETWORK_FEE_BPS
} from "../economy.js";
import {
  payoutService,
  payoutStore,
  callbackPins,
  payoutPolicy,
  ECONOMY_PAYMENTS_ENABLED,
  payoutLimits,
  launchConfig,
  payoutPause,
  memoryPayoutStore,
  RESERVED_HOST_ACCOUNTS,
  hostAttestor,
  runFeePoolDistribution
} from "../payouts.js";
import { recordInfraHeartbeat } from "../infra-hosts.js";
import { launchUsageFor } from "../payments.js";
import { launchPolicyView } from "../../../economy/launch-gate.js";
import { onchainPolicyView } from "../../../economy/onchain.js";
import { onchainConfig, onchainPayoutStore } from "../onchain.js";
import { verifyCreditLedger, alertLedgerMismatch } from "../ledger-verify.js";

export function registerEconomyRoutes(app: CoordinatorApp): void {
  app.get("/economy/price/current", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const cpu = latestPriceEpochByResource.get("cpu");
    const gpu = latestPriceEpochByResource.get("gpu");
    return { cpu, gpu, quote: { cpu: quoteSatsPerCredit("cpu"), gpu: quoteSatsPerCredit("gpu") } };
  });

  /** Current rate-oracle epoch (market sats per CPU/GPU hour, sources, hashprice signal) and the live credit quote. */
  app.get("/economy/rates/current", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    return {
      enabled: RATE_ORACLE_ENABLED,
      recalibrationMs: RATE_RECALIBRATION_MS,
      epoch: mutable.latestRateEpoch,
      stale: isRateEpochStale(mutable.latestRateEpoch, rateOracleConfig),
      quote: { cpu: quoteSatsPerCredit("cpu"), gpu: quoteSatsPerCredit("gpu") },
      config: {
        usdPerCpuHourReference: rateOracleConfig.usdPerCpuHourReference,
        usdPerGpuHourReference: rateOracleConfig.usdPerGpuHourReference,
        networkMarkupBps: rateOracleConfig.networkMarkupBps,
        maxDailyMovePct: rateOracleConfig.maxDailyMovePct,
        maxSourceSpreadPct: rateOracleConfig.maxSourceSpreadPct,
        minSources: rateOracleConfig.minSources,
        btcUsdSources: rateOracleConfig.btcUsdSources.map((s) => s.name),
        computeSources: rateOracleConfig.computeSources.map((s) => `${s.name}(${s.resourceClass ?? "cpu"})`)
      }
    };
  });

  app.get("/economy/rates/history", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const query = z.object({ limit: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const epochs = pgStore ? await pgStore.listRateEpochs(query.limit) : mutable.latestRateEpoch ? [mutable.latestRateEpoch] : [];
    return { epochs };
  });

  /** Order book per compute class: asks (agents), bids (open tasks), spread, clearing price, oracle reference. */
  // ── Payouts, infrastructure hosts and the fee pool ──
  app.get("/economy/payouts/:accountId", async (req, reply) => {
    if (!requirePortalServiceToken(req as any, reply)) return;
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(req.params);
    const [balance, payouts, pins, onchainDestination] = await Promise.all([
      payoutService.balance(accountId),
      payoutStore.listPayouts(accountId, 100),
      callbackPins.listCallbackPins(accountId),
      onchainConfig.enabled ? onchainPayoutStore.getOnchainDestination(accountId) : Promise.resolve(null)
    ]);
    const launch = launchPolicyView(launchConfig, launchConfig.mode === "invite" ? (await launchUsageFor(accountId)).boughtWindowSats : undefined);
    return {
      accountId,
      balance,
      payouts,
      callbackPins: callbackPinStatus(pins),
      onchainDestination: onchainDestination ? { address: onchainDestination.address, updatedAtMs: onchainDestination.updatedAtMs } : null,
      policy: { ...payoutPolicy, lightningEnabled: ECONOMY_PAYMENTS_ENABLED, limits: payoutLimits, paused: await payoutPause.isPaused(), launch, onchain: onchainPolicyView(onchainConfig) }
    };
  });
  app.post("/economy/payouts/withdraw", async (req, reply) => {
    if (!requirePortalServiceToken(req as any, reply)) return;
    const parsed = z.object({ accountId: z.string().min(1), bolt11: z.string().min(20).max(4096) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_request", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    const body = parsed.data;
    const result = await payoutService.withdraw(body.accountId, body.bolt11.trim());
    if (!result.ok) return reply.code(result.code === "payout_unconfirmed" ? 202 : result.code === "payouts_paused" ? 503 : 400).send(result);
    return result;
  });
  app.post("/economy/payouts/address", async (req, reply) => {
    if (!requirePortalServiceToken(req as any, reply)) return;
    const parsedAddr = z.object({ accountId: z.string().min(1), lightningAddress: z.string().max(256).nullable() }).safeParse(req.body ?? {});
    if (!parsedAddr.success) return reply.code(400).send({ error: "invalid_request" });
    const body = parsedAddr.data;
    const address = body.lightningAddress?.trim() || null;
    if (address && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) && !/^https:\/\//i.test(address) && !/^lnurl1/i.test(address)) {
      return reply.code(400).send({ error: "invalid_lightning_address" });
    }
    if (pgStore) await pgStore.setLightningAddress(body.accountId, address, BITCOIN_NETWORK); // resets the old destination's callback pin
    else if (memoryPayoutStore) {
      await callbackPins.resetCallbackPins(body.accountId, address);
      if (address) memoryPayoutStore.autoAccounts.set(body.accountId, address);
      else memoryPayoutStore.autoAccounts.delete(body.accountId);
    }
    // One payout destination per account: a Lightning address replaces an on-chain one.
    if (address) await onchainPayoutStore.setOnchainDestination(body.accountId, null, BITCOIN_NETWORK);
    // Pin the callback host now, in the background so the portal's save is not held up by the
    // wallet's server; if the address does not resolve, it is pinned at its first payout.
    if (address) {
      void payoutService.pinDestination(body.accountId, address)
        .then((r) => app.log.info({ accountId: body.accountId, result: r.ok ? r.pinned : r.code }, "payout_callback_pin_on_save"))
        .catch((error) => app.log.warn({ error: String(error) }, "payout_callback_pin_on_save_failed"));
    }
    return { accountId: body.accountId, lightningAddress: address };
  });
  // The owner confirmed (portal, emailed code) that the destination's new payment server is theirs:
  // re-pin to it and resume payouts. Only the change on record can be confirmed.
  app.post("/economy/payouts/callback/confirm", async (req, reply) => {
    if (!requirePortalServiceToken(req as any, reply)) return;
    const parsed = z.object({ accountId: z.string().min(1).max(128), destination: z.string().min(3).max(512), newOrigin: z.string().min(8).max(300) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_request" });
    const { accountId, destination, newOrigin } = parsed.data;
    const ok = await callbackPins.confirmCallbackChange(accountId, destination, newOrigin, Date.now());
    if (!ok) return reply.code(409).send({ ok: false, error: "callback_change_not_pending" });
    app.log.info({ accountId, destination, newOrigin }, "payout_callback_change_confirmed");
    return { ok: true, callbackPins: callbackPinStatus(await callbackPins.listCallbackPins(accountId)) };
  });
  // Remote infrastructure hosts: signed by the host's coordinator key (the one the mesh admitted for
  // hostId), single-use, and only attested services count (src/economy/host-attestation.ts).
  app.post("/economy/hosts/heartbeat", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const parsed = z
      .object({
        hostId: z.string().min(3).max(128),
        accountId: z.string().min(1).max(128).optional(),
        services: z.array(z.string().min(1).max(32)).min(1).max(8),
        region: z.string().max(32).optional(),
        coordinatorUrl: z.string().url().optional(),
        lightningAddress: z.string().max(256).refine((v) => validateLightningAddress(v).ok, "invalid lightningAddress").optional(),
        lightningNodeId: z.string().regex(/^0[23][0-9a-fA-F]{64}$/).optional(),
        ports: z.object({ bitcoind: z.number().int().min(1).max(65535), lightning: z.number().int().min(1).max(65535), electrs: z.number().int().min(1).max(65535) }).partial().optional(),
        issuedAtMs: z.number().int(),
        signature: z.string().min(16).max(512)
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_heartbeat", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    const body = parsed.data;
    // Our own heartbeat is recorded in-process; a remote one claiming our id is an impersonation.
    const peer = body.hostId === identity.peerId ? undefined : mesh.listPeers().find((p) => p.peerId === body.hostId);
    const verdict = verifyHostHeartbeat(body, peer?.publicKeyPem, { reservedAccounts: RESERVED_HOST_ACCOUNTS });
    const replayed = verdict.ok && !(await verifyNonce(nonceStore, { nonce: `host-hb:${body.signature}`, sourceId: body.hostId, timestampMs: body.issuedAtMs, maxSkewMs: HOST_HEARTBEAT_MAX_SKEW_MS, ttlMs: SECURITY_NONCE_TTL_MS })).valid;
    if (!verdict.ok || replayed || !peer) {
      const reason = !verdict.ok ? verdict.reason : replayed ? "replayed_heartbeat" : "host_unknown";
      securityLog.log({
        level: securityLog.severity("host_heartbeat_rejected"),
        event: "host_heartbeat_rejected",
        source: { type: "coordinator", id: body.hostId, ip: req.ip },
        details: { reason },
        action: "reject_request",
        coordinatorId: identity.peerId
      });
      return reply.code(reason === "host_unknown" ? 403 : 401).send({ ok: false, error: reason });
    }
    const attestation = await hostAttestor.attest({
      hostId: body.hostId,
      publicKeyPem: peer.publicKeyPem,
      coordinatorUrl: peer.coordinatorUrl,
      services: body.services,
      lightningNodeId: body.lightningNodeId,
      ports: body.ports
    });
    // Uptime means reachable: a host whose coordinator does not answer for its key earns nothing.
    if (!attestation.attested.includes("coordinator")) {
      return reply.code(409).send({ ok: false, error: "coordinator_unreachable", attestation: attestation.results });
    }
    const { host, counted } = await recordInfraHeartbeat({
      hostId: body.hostId,
      accountId: body.accountId,
      declaredServices: body.services,
      attestation,
      region: body.region,
      coordinatorUrl: peer.coordinatorUrl,
      lightningAddress: body.lightningAddress,
      lightningNodeId: body.lightningNodeId
    });
    return { ok: true, counted, host, attestation: attestation.results, heartbeatMs: CC.HOST_HEARTBEAT_MS };
  });
  app.get("/economy/hosts", async (req, reply) => {
    if (!requireMeshOrPortalToken(req as any, reply)) return;
    const hosts = await payoutStore.listInfrastructureHosts();
    const expectedHeartbeats = Math.max(1, Math.floor(CC.FEE_POOL_DISTRIBUTION_MS / CC.HOST_HEARTBEAT_MS));
    return { hosts, expectedHeartbeats, distributionMs: CC.FEE_POOL_DISTRIBUTION_MS };
  });
  app.get("/economy/fee-pool", async (req, reply) => {
    if (!requireMeshOrPortalToken(req as any, reply)) return;
    const [earnedMsat, distributedMsat, credits] = await Promise.all([
      payoutStore.earnedMsat(NETWORK_FEE_POOL_ACCOUNT),
      payoutStore.distributedMsat(NETWORK_FEE_POOL_ACCOUNT),
      payoutStore.creditBalance(NETWORK_FEE_POOL_ACCOUNT)
    ]);
    return { accountId: NETWORK_FEE_POOL_ACCOUNT, earnedMsat, distributedMsat, availableMsat: Math.max(0, earnedMsat - distributedMsat), credits, networkFeeBps: NETWORK_FEE_BPS, lastDistribution: mutable.lastFeePoolDistribution };
  });

  /**
   * Mesh token only: this process's in-memory ordering chain (hash and signature check), as before.
   * With x-admin-token (#115): the full reconciliation of the credits ledger in Postgres.
   */
  app.get("/ledger/verify", async (req, reply) => {
    const chain = verifyOrderingChain(ordering.snapshot(), coordinatorKeys.publicKeyPem);
    if (readHeaderValue((req as any).headers ?? {}, "x-admin-token") === undefined) return { ok: chain.ok, reason: chain.reason };
    if (!authorizeAdmin(req, reply)) return;
    const query = z.object({ max: z.coerce.number().int().min(1).max(500).default(20) }).safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    if (!pgStore) return reply.code(503).send({ error: "ledger_verify_requires_postgres" });
    const result = (await verifyCreditLedger(query.data.max))!;
    alertLedgerMismatch(result, "admin");
    return { ...result, orderingChain: { ok: chain.ok, reason: chain.reason } };
  });

  app.post("/economy/fee-pool/distribute", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // manual override; the daily timer runs it automatically (audit econ#3)
    return runFeePoolDistribution({ manual: true });
  });
}

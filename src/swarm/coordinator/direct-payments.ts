// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Direct (non-custodial) payment paths on the coordinator, behind feature flags
 * (src/economy/direct/flags.ts; docs/design/noncustodial-payments.md):
 *
 * - PAYMENTS_DIRECT_RESERVATIONS: reservations paid buyer → host over Lightning, on-chain BTC or
 *   Zcash, with the 5 % fee paid directly to EdgeCoder's own addresses.
 * - PAYMENTS_NWC: optional pay-as-you-go from the buyer's own wallet (NWC tally, settled to hosts).
 *
 * The prepaid cSats wallet (Buy cSats, reserve and settle per call) is unchanged and stays the
 * default for spot compute.
 *
 * Prototype storage is in memory (payout profiles, quotes, NWC connections, tallies): persisting
 * them needs new tables (a migration, owner approval). Leases activated here are stored in the
 * existing compute_reservations rows (record_json carries `direct`).
 */

import { z } from "zod";
import { paymentFlags, tallyLimitsFromEnv } from "../../economy/direct/flags.js";
import { resolveLnurlPayInvoice } from "../../economy/direct/lnurl-pay.js";
import { NwcClient, parseNwcUri, describeNwcConnection } from "../../economy/direct/nwc.js";
import { defaultEsploraUrl, EsploraChainSource } from "../../economy/direct/onchain-direct.js";
import { ReceiptSigner, type SettlementReceipt } from "../../economy/direct/receipts.js";
import {
  DirectReservationService,
  MemoryPayoutProfileStore,
  publicPayoutProfile,
  validatePayoutProfileInput,
  type DirectQuote,
} from "../../economy/direct/reservations-direct.js";
import { openSecret, sealSecret, secretBoxKey } from "../../economy/direct/secret-box.js";
import { TallyEngine, type PayerWallet } from "../../economy/direct/tally.js";
import { ZcashdRpc, ZcashViewingKeyVerifier } from "../../economy/direct/zcash.js";
import { randomBytes } from "node:crypto";
import { pgStore } from "../../db/store.js";
import { ratePerSecondMsat } from "../../economy/job-pricing.js";
import type { ComputeClassId } from "../../economy/compute-classes.js";
import { app, type CoordinatorApp } from "./app.js";
import { callerAccount } from "./auth.js";
import { BITCOIN_NETWORK, FALLBACK_BTC_USD, reservations } from "./context.js";
import { classRefMsatPerCredit, NETWORK_FEE_BPS } from "./economy.js";
import { mutable } from "./mutable-state.js";
import { directQuoteHolds } from "./direct-holds.js";
import { publicReservation, reservableAgents } from "./routes/account.js";
import { RESERVATION_MAX_MINUTES, RESERVATION_MIN_MINUTES } from "../../economy/reservations.js";

export const paymentPaths = paymentFlags();

const env = process.env;
const zcashNet = env.ZCASH_NETWORK === "main" ? "main" : "test";
const testHarness = BITCOIN_NETWORK !== "bitcoin" && env.DIRECT_PAY_DEV_HTTP === "1";

/** Wallet secrets at rest: NONCUSTODIAL_SECRET_KEY, or a per-process key outside production. */
const boxKey = (() => {
  try {
    return secretBoxKey();
  } catch (err) {
    if (env.NODE_ENV === "production" && (paymentPaths.nwc || paymentPaths.directReservations)) throw err;
    return randomBytes(32);
  }
})();

export const receiptSigner = env.DIRECT_PAY_RECEIPT_KEY_PEM ? ReceiptSigner.fromPem(env.DIRECT_PAY_RECEIPT_KEY_PEM) : ReceiptSigner.generate();
export const payoutProfiles = new MemoryPayoutProfileStore();
const receiptsByAccount = new Map<string, SettlementReceipt[]>();
function keepReceipt(r: SettlementReceipt) {
  for (const a of new Set([r.buyerAccountId, r.payeeAccountId])) {
    const list = receiptsByAccount.get(a) ?? [];
    list.unshift(r);
    receiptsByAccount.set(a, list.slice(0, 200));
  }
}

const resolveInvoice = async (destination: string, amountMsat: number) => {
  const r = await resolveLnurlPayInvoice(destination, amountMsat, { network: BITCOIN_NETWORK, devHttp: testHarness, allowUncommittedDescription: testHarness && env.DIRECT_PAY_ALLOW_UNCOMMITTED === "1" });
  return { bolt11: r.bolt11, paymentHash: r.decoded.paymentHash };
};

const esplora = env.DIRECT_PAY_ESPLORA_URL ?? defaultEsploraUrl(BITCOIN_NETWORK);

export const directReservations = new DirectReservationService({
  network: BITCOIN_NETWORK,
  feeBps: NETWORK_FEE_BPS,
  edgecoder: {
    lightningAddress: env.EDGECODER_FEE_LIGHTNING_ADDRESS,
    btcAddress: env.EDGECODER_FEE_BTC_ADDRESS,
    zcashAddress: env.EDGECODER_FEE_ZCASH_ADDRESS,
    zcashViewingKey: env.EDGECODER_FEE_ZCASH_VIEWING_KEY,
  },
  profiles: payoutProfiles,
  resolveInvoice,
  ...(esplora ? { chain: new EsploraChainSource(esplora) } : {}),
  ...(env.ZCASHD_RPC_URL ? { zcash: new ZcashViewingKeyVerifier(new ZcashdRpc(env.ZCASHD_RPC_URL, env.ZCASHD_RPC_USER ? { user: env.ZCASHD_RPC_USER, password: env.ZCASHD_RPC_PASSWORD ?? "" } : undefined), zcashNet) } : {}),
  rates: () => ({ btcUsd: mutable.latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD, ...(Number(env.ZEC_USD) > 0 ? { zecUsd: Number(env.ZEC_USD) } : {}) }),
  signer: receiptSigner,
  book: reservations,
  persist: async (r) => {
    await pgStore?.upsertReservation(r);
  },
  onchainMinConfirmations: Number(env.DIRECT_PAY_ONCHAIN_MIN_CONF) || 1,
  zcashMinConfirmations: Number(env.ZCASH_MIN_CONFIRMATIONS) || 3,
});

/* ── NWC (optional spot path) ── */

const nwcSealed = new Map<string, { sealed: string; useForSpot: boolean; connectedAtMs: number }>();
const nwcClients = new Map<string, NwcClient>();

function nwcClientFor(accountId: string): NwcClient | null {
  const row = nwcSealed.get(accountId);
  if (!row) return null;
  let c = nwcClients.get(accountId);
  if (!c) {
    c = new NwcClient(parseNwcUri(openSecret(row.sealed, boxKey, `nwc:${accountId}`)), { timeoutMs: 60_000 });
    nwcClients.set(accountId, c);
  }
  return c;
}

async function hostLightningAddress(accountId: string): Promise<string | null> {
  return (await payoutProfiles.get(accountId))?.lightningAddress ?? null;
}
const hostAddressCache = new Map<string, string | null>();

export const nwcTally = new TallyEngine({
  limits: tallyLimitsFromEnv(),
  walletFor: (buyer): PayerWallet | null => {
    const c = nwcClientFor(buyer);
    return c ? { payInvoice: (b) => c.payInvoice(b), lookupPaid: (h) => c.lookupPaid(h) } : null;
  },
  hostAddress: (host) => hostAddressCache.get(host) ?? null,
  feeAddress: env.EDGECODER_FEE_LIGHTNING_ADDRESS ?? "",
  resolveInvoice,
  signer: receiptSigner,
  onReceipt: keepReceipt,
});

/** Inference submit: does this buyer pay network calls from their own wallet (NWC)? */
export function nwcSpotBuyer(accountId: string): boolean {
  return paymentPaths.nwc && !!nwcSealed.get(accountId)?.useForSpot;
}

/** Results: one served call on the NWC path, added to the (buyer, host) and fee tallies. */
export async function recordNwcCall(buyer: string, host: string, agentMsat: number, feeMsat: number): Promise<void> {
  if (!hostAddressCache.has(host)) hostAddressCache.set(host, await hostLightningAddress(host));
  nwcTally.record(buyer, host, agentMsat, feeMsat);
  void nwcTally.tick().catch((err) => app.log.warn({ err }, "nwc_settle_tick_failed"));
}

if (paymentPaths.nwc) {
  setInterval(() => void nwcTally.tick().catch((err) => app.log.warn({ err }, "nwc_settle_tick_failed")), 60_000).unref?.();
}

/* ── Routes ── */

const profileSchema = z.object({
  lightningAddress: z.string().max(200).optional(),
  btcAddress: z.string().max(120).optional(),
  btcXpub: z.string().max(200).optional(),
  zcashAddress: z.string().max(600).optional(),
  zcashViewingKey: z.string().max(600).optional(),
});

function publicQuote(q: DirectQuote) {
  return {
    reservationId: q.reservationId, rail: q.rail, status: q.status, computeClass: q.computeClass, tier: q.tier, model: q.model, minutes: q.minutes,
    priceCSats: q.priceMsat / 1000, hostSats: q.hostSats, feeSats: q.feeSats, expiresAtMs: q.expiresAtMs,
    ...(q.lightning ? { lightning: { hostInvoice: q.lightning.host.bolt11, feeInvoice: q.lightning.fee.bolt11 } } : {}),
    ...(q.onchain ? { onchain: q.onchain } : {}),
    ...(q.zcash ? { zcash: { hostAddress: q.zcash.hostAddress, feeAddress: q.zcash.feeAddress, zatoshi: q.zcash.zatoshi, feeZatoshi: q.zcash.feeZatoshi, hostMemo: q.zcash.hostMemo, feeMemo: q.zcash.feeMemo, minConfirmations: q.zcash.minConfirmations } } : {}),
    receipts: q.receipts,
  };
}

export function registerDirectPaymentRoutes(app: CoordinatorApp): void {
  app.get("/payments/paths", async (_req, reply) => reply.send({ ...paymentPaths, network: BITCOIN_NETWORK, receiptKey: receiptSigner.publicKeyHex }));

  if (paymentPaths.directReservations || paymentPaths.nwc) {
    /** Host payout addresses: Lightning address; BTC address or xpub; Zcash address + incoming viewing key. */
    app.post("/account/payout-profile", async (req, reply) => {
      const body = z.object({ accountId: z.string().max(200).optional(), set: profileSchema.optional() }).parse(req.body ?? {});
      const caller = await callerAccount(req, "/account/payout-profile", body.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      if (body.set) {
        const set = Object.fromEntries(Object.entries(body.set).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]).filter(([, v]) => v)) as z.infer<typeof profileSchema>;
        const bad = validatePayoutProfileInput(set, { btc: BITCOIN_NETWORK, zcash: zcashNet });
        if (bad) return reply.code(400).send({ error: bad });
        await payoutProfiles.put({ accountId: caller.accountId, ...set, updatedAtMs: Date.now() });
        hostAddressCache.delete(caller.accountId);
      }
      return reply.send({ profile: publicPayoutProfile(await payoutProfiles.get(caller.accountId)) });
    });

    app.post("/account/payment-receipts", async (req, reply) => {
      const caller = await callerAccount(req, "/account/payment-receipts", (req.body as { accountId?: string } | undefined)?.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      return reply.send({ receipts: receiptsByAccount.get(caller.accountId) ?? [], receiptKey: receiptSigner.publicKeyHex });
    });
  }

  if (paymentPaths.directReservations) {
    app.post("/account/reservations/direct/quote", async (req, reply) => {
      const body = z.object({
        accountId: z.string().max(200).optional(),
        computeClass: z.enum(["cpu", "apple", "gpu", "gpu.dc"]),
        minutes: z.number().int().min(RESERVATION_MIN_MINUTES).max(RESERVATION_MAX_MINUTES * 30),
        model: z.string().min(1).max(200).optional(),
        rail: z.enum(["lightning", "onchain", "zcash"]),
      }).parse(req.body);
      const caller = await callerAccount(req, "/account/reservations/direct/quote", body.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      const agents = await reservableAgents(caller.accountId, body.computeClass as ComputeClassId, body.model);
      for (const agent of agents) {
        try {
          const q = await directReservations.quote({
            rail: body.rail, buyerAccountId: caller.accountId, hostAccountId: agent.ownerAccountId, agentId: agent.agentId, computeClass: body.computeClass,
            ...(agent.tier ? { tier: agent.tier } : {}), creditsPerSecond: agent.creditsPerSecond, ...(body.model ? { model: body.model } : {}), minutes: body.minutes,
            ratePerSecondMsat: ratePerSecondMsat(classRefMsatPerCredit(body.computeClass as ComputeClassId), agent.creditsPerSecond),
          });
          return reply.send({ quote: publicQuote(q) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // This host can't take this rail: try the next one.
          if (/^host_has_no_|direct_agent_held_by_quote/.test(msg)) continue;
          return reply.code(400).send({ error: msg });
        }
      }
      return reply.code(409).send({ error: "no_host_accepts_rail", rail: body.rail, computeClass: body.computeClass });
    });

    app.post("/account/reservations/direct/confirm", async (req, reply) => {
      const body = z.object({
        accountId: z.string().max(200).optional(),
        reservationId: z.string().min(1).max(100),
        hostPreimage: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
        feePreimage: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
        payWithNwc: z.boolean().optional(),
        hostTxid: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
        feeTxid: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
      }).parse(req.body);
      const caller = await callerAccount(req, "/account/reservations/direct/confirm", body.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      const q = directReservations.get(body.reservationId);
      if (!q || q.buyerAccountId !== caller.accountId) return reply.code(404).send({ error: "unknown_reservation" });
      try {
        let result;
        if (q.rail === "lightning") {
          let hostPreimage = body.hostPreimage;
          let feePreimage = body.feePreimage;
          if (body.payWithNwc) {
            const c = nwcClientFor(caller.accountId);
            if (!c) return reply.code(409).send({ error: "no_wallet_connected" });
            hostPreimage = (await c.payInvoice(q.lightning!.host.bolt11)).preimage;
            feePreimage = (await c.payInvoice(q.lightning!.fee.bolt11)).preimage;
          }
          if (!hostPreimage || !feePreimage) return reply.code(400).send({ error: "preimages_required" });
          result = await directReservations.submitLightning(q.reservationId, { hostPreimage, feePreimage });
        } else if (q.rail === "onchain") {
          if (!body.hostTxid || !body.feeTxid) return reply.code(400).send({ error: "txids_required" });
          result = await directReservations.checkOnchain(q.reservationId, { hostTxid: body.hostTxid, feeTxid: body.feeTxid });
        } else {
          result = await directReservations.checkZcash(q.reservationId);
        }
        if (result.status === "active") for (const r of result.quote.receipts) keepReceipt(r);
        return reply.send({ status: result.status, quote: publicQuote(result.quote), ...("reservation" in result ? { reservation: publicReservation(result.reservation) } : {}), ...("detail" in result ? { detail: result.detail } : {}) });
      } catch (err) {
        const code = (err as { code?: string }).code;
        return reply.code(402).send({ error: code ?? (err instanceof Error ? err.message : String(err)) });
      }
    });

    app.post("/account/reservations/direct/list", async (req, reply) => {
      const caller = await callerAccount(req, "/account/reservations/direct/list", (req.body as { accountId?: string } | undefined)?.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      return reply.send({ quotes: directReservations.listForBuyer(caller.accountId).map(publicQuote) });
    });

    directQuoteHolds.agentIds = () => directReservations.heldAgentIds();
  }

  if (paymentPaths.nwc || paymentPaths.directReservations) {
    /** Connect a wallet (NWC). The connection string is sealed at rest and never returned or logged. */
    app.post("/account/wallet/nwc/connect", async (req, reply) => {
      const body = z.object({ accountId: z.string().max(200).optional(), connection: z.string().min(20).max(2000), useForSpot: z.boolean().default(false) }).parse(req.body);
      const caller = await callerAccount(req, "/account/wallet/nwc/connect", body.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      let parsed;
      try {
        parsed = parseNwcUri(body.connection);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "nwc_invalid_uri" });
      }
      nwcSealed.set(caller.accountId, { sealed: sealSecret(body.connection, boxKey, `nwc:${caller.accountId}`), useForSpot: body.useForSpot && paymentPaths.nwc, connectedAtMs: Date.now() });
      nwcClients.delete(caller.accountId);
      nwcTally.resume(caller.accountId);
      return reply.send({ connected: true, wallet: describeNwcConnection(parsed), useForSpot: body.useForSpot && paymentPaths.nwc });
    });

    app.post("/account/wallet/nwc/status", async (req, reply) => {
      const caller = await callerAccount(req, "/account/wallet/nwc/status", (req.body as { accountId?: string } | undefined)?.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      const row = nwcSealed.get(caller.accountId);
      const s = nwcTally.status(caller.accountId);
      return reply.send({
        connected: !!row, useForSpot: !!row?.useForSpot, connectedAtMs: row?.connectedAtMs ?? null,
        unsettledCSats: s.unsettledMsat / 1000, capCSats: s.capMsat / 1000, paused: s.paused, lastError: s.lastError ?? null,
        tallies: s.pairs.map((p) => ({ payee: p.payee, cSats: p.msat / 1000 })),
      });
    });

    app.post("/account/wallet/nwc/settle", async (req, reply) => {
      const caller = await callerAccount(req, "/account/wallet/nwc/settle", (req.body as { accountId?: string } | undefined)?.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      const results = await nwcTally.settleBuyer(caller.accountId, true);
      return reply.send({ results: results.map((r) => (r.ok ? { ok: true, receipt: r.receipt } : r)) });
    });

    app.post("/account/wallet/nwc/disconnect", async (req, reply) => {
      const caller = await callerAccount(req, "/account/wallet/nwc/disconnect", (req.body as { accountId?: string } | undefined)?.accountId);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      nwcSealed.delete(caller.accountId);
      nwcClients.delete(caller.accountId);
      return reply.send({ connected: false, unsettledCSats: nwcTally.unsettledMsat(caller.accountId) / 1000 });
    });
  }
}

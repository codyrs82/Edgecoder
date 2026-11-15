// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * On-chain Bitcoin routes (ONCHAIN_ENABLED): an account's deposit address and deposits, its
 * on-chain payout address, and the operator's view of batches and held deposits.
 */
import { z } from "zod";
import { pgStore } from "../../../db/store.js";
import { bitcoinUri, onchainPolicyView, validateOnchainPayoutAddress } from "../../../economy/onchain.js";
import { depositView } from "../../../economy/onchain-deposits.js";
import { batchView } from "../../../economy/onchain-payouts.js";
import type { CoordinatorApp } from "../app.js";
import { authorizeAdmin, callerAccount, requirePortalServiceToken } from "../auth.js";
import { BITCOIN_NETWORK } from "../context.js";
import { callbackPins, memoryPayoutStore } from "../payouts.js";
import { ONCHAIN_ENABLED, depositWatcher, onchainConfig, onchainDepositStore, onchainPayoutStore, onchainPayouts } from "../onchain.js";

const DISABLED = { error: "onchain_disabled", detail: "Bitcoin on-chain is not enabled on this coordinator." };

async function depositsFor(accountId: string) {
  const [current, deposits] = await Promise.all([onchainDepositStore.latestDepositAddress(accountId), onchainDepositStore.listDeposits(accountId, 50)]);
  return {
    enabled: true,
    network: onchainConfig.network,
    address: current?.address ?? null,
    uri: current ? bitcoinUri(current.address) : null,
    confirmationsRequired: onchainConfig.depositConfirmations,
    minSats: onchainConfig.depositMinSats,
    maxSats: onchainConfig.depositMaxSats,
    deposits: deposits.map((d) => depositView(d, onchainConfig.depositConfirmations))
  };
}

export function registerOnchainRoutes(app: CoordinatorApp): void {
  /** The account's deposit address (a fresh one once the current one has received a deposit). */
  app.post("/account/onchain/address", async (req, reply) => {
    const { accountId: requested } = z.object({ accountId: z.string().max(200).optional() }).parse(req.body ?? {});
    const caller = await callerAccount(req, "/account/onchain/address", requested);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    if (!ONCHAIN_ENABLED || !depositWatcher) return reply.code(409).send(DISABLED);
    try {
      await depositWatcher.depositAddress(caller.accountId);
    } catch (error) {
      req.log.warn({ error: String(error) }, "onchain_new_address_failed");
      return reply.code(502).send({ error: "onchain_address_unavailable", detail: "The Bitcoin node could not give an address right now. Try again in a minute." });
    }
    return reply.send(await depositsFor(caller.accountId));
  });

  /** The account's current deposit address (if any) and its deposits with their confirmations. */
  app.post("/account/onchain/deposits", async (req, reply) => {
    const { accountId: requested } = z.object({ accountId: z.string().max(200).optional() }).parse(req.body ?? {});
    const caller = await callerAccount(req, "/account/onchain/deposits", requested);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    if (!ONCHAIN_ENABLED) return reply.send({ enabled: false, network: BITCOIN_NETWORK, address: null, uri: null, deposits: [] });
    return reply.send(await depositsFor(caller.accountId));
  });

  /**
   * Portal: set (or clear) the account's on-chain payout address. One payout destination per
   * account: setting an on-chain address clears the Lightning address for automatic payouts.
   */
  app.post("/economy/payouts/onchain-address", async (req, reply) => {
    if (!requirePortalServiceToken(req as any, reply)) return reply;
    const parsed = z.object({ accountId: z.string().min(1).max(200), address: z.string().max(128).nullable() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { accountId } = parsed.data;
    const raw = parsed.data.address?.trim() || null;
    if (raw === null) {
      await onchainPayoutStore.setOnchainDestination(accountId, null, BITCOIN_NETWORK);
      return { accountId, address: null };
    }
    if (!ONCHAIN_ENABLED) return reply.code(409).send(DISABLED);
    const v = validateOnchainPayoutAddress(raw, BITCOIN_NETWORK);
    if (!v.ok) return reply.code(400).send({ error: v.error, detail: v.detail });
    await onchainPayoutStore.setOnchainDestination(accountId, v.address, BITCOIN_NETWORK);
    if (pgStore) await pgStore.setLightningAddress(accountId, null, BITCOIN_NETWORK);
    else if (memoryPayoutStore) {
      memoryPayoutStore.autoAccounts.delete(accountId);
      await callbackPins.resetCallbackPins(accountId, null);
    }
    return { accountId, address: v.address, policy: onchainPolicyView(onchainConfig) };
  });

  /** Operator: batches, deposits waiting for review, and totals. */
  app.get("/admin/onchain", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return reply;
    if (!ONCHAIN_ENABLED) return { enabled: false };
    const [batches, uncreditedSats] = await Promise.all([onchainPayoutStore.listBatches({ limit: 50 }), onchainDepositStore.uncreditedDepositSats()]);
    const watched = await onchainDepositStore.listWatchedDeposits(Number.MAX_SAFE_INTEGER);
    return {
      enabled: true,
      policy: onchainPolicyView(onchainConfig),
      batches: batches.map(batchView),
      uncreditedDepositSats: uncreditedSats,
      heldDeposits: watched.filter((d) => d.status === "held").map((d) => ({ ...depositView(d, onchainConfig.depositConfirmations), accountId: d.accountId }))
    };
  });

  /** Operator: credit a deposit held by a cap, after review. */
  app.post("/admin/onchain/deposits/:txid/:vout/credit", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return reply;
    if (!depositWatcher) return reply.code(409).send(DISABLED);
    const p = z.object({ txid: z.string().regex(/^[0-9a-f]{64}$/i), vout: z.coerce.number().int().min(0).max(100_000) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_request" });
    const r = await depositWatcher.releaseHeld(p.data.txid.toLowerCase(), p.data.vout);
    if (!r.ok) return reply.code(r.code === "not_found" ? 404 : 409).send(r);
    req.log.warn({ txid: p.data.txid, vout: p.data.vout }, "onchain_deposit_released_by_admin");
    return r;
  });

  /** Operator: run the batch runner now (advance open batches; build one even if not yet due). */
  app.post("/admin/onchain/batches/run", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return reply;
    if (!onchainPayouts) return reply.code(409).send(DISABLED);
    return onchainPayouts.tick({ force: true });
  });
}

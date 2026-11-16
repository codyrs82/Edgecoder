// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * TEST NETWORKS ONLY (Mutinynet signet). End-to-end run of the direct payment paths with real
 * signet payments, buyer → payee, nothing through EdgeCoder:
 *
 *   A. NWC spot tally: priced model calls (job-pricing.ts, 30B-class token counts) recorded per
 *      (buyer, host); settled at the threshold and on the interval by the buyer's wallet over NWC.
 *   B. Direct Lightning reservation: host + fee invoices from Lightning addresses, paid by the
 *      buyer's wallet over NWC; preimages activate the lease.
 *   C. Direct on-chain commitment: host address derived from the host's vpub; the buyer's node
 *      sends to it and to EdgeCoder's fee address; txid + output checks (Esplora) activate it.
 *
 * Needs: scripts/direct-pay/lnd-nwc-wallet.ts running (the buyer's wallet), test-host-lnurl.ts
 * running (payees), and `fly` access to edgecoder-lnd-signet for the on-chain sends (part C).
 * Writes a JSON evidence file; prints no secrets.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createBase58check } from "@scure/base";
import { inferenceCostMsat, splitJobCost, usdToMsat } from "../../src/economy/job-pricing.js";
import { ReservationBook } from "../../src/economy/reservations.js";
import { resolveLnurlPayInvoice } from "../../src/economy/direct/lnurl-pay.js";
import { NwcClient, parseNwcUri } from "../../src/economy/direct/nwc.js";
import { EsploraChainSource, p2wpkhAddress } from "../../src/economy/direct/onchain-direct.js";
import { ReceiptSigner, verifyReceipt, type SettlementReceipt } from "../../src/economy/direct/receipts.js";
import { DirectReservationService, MemoryPayoutProfileStore } from "../../src/economy/direct/reservations-direct.js";
import { FEE_PAYEE, TallyEngine } from "../../src/economy/direct/tally.js";

const stateDir = process.env.NWC_STATE_DIR ?? join(process.env.HOME ?? ".", ".config/edgecoder/nwc-signet");
const lnurlBase = process.env.TEST_LNURL_BASE ?? "http://127.0.0.1:18787";
const out = process.env.E2E_OUT ?? "signet-e2e-evidence.json";
const parts = new Set((process.env.E2E_PARTS ?? "A,B,C").split(","));
const BTC_USD = Number(process.env.E2E_BTC_USD ?? 95_000);
const log = (event: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...f }));
const evidence: Record<string, unknown> = { network: "signet (Mutinynet)", startedAt: new Date().toISOString() };

const addr = (name: string) => `${lnurlBase}/.well-known/lnurlp/${name}`;
const resolveInvoice = async (destination: string, amountMsat: number) => {
  const r = await resolveLnurlPayInvoice(destination, amountMsat, { network: "signet", devHttp: true, allowUncommittedDescription: true });
  return { bolt11: r.bolt11, paymentHash: r.decoded.paymentHash, payeeNode: r.decoded.payeePubkey };
};

function lnc(args: string[]): any {
  const raw = execFileSync("fly", ["ssh", "console", "-a", "edgecoder-lnd-signet", "-q", "-C", `lnc ${args.join(" ")}`], { encoding: "utf8", timeout: 120_000 });
  return JSON.parse(raw.slice(raw.indexOf("{")));
}
function nodeBalances() {
  const ch = lnc(["channelbalance"]);
  const wb = lnc(["walletbalance"]);
  return { channelLocalSats: Number(ch.local_balance.sat), onchainConfirmedSats: Number(wb.confirmed_balance), onchainUnconfirmedSats: Number(wb.unconfirmed_balance) };
}

/** Throwaway test keys (signet, no value): the host's account vpub and EdgeCoder's fee address. */
function testKeys() {
  const sha = (s: string) => createHash("sha256").update(s).digest();
  const b58 = createBase58check((b) => new Uint8Array(createHash("sha256").update(b).digest()));
  const hostPub = secp256k1.getPublicKey(sha("edgecoder signet e2e host2 account"), true);
  const vpub = b58.encode(Buffer.concat([Buffer.from("045f1cf6", "hex"), Buffer.from([3]), Buffer.alloc(4), Buffer.from("80000000", "hex"), sha("host2 chain code"), Buffer.from(hostPub)]));
  const feeAddress = p2wpkhAddress(secp256k1.getPublicKey(sha("edgecoder signet e2e fee key"), true), "signet");
  return { vpub, feeAddress };
}

async function main() {
  const conn = parseNwcUri(readFileSync(join(stateDir, "connection.uri"), "utf8"));
  const wallet = new NwcClient(conn, { timeoutMs: 60_000 });
  const signer = ReceiptSigner.generate();
  evidence.receiptKey = signer.publicKeyHex;
  evidence.nwc = { relay: conn.relays, encryption: await wallet.negotiate(), walletPubkey: conn.walletPubkey };
  const buyerBefore = nodeBalances();
  evidence.buyerNodeBefore = buyerBefore;
  evidence.nwcBalanceBeforeMsat = await wallet.getBalanceMsat();
  log("start", { buyerBefore, encryption: (evidence.nwc as { encryption: string }).encryption });
  const receipts: SettlementReceipt[] = [];

  if (parts.has("A")) {
    // A. Spot calls priced like the coordinator prices them, two hosts, real NWC settlement.
    const intervalMs = Number(process.env.E2E_SETTLE_INTERVAL_MS ?? 20_000);
    const engine = new TallyEngine({
      limits: { settleMinSats: 200, maxUnsettledSats: 500, settleIntervalMs: intervalMs, maxFailures: 3 },
      walletFor: () => ({ payInvoice: (b) => wallet.payInvoice(b), lookupPaid: (h) => wallet.lookupPaid(h) }),
      hostAddress: (h) => addr(h),
      feeAddress: addr("edgecoder-fee"),
      resolveInvoice,
      signer,
      onReceipt: (r) => receipts.push(r),
    });
    const calls: Array<{ host: string; costMsat: number; agentMsat: number; feeMsat: number }> = [];
    const snapshots: unknown[] = [];
    let refused = 0;
    for (let i = 0; i < Number(process.env.E2E_CALLS ?? 120); i++) {
      const host = i % 4 === 3 ? "host2" : "host1";
      const priced = inferenceCostMsat({ promptTokens: 8287 + (i % 7) * 13, outputTokens: 134 + (i % 5), paramsB: 30, btcUsd: BTC_USD, durationMs: 4000, computeClass: "gpu", tierWeight: 2, perSecondCostMsat: 0, floorSlots: 2 });
      const reserve = Math.ceil(priced.costMsat * 1.5);
      const admit = engine.admit("buyer", reserve);
      if (!admit.ok) {
        refused++;
        log("admit_refused", { call: i, ...admit });
        await engine.settleBuyer("buyer", true);
      }
      const { agentMsat, feeMsat } = splitJobCost(priced.costMsat, 500);
      engine.record("buyer", host, agentMsat, feeMsat);
      calls.push({ host, costMsat: priced.costMsat, agentMsat, feeMsat });
      const before = engine.status("buyer").pairs;
      const results = await engine.tick();
      for (const r of results) if (r.ok) snapshots.push({ afterCall: i, trigger: "threshold", tallyBefore: before, receipt: { payee: r.receipt.payeeAccountId, amountMsat: r.receipt.amountMsat, paymentHash: r.receipt.paymentHash, tallyBeforeMsat: r.receipt.tallyBeforeMsat, tallyAfterMsat: r.receipt.tallyAfterMsat } });
    }
    const beforeInterval = engine.status("buyer");
    log("waiting_for_interval_settlement", { ms: intervalMs, pairs: beforeInterval.pairs });
    await new Promise((r) => setTimeout(r, intervalMs + 500));
    const results = await engine.tick();
    for (const r of results) if (r.ok) snapshots.push({ trigger: "interval", receipt: { payee: r.receipt.payeeAccountId, amountMsat: r.receipt.amountMsat, paymentHash: r.receipt.paymentHash, tallyBeforeMsat: r.receipt.tallyBeforeMsat, tallyAfterMsat: r.receipt.tallyAfterMsat } });
      else log("interval_settle_result", r);
    evidence.partA = {
      calls: calls.length, totalCostMsat: calls.reduce((a, c) => a + c.costMsat, 0), hostShareMsat: calls.reduce((a, c) => a + c.agentMsat, 0), feeMsat: calls.reduce((a, c) => a + c.feeMsat, 0),
      admitRefusedSettleFirst: refused, settlements: snapshots, tallyBeforeInterval: beforeInterval.pairs, tallyAfter: engine.status("buyer").pairs, unsettledAfterMsat: engine.unsettledMsat("buyer"),
      feeTallyAfterMsat: engine.tallyMsat("buyer", FEE_PAYEE),
    };
    log("partA_done", evidence.partA as Record<string, unknown>);
  }

  const book = new ReservationBook();
  const profiles = new MemoryPayoutProfileStore();
  const keys = testKeys();
  await profiles.put({ accountId: "host1", lightningAddress: addr("host1"), updatedAtMs: Date.now() });
  await profiles.put({ accountId: "host2", btcXpub: keys.vpub, updatedAtMs: Date.now() });
  const svc = new DirectReservationService({
    network: "signet", feeBps: 500,
    edgecoder: { lightningAddress: addr("edgecoder-fee"), btcAddress: keys.feeAddress },
    profiles, resolveInvoice, chain: new EsploraChainSource("https://mutinynet.com/api"),
    rates: () => ({ btcUsd: BTC_USD }), signer, book, onchainMinConfirmations: 1,
  });

  if (parts.has("B")) {
    // B. A 30-minute block on host1 over Lightning: 0.20 USD/h GPU tier.
    const rate = usdToMsat(0.2 / 3600, BTC_USD);
    const q = await svc.quote({ rail: "lightning", buyerAccountId: "buyer", hostAccountId: "host1", agentId: "agent-host1", computeClass: "gpu", creditsPerSecond: 2, minutes: 30, ratePerSecondMsat: rate });
    log("partB_quote", { reservationId: q.reservationId, hostSats: q.hostSats, feeSats: q.feeSats, hostHash: q.lightning!.host.paymentHash, feeHash: q.lightning!.fee.paymentHash });
    const hostPaid = await wallet.payInvoice(q.lightning!.host.bolt11);
    const feePaid = await wallet.payInvoice(q.lightning!.fee.bolt11);
    const r = await svc.submitLightning(q.reservationId, { hostPreimage: hostPaid.preimage, feePreimage: feePaid.preimage });
    receipts.push(...r.quote.receipts);
    evidence.partB = { reservationId: q.reservationId, status: r.status, hostSats: q.hostSats, feeSats: q.feeSats, hostPaymentHash: q.lightning!.host.paymentHash, feePaymentHash: q.lightning!.fee.paymentHash, lease: "reservation" in r ? { startMs: r.reservation.startMs, endMs: r.reservation.endMs, direct: r.reservation.direct } : null };
    log("partB_done", evidence.partB as Record<string, unknown>);
  }

  if (parts.has("C")) {
    // C. A 7-day server commitment on host2, on-chain: 0.12 USD/h.
    const rate = usdToMsat(0.12 / 3600, BTC_USD);
    const q = await svc.quote({ rail: "onchain", buyerAccountId: "buyer", hostAccountId: "host2", agentId: "agent-host2", computeClass: "gpu", creditsPerSecond: 1, minutes: 7 * 24 * 60, ratePerSecondMsat: rate });
    log("partC_quote", { reservationId: q.reservationId, hostSats: q.hostSats, feeSats: q.feeSats, hostAddress: q.onchain!.hostAddress, feeAddress: q.onchain!.feeAddress });
    // Two payments from the buyer's node (min_confs 0: the second may spend the first's change).
    // E2E_C_HOST_TX / E2E_C_FEE_TX resume a run whose sends already went out (same xpub index 0).
    const send = (address: string, sats: number) => lnc(["sendcoins", "--addr", address, "--amt", String(sats), "--sat_per_vbyte", "2", "--min_confs", "0", "--force"]).txid as string;
    const hostTx = process.env.E2E_C_HOST_TX ?? send(q.onchain!.hostAddress, q.hostSats);
    const feeTx = process.env.E2E_C_FEE_TX ?? send(q.onchain!.feeAddress, q.feeSats);
    log("partC_sent", { hostTx, feeTx });
    let result = await svc.checkOnchain(q.reservationId, { hostTxid: hostTx, feeTxid: feeTx });
    const statuses = [result.status];
    for (let i = 0; i < 40 && result.status !== "active"; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      result = await svc.checkOnchain(q.reservationId, { hostTxid: hostTx, feeTxid: feeTx });
      if (statuses[statuses.length - 1] !== result.status) statuses.push(result.status);
    }
    receipts.push(...result.quote.receipts);
    evidence.partC = { reservationId: q.reservationId, statuses, hostSats: q.hostSats, feeSats: q.feeSats, hostAddress: q.onchain!.hostAddress, feeAddress: q.onchain!.feeAddress, hostTx, feeTx, receipts: result.quote.receipts.map((x) => ({ payee: x.payeeKind, txid: x.txid, vout: x.vout, confirmations: x.confirmations, amountMsat: x.amountMsat })) };
    log("partC_done", evidence.partC as Record<string, unknown>);
  }

  const buyerAfter = nodeBalances();
  evidence.buyerNodeAfter = buyerAfter;
  evidence.nwcBalanceAfterMsat = await wallet.getBalanceMsat();
  evidence.receipts = receipts.map((r) => ({ id: r.id, rail: r.rail, purpose: r.purpose, payee: r.payeeKind, amountMsat: r.amountMsat, paymentHash: r.paymentHash, txid: r.txid, verified: verifyReceipt(r).ok }));
  const lnPaid = receipts.filter((r) => r.rail === "lightning").reduce((a, r) => a + r.amountMsat, 0);
  evidence.summary = {
    lightningPaidToPayeesMsat: lnPaid,
    buyerChannelDropSats: buyerBefore.channelLocalSats - buyerAfter.channelLocalSats,
    edgecoderCustody: "0 sats: the coordinator code in this run has no wallet or Lightning credentials; every payment went from the buyer's node to the payee's invoice/address. EdgeCoder's fee went to its own (test) address as a separate payment.",
  };
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  log("done", { out, summary: evidence.summary });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});

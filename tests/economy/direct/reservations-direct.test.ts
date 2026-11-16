import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReservationBook } from "../../../src/economy/reservations.js";
import { ReceiptSigner, verifyReceipt } from "../../../src/economy/direct/receipts.js";
import { DirectReservationService, MemoryPayoutProfileStore, publicPayoutProfile, validatePayoutProfileInput } from "../../../src/economy/direct/reservations-direct.js";
import type { ChainSource, ChainTx } from "../../../src/economy/direct/onchain-direct.js";
import { ZcashViewingKeyVerifier, type ZcashRpc } from "../../../src/economy/direct/zcash.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/zcashd-testnet-received.json", import.meta.url), "utf8"));
const vpub = "vpub5XzEwP9YWe4cK1jbAhPGCXubkmz6dwk6Ea5Ce7dZxRSxdZHKjBHFcSDo4ZxPxT1kUEJmJUBS3Zxpw6DbVkuQ9mHmwYGPwtSSiBQJeDGaDrp"; // test-network account key from a fixed throwaway seed (no funds)

function setup(opts: { txs?: ChainTx[]; tip?: number } = {}) {
  let now = 1_000_000;
  const preimages = new Map<string, string>();
  const profiles = new MemoryPayoutProfileStore();
  const book = new ReservationBook();
  const chain: ChainSource = { getTx: async (id) => opts.txs?.find((t) => t.txid === id) ?? null, tipHeight: async () => opts.tip ?? 0 };
  const rpc: ZcashRpc = { async call<T>(m: string, p: unknown[]) { return (m === "z_listreceivedbyaddress" ? (p[0] === fx.hostAddress ? fx.hostNotes : fx.feeNotes) : null) as T; } };
  const svc = new DirectReservationService({
    network: "signet", feeBps: 500,
    edgecoder: { lightningAddress: "fees@edgecoder.test", btcAddress: "tb1qedgecoderfee", zcashAddress: fx.feeAddress, zcashViewingKey: fx.feeViewingKey },
    profiles,
    resolveInvoice: async (destination, amountMsat) => {
      const pre = randomBytes(32).toString("hex");
      const paymentHash = createHash("sha256").update(Buffer.from(pre, "hex")).digest("hex");
      preimages.set(paymentHash, pre);
      return { bolt11: `lntbs:${destination}:${amountMsat}`, paymentHash };
    },
    chain, zcash: new ZcashViewingKeyVerifier(rpc, "test"),
    rates: () => ({ btcUsd: 95_000, zecUsd: 50 }),
    signer: ReceiptSigner.generate(), book, now: () => now,
  });
  const agent = { buyerAccountId: "buyer", hostAccountId: "host", agentId: "agent-1", computeClass: "gpu", creditsPerSecond: 2, minutes: 60, ratePerSecondMsat: 100 };
  return { svc, profiles, book, preimages, advance: (ms: number) => (now += ms), agent };
}

describe("direct Lightning reservation", () => {
  it("quotes host and fee invoices (95 / 5) and activates on both preimages", async () => {
    const { svc, profiles, book, preimages, agent } = setup();
    await profiles.put({ accountId: "host", lightningAddress: "host@hosts.test", updatedAtMs: 0 });
    const q = await svc.quote({ ...agent, rail: "lightning" });
    expect(q.priceMsat).toBe(360_000); // 60 min × 60 s × 100 msat/s
    expect([q.hostSats, q.feeSats]).toEqual([342, 18]);
    expect(q.lightning!.host.bolt11).toBe("lntbs:host@hosts.test:342000");
    expect(q.lightning!.fee.bolt11).toBe("lntbs:fees@edgecoder.test:18000");
    expect(svc.heldAgentIds().has("agent-1")).toBe(true);

    expect((await svc.submitLightning(q.reservationId, { hostPreimage: "00".repeat(32), feePreimage: "00".repeat(32) })).status).toBe("invalid_proof");
    const r = await svc.submitLightning(q.reservationId, { hostPreimage: preimages.get(q.lightning!.host.paymentHash)!, feePreimage: preimages.get(q.lightning!.fee.paymentHash)! });
    expect(r.status).toBe("active");
    const lease = book.get(q.reservationId)!;
    expect(lease).toMatchObject({ status: "active", agentId: "agent-1", accountId: "buyer", direct: { rail: "lightning" } });
    expect(lease.endMs - lease.startMs).toBe(3_600_000);
    expect(r.quote.receipts.map((x) => [x.payeeKind, x.amountMsat])).toEqual([["host", 342_000], ["edgecoder_fee", 18_000]]);
    for (const x of r.quote.receipts) expect(verifyReceipt(x)).toEqual({ ok: true });
  });

  it("refuses hosts without an address and self-reservations", async () => {
    const { svc, agent } = setup();
    await expect(svc.quote({ ...agent, rail: "lightning" })).rejects.toThrow(/host_has_no_lightning_address/);
    await expect(svc.quote({ ...agent, hostAccountId: "buyer", rail: "lightning" })).rejects.toThrow(/self/);
  });
});

describe("direct on-chain reservation (txid + output)", () => {
  it("derives a fresh address from the host's xpub and activates once both outputs confirm", async () => {
    const hostTx = "b".repeat(64);
    const feeTx = "c".repeat(64);
    const txs: ChainTx[] = [];
    const { svc, profiles, book, agent } = setup({ txs, tip: 200 });
    await profiles.put({ accountId: "host", btcXpub: vpub, updatedAtMs: 0 });
    const q = await svc.quote({ ...agent, rail: "onchain" });
    const q2addr = (await svc.quote({ ...agent, agentId: "agent-2", rail: "onchain" })).onchain!.hostAddress;
    expect(q.onchain!.hostAddress).toMatch(/^tb1q/);
    expect(q2addr).not.toBe(q.onchain!.hostAddress); // one address per quote
    txs.push({ txid: hostTx, vout: [{ scriptpubkey_address: q.onchain!.hostAddress, value: q.hostSats }], status: { confirmed: false } });
    txs.push({ txid: feeTx, vout: [{ scriptpubkey_address: "tb1qedgecoderfee", value: q.feeSats }], status: { confirmed: true, block_height: 200 } });
    expect((await svc.checkOnchain(q.reservationId, { hostTxid: hostTx, feeTxid: feeTx })).status).toBe("unconfirmed");
    txs[0].status = { confirmed: true, block_height: 200 };
    const r = await svc.checkOnchain(q.reservationId, { hostTxid: hostTx, feeTxid: feeTx });
    expect(r.status).toBe("active");
    expect(book.get(q.reservationId)?.direct?.rail).toBe("onchain");
    expect(r.quote.receipts[0]).toMatchObject({ txid: hostTx, vout: 0, amountMsat: q.hostSats * 1000 });
  });

  it("an expired quote with nothing paid expires; a payment can't be reused", async () => {
    const txs: ChainTx[] = [];
    const { svc, profiles, advance, agent } = setup({ txs, tip: 10 });
    await profiles.put({ accountId: "host", btcAddress: "tb1qhoststatic", updatedAtMs: 0 });
    const q = await svc.quote({ ...agent, rail: "onchain" });
    advance(61 * 60_000);
    expect((await svc.checkOnchain(q.reservationId, { hostTxid: "d".repeat(64), feeTxid: "e".repeat(64) })).status).toBe("expired");
    expect(svc.heldAgentIds().size).toBe(0);
  });
});

describe("direct Zcash reservation (viewing key)", () => {
  it("activates from memo'd notes seen through the host's and EdgeCoder's viewing keys", async () => {
    const { svc, profiles, book, agent } = setup();
    await profiles.put({ accountId: "host", zcashAddress: fx.hostAddress, zcashViewingKey: fx.hostViewingKey, updatedAtMs: 0 });
    const q = await svc.quote({ ...agent, rail: "zcash" });
    expect(q.zcash).toMatchObject({ hostMemo: `edgecoder:r:${q.reservationId}`, zatoshi: 342 * 1900, feeZatoshi: 18 * 1900 });
    // The fixture's notes carry another reservation id: nothing activates.
    expect((await svc.checkZcash(q.reservationId)).status).toBe("pending");
    // Same notes under this quote's id (as the buyer's wallet would write them):
    const fixtureId = fx.reservationId;
    (svc as unknown as { quotes: Map<string, unknown> }).quotes.set(fixtureId, { ...q, reservationId: fixtureId, zcash: { ...q.zcash!, hostMemo: `edgecoder:r:${fixtureId}`, feeMemo: `edgecoder:f:${fixtureId}`, expiresAtMs: fx.expiresAtMs } });
    const r = await svc.checkZcash(fixtureId);
    expect(r.status).toBe("active");
    expect(book.get(fixtureId)?.direct?.rail).toBe("zcash");
  });
});

describe("payout profile input", () => {
  it("validates per network and never shows the viewing key", () => {
    const nets = { btc: "signet" as const, zcash: "test" as const };
    expect(validatePayoutProfileInput({ lightningAddress: "me@host.test", btcXpub: vpub, zcashAddress: fx.hostAddress, zcashViewingKey: fx.hostViewingKey }, nets)).toBeNull();
    expect(validatePayoutProfileInput({ zcashAddress: fx.hostAddress }, nets)).toBe("zcash_needs_address_and_viewing_key");
    expect(validatePayoutProfileInput({ btcAddress: "bc1qmainnet" }, nets)).toBe("invalid_btc_address");
    const shown = JSON.stringify(publicPayoutProfile({ accountId: "h", zcashAddress: fx.hostAddress, zcashViewingKey: fx.hostViewingKey, updatedAtMs: 1 }));
    expect(shown).not.toContain(fx.hostViewingKey);
    expect(shown).toContain('"zcashViewingKeySet":true');
  });
});

import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { splitJobCost } from "../../../src/economy/job-pricing.js";
import { ReceiptSigner, verifyReceipt } from "../../../src/economy/direct/receipts.js";
import { FEE_PAYEE, TallyEngine, type PayerWallet } from "../../../src/economy/direct/tally.js";
import { NwcError } from "../../../src/economy/direct/nwc.js";

const limits = { settleMinSats: 200, maxUnsettledSats: 500, settleIntervalMs: 3_600_000, maxFailures: 3 };

/** A wallet that pays every invoice (or fails as told) and a resolver that mints invoices it can pay. */
function harness(opts: { fail?: () => string | null } = {}) {
  let now = 1_000_000;
  const preimages = new Map<string, string>();
  const paid: Array<{ destination: string; amountMsat: number; hash: string }> = [];
  const invoices = new Map<string, { destination: string; amountMsat: number; hash: string }>();
  const wallet: PayerWallet = {
    async payInvoice(bolt11) {
      const code = opts.fail?.();
      if (code) throw new NwcError(code);
      const inv = invoices.get(bolt11)!;
      paid.push(inv);
      return { preimage: preimages.get(inv.hash)! };
    },
  };
  const engine = new TallyEngine({
    limits,
    walletFor: (b) => (b === "nowallet" ? null : wallet),
    hostAddress: (h) => (h === "noaddr" ? null : `${h}@hosts.test`),
    feeAddress: "fees@edgecoder.test",
    resolveInvoice: async (destination, amountMsat) => {
      const pre = randomBytes(32).toString("hex");
      const hash = createHash("sha256").update(Buffer.from(pre, "hex")).digest("hex");
      preimages.set(hash, pre);
      const bolt11 = `lntbs-${hash}`;
      invoices.set(bolt11, { destination, amountMsat, hash });
      return { bolt11, paymentHash: hash };
    },
    signer: ReceiptSigner.generate(),
    now: () => now,
  });
  return { engine, paid, advance: (ms: number) => (now += ms) };
}

/** A call of `costMsat` split the way the coordinator splits it. */
function call(engine: TallyEngine, buyer: string, host: string, costMsat: number) {
  const { agentMsat, feeMsat } = splitJobCost(costMsat, 500);
  engine.record(buyer, host, agentMsat, feeMsat);
}

describe("tally math", () => {
  it("adds the host share and the 5 % fee to separate tallies", () => {
    const { engine } = harness();
    call(engine, "b", "h1", 10_000);
    call(engine, "b", "h1", 3_333);
    expect(engine.tallyMsat("b", "h1")).toBe(9_500 + 3_166);
    expect(engine.tallyMsat("b", FEE_PAYEE)).toBe(500 + 167);
    expect(engine.unsettledMsat("b")).toBe(13_333);
  });

  it("settles whole sats and carries the msat remainder", async () => {
    const { engine, paid } = harness();
    engine.record("b", "h1", 200_750, 0);
    const [r] = await engine.tick();
    expect(r.ok).toBe(true);
    expect(paid).toEqual([expect.objectContaining({ destination: "h1@hosts.test", amountMsat: 200_000 })]);
    expect(engine.tallyMsat("b", "h1")).toBe(750);
    if (r.ok) {
      expect(r.receipt.tallyBeforeMsat).toBe(200_750);
      expect(r.receipt.tallyAfterMsat).toBe(750);
      expect(verifyReceipt(r.receipt)).toEqual({ ok: true });
    }
  });

  it("the fee goes to EdgeCoder's address as its own payment", async () => {
    const { engine, paid } = harness();
    engine.record("b", "h1", 190_000, 10_000);
    engine.record("b", "h2", 0, 195_000);
    await engine.tick();
    expect(paid.map((p) => [p.destination, p.amountMsat])).toEqual([["fees@edgecoder.test", 205_000]]);
  });
});

describe("when to settle", () => {
  it("not below the threshold, yes at it", async () => {
    const { engine, paid } = harness();
    engine.record("b", "h1", 199_999, 0);
    expect(await engine.tick()).toEqual([]);
    engine.record("b", "h1", 1, 0);
    await engine.tick();
    expect(paid).toHaveLength(1);
    expect(engine.tallyMsat("b", "h1")).toBe(0);
  });

  it("hourly: a small tally settles once it has been owed for the interval", async () => {
    const { engine, paid, advance } = harness();
    engine.record("b", "h1", 12_400, 0);
    advance(3_599_000);
    expect(await engine.tick()).toEqual([]);
    advance(1_000);
    await engine.tick();
    expect(paid).toEqual([expect.objectContaining({ amountMsat: 12_000 })]);
    expect(engine.tallyMsat("b", "h1")).toBe(400);
    // the 400 msat left is under a sat: never due on its own
    advance(10 * 3_600_000);
    expect(await engine.tick()).toEqual([]);
  });

  it("a host without a payout address keeps its tally; the buyer isn't penalised", async () => {
    const { engine } = harness();
    engine.record("b", "noaddr", 300_000, 0);
    const [r] = await engine.tick();
    expect(r).toMatchObject({ ok: false, error: "payee_has_no_address", skipped: true });
    expect(engine.status("b").failures).toBe(0);
  });
});

describe("exposure cap", () => {
  it("refuses work that would take the unsettled total over the cap, then settles", async () => {
    const { engine, paid } = harness();
    engine.record("b", "h1", 150_000, 0);
    engine.record("b", "h2", 150_000, 0);
    engine.record("b", FEE_PAYEE, 0, 150_000);
    expect(engine.admit("b", 50_000)).toEqual({ ok: true });
    const r = engine.admit("b", 50_001);
    expect(r).toMatchObject({ ok: false, error: "settle_first", unsettledSats: 450, capSats: 500 });
    await new Promise((res) => setTimeout(res, 10));
    expect(paid).toHaveLength(3);
    expect(engine.unsettledMsat("b")).toBe(0);
    expect(engine.admit("b", 50_001)).toEqual({ ok: true });
  });

  it("a buyer with no wallet can't use the path", () => {
    const { engine } = harness();
    expect(engine.admit("nowallet", 1)).toEqual({ ok: false, error: "no_wallet" });
  });
});

describe("failure → backoff → pause", () => {
  it("pauses the buyer after 3 failures in a row and says why; reconnecting resumes", async () => {
    let failing = true;
    const { engine, advance, paid } = harness({ fail: () => (failing ? "QUOTA_EXCEEDED" : null) });
    engine.record("b", "h1", 250_000, 0);
    expect((await engine.tick())[0]).toMatchObject({ ok: false, error: "QUOTA_EXCEEDED" });
    // backoff: nothing happens before 30 s
    expect((await engine.tick())[0]).toMatchObject({ error: "backoff", skipped: true });
    advance(30_000);
    await engine.tick();
    advance(120_000);
    await engine.tick();
    expect(engine.status("b").paused).toMatchObject({ reason: "payment_failed:QUOTA_EXCEEDED" });
    expect(engine.admit("b", 1)).toMatchObject({ ok: false, error: "paused", reason: "payment_failed:QUOTA_EXCEEDED" });
    failing = false;
    engine.resume("b");
    expect(engine.admit("b", 1)).toEqual({ ok: true });
    await engine.tick();
    expect(paid).toHaveLength(1);
    expect(engine.unsettledMsat("b")).toBe(0);
  });

  it("a timed-out payment is looked up before paying again (no double pay)", async () => {
    const calls: string[] = [];
    let preimage = "";
    let hash = "";
    const engine = new TallyEngine({
      limits,
      walletFor: () => ({
        async payInvoice() {
          calls.push("pay");
          throw new NwcError("TIMEOUT");
        },
        async lookupPaid(h) {
          calls.push("lookup");
          return h === hash ? preimage : null;
        },
      }),
      hostAddress: () => "h@hosts.test",
      feeAddress: "f@e.test",
      resolveInvoice: async () => {
        preimage = randomBytes(32).toString("hex");
        hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
        return { bolt11: "lntbs1x", paymentHash: hash };
      },
      signer: ReceiptSigner.generate(),
      now: (() => {
        let t = 0;
        return () => (t += 60_000);
      })(),
    });
    engine.record("b", "h", 200_000, 0);
    await engine.tick();
    const [r] = await engine.tick();
    expect(calls).toEqual(["pay", "lookup"]);
    expect(r.ok).toBe(true);
    expect(engine.tallyMsat("b", "h")).toBe(0);
  });
});

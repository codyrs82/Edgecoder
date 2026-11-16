import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeMemoHex, encodeMemoHex, matchMemoPayment, quoteZec, reservationMemo, validIncomingViewingKey, validShieldedAddress, ZcashViewingKeyVerifier, type ReceivedNote, type ZcashRpc,
} from "../../../src/economy/direct/zcash.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/zcashd-testnet-received.json", import.meta.url), "utf8"));

describe("Zcash memo", () => {
  it("encodes the reservation id into a 512-byte memo and back", () => {
    const m = reservationMemo("host", "res-abc");
    expect(m).toBe("edgecoder:r:res-abc");
    const hex = encodeMemoHex(m);
    expect(hex).toHaveLength(1024);
    expect(decodeMemoHex(hex)).toBe(m);
  });
  it("treats 0xF6 (no memo) and non-text memos as empty", () => {
    expect(decodeMemoHex("f6" + "00".repeat(511))).toBeNull();
    expect(decodeMemoHex("ff" + "00".repeat(511))).toBeNull();
  });
  it("refuses ids that could forge another memo", () => {
    expect(() => reservationMemo("host", "a:b")).toThrow();
  });
});

describe("quotes", () => {
  it("converts sats to zatoshi at the quote-time rate, rounding up, with an expiry", () => {
    const q = quoteZec({ reservationId: "r1", priceSats: 1900, feeSats: 100, btcUsd: 95_000, zecUsd: 50, nowMs: 0, hostAddress: fx.hostAddress, feeAddress: fx.feeAddress });
    expect(q.zatoshi).toBe(1900 * 1900); // 1 sat = 1900 zat at 95k / 50
    expect(q.feeZatoshi).toBe(190_000);
    expect(q.expiresAtMs).toBe(30 * 60_000);
    expect(q.hostMemo).toBe("edgecoder:r:r1");
    expect(q.feeMemo).toBe("edgecoder:f:r1");
  });
});

describe("viewing-key verification against fixtures", () => {
  const base = { memo: `edgecoder:r:${fx.reservationId}`, minZatoshi: 1_230_000, minConfirmations: 3, expiresAtMs: fx.expiresAtMs };

  it("finds the memo'd note and ignores unrelated and change notes", () => {
    expect(matchMemoPayment(fx.hostNotes, base)).toMatchObject({ status: "paid", zatoshi: 1_230_000, confirmations: 5 });
  });
  it("underpaid when the notes don't cover the quote", () => {
    expect(matchMemoPayment(fx.hostNotes, { ...base, minZatoshi: 1_230_001 })).toMatchObject({ status: "underpaid" });
  });
  it("unconfirmed below the confirmation target", () => {
    expect(matchMemoPayment(fx.hostNotes, { ...base, minConfirmations: 6 })).toMatchObject({ status: "unconfirmed" });
  });
  it("late when mined after the quote expired", () => {
    expect(matchMemoPayment(fx.hostNotes, { ...base, expiresAtMs: 1763290400000 })).toMatchObject({ status: "late" });
  });
  it("not found for another reservation, and a note is never counted twice", () => {
    expect(matchMemoPayment(fx.hostNotes, { ...base, memo: "edgecoder:r:other" })).toEqual({ status: "not_found" });
    const n = fx.hostNotes[0] as ReceivedNote;
    expect(matchMemoPayment(fx.hostNotes, { ...base, used: new Set([`${n.txid}:0`]) })).toEqual({ status: "not_found" });
  });

  it("the verifier imports the viewing key once (read-only) and reads notes over RPC", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const rpc: ZcashRpc = {
      async call<T>(method: string, params: unknown[]) {
        calls.push([method, params]);
        return (method === "z_listreceivedbyaddress" ? (params[0] === fx.hostAddress ? fx.hostNotes : fx.feeNotes) : null) as T;
      },
    };
    const v = new ZcashViewingKeyVerifier(rpc, "test");
    const r1 = await v.check({ ...base, address: fx.hostAddress, viewingKey: fx.hostViewingKey, startHeight: 3_519_990 });
    const r2 = await v.check({ ...base, address: fx.hostAddress, viewingKey: fx.hostViewingKey });
    expect(r1.status).toBe("paid");
    expect(r2.status).toBe("paid");
    expect(calls.filter(([m]) => m === "z_importviewingkey")).toEqual([["z_importviewingkey", [fx.hostViewingKey, "whenkeyisnew", 3_519_990]]]);
  });

  it("checks address and key shapes per network", () => {
    expect(validShieldedAddress(fx.hostAddress, "test")).toBe(true);
    expect(validShieldedAddress(fx.hostAddress, "main")).toBe(false);
    expect(validIncomingViewingKey(fx.hostViewingKey, "test")).toBe(true);
    // a spending key is never accepted where a viewing key is expected
    expect(validIncomingViewingKey("secret-extended-key-test1" + "q".repeat(60), "test")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { activityText, countdown, fmtMsat, fmtUsd, networkInfo, purchasePreview, reasonText, routingFeeNote } from "../src/lib/wallet-format";

describe("wallet formatting", () => {
  it("previews the purchase fee the way the coordinator computes it (free by default; 1.5 % if set)", () => {
    expect(purchasePreview(20_000, 0)).toEqual({ fee: 0, get: 20_000 });
    expect(purchasePreview(20_000, 150)).toEqual({ fee: 300, get: 19_700 });
    expect(purchasePreview(10_000, 150)).toEqual({ fee: 150, get: 9_850 });
    expect(purchasePreview(101, 150)).toEqual({ fee: 1, get: 100 });
  });
  it("marks every network but mainnet as test sats", () => {
    expect(networkInfo("bitcoin")).toMatchObject({ test: false, tone: "main" });
    for (const n of ["regtest", "testnet", "signet", undefined]) expect(networkInfo(n).test, String(n)).toBe(true);
  });
  it("shows USD only with a rate", () => {
    expect(fmtUsd(20_000, 100_000)).toBe("≈ $20.00");
    expect(fmtUsd(100, 100_000)).toBe("≈ $0.100");
    expect(fmtUsd(20_000, null)).toBe("");
  });
  it("names ledger rows in plain words", () => {
    expect(reasonText("credit_purchase:pi-1")).toBe("Bought cSats");
    expect(reasonText("something_new:x")).toBe("something new");
  });
  it("names a routing-fee row with the coordinator that routed the call, and notes routing fees in the earnings", () => {
    expect(activityText({ reason: "routing_fee:t1", coordinator: "coord.example.org" })).toBe("Routing fee (coordinator coord.example.org)");
    expect(activityText({ reason: "routing_fee:t1" })).toBe("Routing fee");
    expect(activityText({ reason: "compute_contribution" })).toBe("Earned running jobs");
    expect(routingFeeNote(2.4)).toBe("incl. 2.4 sats routing fees");
    expect(routingFeeNote(0)).toBe("");
    expect(routingFeeNote(undefined)).toBe("");
  });
  it("shows earnings below 1 sat (msat with 3 decimals)", () => {
    expect(fmtMsat(420)).toBe("0.42");
    expect(fmtMsat(1_234_567)).toBe("1,234.567");
    expect(fmtMsat(0)).toBe("0");
  });
  it("counts an invoice down", () => {
    expect(countdown(65_000)).toBe("Expires in 1:05");
    expect(countdown(0)).toBe("Expiring…");
  });
});

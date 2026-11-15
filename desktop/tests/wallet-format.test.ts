import { describe, expect, it } from "vitest";
import { countdown, fmtUsd, networkInfo, purchasePreview, reasonText } from "../src/lib/wallet-format";

describe("wallet formatting", () => {
  it("previews the purchase fee the way the coordinator computes it (1.5 %: 20,000 sats -> 19,700 cSats)", () => {
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
  it("counts an invoice down", () => {
    expect(countdown(65_000)).toBe("Expires in 1:05");
    expect(countdown(0)).toBe("Expiring…");
  });
});

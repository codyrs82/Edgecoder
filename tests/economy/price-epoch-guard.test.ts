import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import {
  checkPriceEpoch,
  clampPriceEpoch,
  priceConsensusQuorum,
  priceEpochBoundsFromEnv,
  resolvePriceConsensus,
  signPriceQuote,
  verifyPriceQuote
} from "../../src/economy/price-epoch-guard.js";

// #53: bounds, signed quotes and quorum for the legacy mesh price epoch.
const cpu = priceEpochBoundsFromEnv("cpu", {});

describe("price epoch bounds", () => {
  it("defaults to the dynamic multiplier's range and a 25% step", () => {
    expect(cpu).toEqual({ minSats: 10, maxSats: 120, maxChangeBps: 2500 });
    expect(priceEpochBoundsFromEnv("gpu", {})).toEqual({ minSats: 42, maxSats: 480, maxChangeBps: 2500 });
  });

  it("reads env overrides and rejects nonsense", () => {
    expect(priceEpochBoundsFromEnv("cpu", { PRICE_EPOCH_CPU_MIN_SATS: "20", PRICE_EPOCH_CPU_MAX_SATS: "40", PRICE_EPOCH_MAX_CHANGE_BPS: "1000" }))
      .toEqual({ minSats: 20, maxSats: 40, maxChangeBps: 1000 });
    expect(() => priceEpochBoundsFromEnv("cpu", { PRICE_EPOCH_CPU_MIN_SATS: "50", PRICE_EPOCH_CPU_MAX_SATS: "40" })).toThrow();
    expect(() => priceEpochBoundsFromEnv("cpu", { PRICE_EPOCH_MAX_CHANGE_BPS: "-1" })).toThrow();
  });

  it("rejects out-of-band prices and steps larger than the max change", () => {
    expect(checkPriceEpoch(5, undefined, cpu)).toEqual({ ok: false, reason: "below_min" });
    expect(checkPriceEpoch(500, undefined, cpu)).toEqual({ ok: false, reason: "above_max" });
    expect(checkPriceEpoch(Number.NaN, undefined, cpu)).toEqual({ ok: false, reason: "not_finite" });
    expect(checkPriceEpoch(38, 30, cpu)).toEqual({ ok: false, reason: "change_too_large" });
    expect(checkPriceEpoch(37.5, 30, cpu)).toEqual({ ok: true });
    expect(checkPriceEpoch(22.5, 30, cpu)).toEqual({ ok: true });
  });

  it("clamps into the band and the max step", () => {
    expect(clampPriceEpoch(120, 30, cpu)).toBe(37.5);
    expect(clampPriceEpoch(1, 30, cpu)).toBe(22.5);
    expect(clampPriceEpoch(1000, undefined, cpu)).toBe(120);
    // A previous price far outside a tightened band steps toward it rather than jumping.
    expect(clampPriceEpoch(30, 1000, cpu)).toBe(750);
  });
});

describe("signed price quotes", () => {
  const keys = createPeerKeys("coord-b");
  const inputs = { cpuCapacity: 4, gpuCapacity: 0, queuedTasks: 2, activeAgents: 1 };
  const now = 1_700_000_000_000;
  const fields = { coordinatorId: "coord-b", resourceClass: "cpu" as const, pricePerComputeUnitSats: 25, inputs, issuedAtMs: now };
  const base = { expectedCoordinatorId: "coord-b", resourceClass: "cpu" as const, inputs, publicKeyPem: keys.publicKeyPem, nowMs: now, maxSkewMs: 60_000 };

  it("accepts a quote signed by the peer over these inputs", () => {
    const signature = signPriceQuote(fields, keys.privateKeyPem);
    expect(verifyPriceQuote({ ...base, quote: { ...fields, signature } })).toEqual({ ok: true });
  });

  it("rejects a changed price, other inputs, another signer, stale or unsigned quotes", () => {
    const signature = signPriceQuote(fields, keys.privateKeyPem);
    expect(verifyPriceQuote({ ...base, quote: { ...fields, pricePerComputeUnitSats: 90, signature } }).ok).toBe(false);
    expect(verifyPriceQuote({ ...base, inputs: { ...inputs, queuedTasks: 999 }, quote: { ...fields, signature } }).ok).toBe(false);
    expect(verifyPriceQuote({ ...base, publicKeyPem: createPeerKeys("x").publicKeyPem, quote: { ...fields, signature } }).ok).toBe(false);
    expect(verifyPriceQuote({ ...base, nowMs: now + 120_000, quote: { ...fields, signature } })).toEqual({ ok: false, reason: "stale_quote" });
    expect(verifyPriceQuote({ ...base, quote: { ...fields } })).toEqual({ ok: false, reason: "unsigned" });
    expect(verifyPriceQuote({ ...base, expectedCoordinatorId: "coord-c", quote: { ...fields, signature } })).toEqual({ ok: false, reason: "coordinator_mismatch" });
  });
});

describe("price consensus quorum", () => {
  it("is a majority of the allowlist plus self; an override can only raise it", () => {
    expect(priceConsensusQuorum([], "self")).toBe(1);
    expect(priceConsensusQuorum(["a"], "self")).toBe(2);
    expect(priceConsensusQuorum(["a", "b"], "self")).toBe(2);
    expect(priceConsensusQuorum(["a", "b", "self"], "self")).toBe(2);
    expect(priceConsensusQuorum(["a", "b"], "self", 1)).toBe(2);
    expect(priceConsensusQuorum(["a", "b"], "self", 3)).toBe(3);
  });

  it("refuses to set a price without a quorum of distinct signers", () => {
    const out = resolvePriceConsensus({
      quotes: [{ coordinatorId: "self", value: 30 }, { coordinatorId: "self", value: 30 }],
      quorum: 2,
      previous: 30,
      bounds: cpu
    });
    expect(out).toMatchObject({ ok: false, error: "quorum_not_met", signers: ["self"] });
  });

  it("drops out-of-band quotes, so they do not count toward the quorum", () => {
    const out = resolvePriceConsensus({
      quotes: [{ coordinatorId: "self", value: 30 }, { coordinatorId: "evil", value: 1_000_000 }],
      quorum: 2,
      previous: 30,
      bounds: cpu
    });
    expect(out.ok).toBe(false);
  });

  it("a single dissenting peer cannot move the price", () => {
    // Two members: the peer can only hold the price at the previous value.
    const two = resolvePriceConsensus({
      quotes: [{ coordinatorId: "self", value: 30 }, { coordinatorId: "evil", value: 120 }],
      quorum: 2,
      previous: 30,
      bounds: cpu
    });
    expect(two).toMatchObject({ ok: true, price: 30 });
    // Three members: the honest median wins.
    const three = resolvePriceConsensus({
      quotes: [{ coordinatorId: "self", value: 31 }, { coordinatorId: "b", value: 32 }, { coordinatorId: "evil", value: 10 }],
      quorum: 2,
      previous: 30,
      bounds: cpu
    });
    expect(three).toMatchObject({ ok: true, price: 31 });
  });

  it("clamps an agreed jump to the max step", () => {
    const out = resolvePriceConsensus({
      quotes: [{ coordinatorId: "a", value: 120 }, { coordinatorId: "b", value: 120 }, { coordinatorId: "c", value: 120 }],
      quorum: 2,
      previous: 30,
      bounds: cpu
    });
    expect(out).toMatchObject({ ok: true, price: 37.5, medianPrice: 120, clamped: true });
  });
});

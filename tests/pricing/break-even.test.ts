import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_PROFIT_MARGIN, POWER_FLOOR_USD_PER_HOUR, TOKEN_PRICE_USD_PER_M } from "../../src/economy/job-pricing.js";
// @ts-expect-error plain .mjs script without types
import { PRICES, PROFIT_MARGIN, SCENARIOS, TARGET_UTILIZATION, analyse, buyerImpact, recommend, utilFor } from "../../scripts/pricing/break-even.mjs";

const BTC = 64_870;
type Scenario = { id: string; target?: boolean; excluded?: string };
const byId = (id: string) => analyse(SCENARIOS.find((s: Scenario) => s.id === id), BTC);

describe("break-even script", () => {
  it("uses the margin, prices and power floors the coordinator charges", () => {
    expect(PROFIT_MARGIN).toBe(HOST_PROFIT_MARGIN);
    expect(PRICES.now.bands).toEqual(TOKEN_PRICE_USD_PER_M);
    expect(PRICES.now.floor).toEqual(POWER_FLOOR_USD_PER_HOUR);
    expect(PRICES.now.splitBySlots).toBe(true);
  });

  it("the code's prices and floors are what the script recommends", () => {
    const rec = recommend(BTC);
    expect(rec.bands).toEqual(TOKEN_PRICE_USD_PER_M);
    expect(rec.floor).toEqual(POWER_FLOOR_USD_PER_HOUR);
  });

  it("every target host makes the profit margin at 50 % utilization; the Fly test fleet is excluded", () => {
    expect(TARGET_UTILIZATION).toBe(0.5);
    const targets = SCENARIOS.filter((s: Scenario) => s.target);
    expect(targets.map((s: Scenario) => s.id).sort()).toEqual(["a100-ollama-1", "a16-ollama-1", "home-cpu-1.5b", "mac-14b", "mac-7b", "mac-9b"]);
    for (const s of targets) {
      const r = analyse(s, BTC);
      expect(r.marginAtTarget.now, s.id).toBeGreaterThanOrEqual(PROFIT_MARGIN);
      expect(r.profitUtil.now, s.id).toBeLessThanOrEqual(TARGET_UTILIZATION);
    }
    expect(SCENARIOS.find((s: Scenario) => s.id === "fly-1.5b").target).toBeFalsy();
    expect(SCENARIOS.find((s: Scenario) => s.id === "fly-1.5b").excluded).toMatch(/test fleet/);
  });

  it("the measured 2xA16 + Ollama sets the large-band multiplier and lands just above the target", () => {
    const r = byId("a16-ollama-1");
    expect(r.callsPerHourFull).toBeCloseTo(526 / 0.698, 6);
    expect(r.breakEvenUtil.before).toBeGreaterThan(3);
    expect(r.marginAtTarget.now).toBeGreaterThanOrEqual(0.2);
    expect(r.marginAtTarget.now).toBeLessThan(0.25);
    expect(recommend(BTC).multiplier).toBeCloseTo(8.64, 2);
  });

  it("break-even / profit utilization is (1 + margin) × cost over the host's 95 % of a fully busy hour", () => {
    expect(utilFor(1, 2)).toBeCloseTo(1 / 1.9, 9);
    expect(utilFor(1, 2, 0.2)).toBeCloseTo(1.2 / 1.9, 9);
    expect(utilFor(1, 0)).toBe(Infinity);
  });

  it("vLLM slots (assumed throughput) raise the margin at the same prices", () => {
    expect(byId("a16-vllm-5").marginAtTarget.now).toBeGreaterThan(byId("a16-ollama-1").marginAtTarget.now * 10);
  });

  it("docs/economy-math.md lists the same per-token prices and floors as the code", () => {
    const doc = readFileSync("docs/economy-math.md", "utf8");
    for (const r of TOKEN_PRICE_USD_PER_M) {
      const label = r.maxB === Infinity ? "larger" : `≤ ${r.maxB}B`;
      expect(doc).toContain(`| ${label} | ${r.input.toFixed(2)} | ${r.output.toFixed(2)} |`);
    }
    expect(doc).toContain(`\`cpu\` $${POWER_FLOOR_USD_PER_HOUR.cpu}/h, \`apple\` $${POWER_FLOOR_USD_PER_HOUR.apple}/h`);
  });

  it("buyer impact: the 30B call is ~8.6x, the 9B call is cheaper (split floor), the CPU 1.5b call ~2.5x", () => {
    const rows = Object.fromEntries(buyerImpact(BTC).map((r: { model: string }) => [r.model, r]));
    expect(rows["qwen3-coder:30b"].sats.now).toBeCloseTo(5.229, 2);
    expect(rows["qwen3.5:9b"].sats.now).toBeLessThan(rows["qwen3.5:9b"].sats.before);
    expect(rows["qwen2.5-coder:1.5b"].sats.now / rows["qwen2.5-coder:1.5b"].sats.before).toBeCloseTo(2.5, 1);
  });
});

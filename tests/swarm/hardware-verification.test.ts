import { describe, expect, it } from "vitest";
import { classifyHardware, type HardwareProfile } from "../../src/economy/compute-classes.js";
import { capabilityConstraints, meetsCapability } from "../../src/economy/order-book.js";
import { PostgresStore } from "../../src/db/postgres.js";
import { solveCpuWork, type CpuChallenge, type GpuChallenge } from "../../src/swarm/benchmark.js";
import {
  DEFAULT_HARDWARE_VERIFICATION,
  DEFAULT_TIER_MINIMUMS,
  HardwareVerifier,
  hardwareProfileKey,
  hardwareVerificationConfigFromEnv,
  plausibilityFlags,
  supportedTier,
  type HardwareVerificationConfig,
  type HardwareVerificationRecord
} from "../../src/swarm/hardware-verification.js";
import { fakeModelOutput } from "./helpers/fake-model.js";

const T0 = 1_800_000_000_000;

/** Small CPU tier minimum so a real proof of work runs in milliseconds. */
const CFG: HardwareVerificationConfig = {
  ...DEFAULT_HARDWARE_VERIFICATION,
  tierMinimums: { ...DEFAULT_TIER_MINIMUMS, "cpu.hi": 50 },
  cpuTargetSeconds: 4,
  cpuExpectedSolutions: 40
};

const CPU_HI: HardwareProfile = { cpuCores: 64, ramGb: 256, platform: "linux", arch: "x64", cpuModel: "AMD EPYC 9554" };
const RTX4090: HardwareProfile = { cpuCores: 16, ramGb: 64, platform: "linux", arch: "x64", cpuModel: "AMD Ryzen 9", gpu: { vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", vramGb: 24 } };
const RTX3060: HardwareProfile = { cpuCores: 8, ramGb: 32, platform: "linux", arch: "x64", cpuModel: "Intel i5", gpu: { vendor: "nvidia", model: "NVIDIA GeForce RTX 3060", vramGb: 8 } };
const GPU_BENCH = { version: 1 as const, ranAtMs: T0, durationMs: 5000, gpu: { model: "qwen3.5:9b", tokensPerSec: 120, evalTokens: 192, weightsGb: 5.4, bandwidthGbps: 648 } };

function verifier(config: HardwareVerificationConfig = CFG, persist?: (r: HardwareVerificationRecord) => unknown) {
  let n = 0;
  return new HardwareVerifier({ config, persist, random: { id: () => `ch-${++n}` } });
}

function registerCpuHi(v: HardwareVerifier, opts: { kinds?: string[]; overridden?: boolean; agentId?: string; nowMs?: number } = {}) {
  return v.register({
    agentId: opts.agentId ?? "a1",
    claimed: classifyHardware(CPU_HI),
    profile: { ...CPU_HI, ...(opts.overridden ? { overridden: true } : {}) },
    challengeKinds: opts.kinds ?? ["cpu"],
    nowMs: opts.nowMs ?? T0
  });
}

async function answerCpu(c: CpuChallenge) {
  const r = await solveCpuWork(c, { threads: 2 });
  return { challengeId: c.challengeId, kind: "cpu" as const, solutions: r.solutions };
}

describe("supportedTier (demotion ladder)", () => {
  it("highest tier the measurement supports, never above the claim", () => {
    const cfg = DEFAULT_HARDWARE_VERIFICATION;
    expect(supportedTier("gpu.c24", "gpu", 400, cfg)).toEqual({ computeClass: "gpu", tier: "gpu.c24" });
    expect(supportedTier("gpu.c24", "gpu", 2000, cfg)).toEqual({ computeClass: "gpu", tier: "gpu.c24" }); // never above the claim
    expect(supportedTier("gpu.c24", "gpu", 200, cfg)).toEqual({ computeClass: "gpu", tier: "gpu.c16" });
    expect(supportedTier("gpu.c24", "gpu", 60, cfg)).toEqual({ computeClass: "gpu", tier: "gpu.c8" });
    expect(supportedTier("gpu.c24", "gpu", 30, cfg)).toEqual({ computeClass: "cpu", tier: "cpu.std" }); // a "GPU" measuring like a CPU
    expect(supportedTier("gpu.dc80", "gpu", 500, cfg)).toEqual({ computeClass: "gpu.dc", tier: "gpu.dc40" });
    expect(supportedTier("gpu.dc80", "gpu", 150, cfg)).toEqual({ computeClass: "gpu", tier: "gpu.c16" }); // below the dc floor: consumer tiers
    expect(supportedTier("apple.m.hi", "gpu", 40, cfg)).toEqual({ computeClass: "apple", tier: "apple.m" });
    expect(supportedTier("apple.m.hi", "gpu", 5, cfg)).toEqual({ computeClass: "cpu", tier: "cpu.std" });
    expect(supportedTier("cpu.hi", "cpu", 3500, cfg)).toEqual({ computeClass: "cpu", tier: "cpu.hi" });
    expect(supportedTier("cpu.hi", "cpu", 3000, cfg)).toEqual({ computeClass: "cpu", tier: "cpu.std" });
  });
});

describe("config from env", () => {
  it("defaults, overrides and validation", () => {
    expect(hardwareVerificationConfigFromEnv({}).enabled).toBe(true);
    expect(hardwareVerificationConfigFromEnv({}).requireCrossCheck).toBe(true);
    const c = hardwareVerificationConfigFromEnv({ HARDWARE_VERIFICATION: "0", HARDWARE_GPU_REQUIRE_CROSS_CHECK: "0", HARDWARE_TIER_MIN_JSON: '{"gpu.c24": 300}', HARDWARE_CROSS_CHECK_MIN_SIMILARITY: "0.5" });
    expect(c).toMatchObject({ enabled: false, requireCrossCheck: false, crossCheckMinSimilarity: 0.5 });
    expect(c.tierMinimums["gpu.c24"]).toBe(300);
    expect(DEFAULT_TIER_MINIMUMS["gpu.c24"]).toBe(350); // defaults not mutated
    expect(() => hardwareVerificationConfigFromEnv({ HARDWARE_TIER_MIN_JSON: '{"gpu.c99": 1}' })).toThrow(/unknown tier/);
    expect(() => hardwareVerificationConfigFromEnv({ HARDWARE_TIER_MIN_JSON: '{"gpu.c24": -1}' })).toThrow(/non-negative/);
  });
});

describe("grant before proof (mixed fleet)", () => {
  it("cpu.std has nothing to prove: base status, weight 1, no challenge", () => {
    const v = verifier();
    const claimed = classifyHardware({ cpuCores: 8, ramGb: 16, platform: "linux", arch: "x64" });
    const rec = v.register({ agentId: "a1", claimed, profile: {}, challengeKinds: ["cpu"], nowMs: T0 });
    expect(rec.status).toBe("base");
    expect(v.effective("a1", claimed)).toMatchObject({ tier: "cpu.std", creditsPerSecond: 1 });
    expect(v.nextChallenge("a1", { nowMs: T0 })).toBeUndefined();
  });

  it("an older agent without benchmark support keeps working at its class base tier and is never challenged", () => {
    const v = verifier();
    const claimed = classifyHardware(CPU_HI);
    const rec = v.register({ agentId: "old", claimed, profile: CPU_HI, nowMs: T0 });
    expect(rec.status).toBe("unverified");
    expect(v.effective("old", claimed)).toMatchObject({ computeClass: "cpu", tier: "cpu.std", creditsPerSecond: 1 });
    expect(v.nextChallenge("old", { nowMs: T0 + 60_000 })).toBeUndefined();
    const gpuClaim = classifyHardware(RTX4090);
    v.register({ agentId: "old-gpu", claimed: gpuClaim, profile: RTX4090, nowMs: T0 });
    expect(v.effective("old-gpu", gpuClaim)).toMatchObject({ computeClass: "gpu", tier: "gpu.c8", creditsPerSecond: 1, vramGb: 24 });
  });

  it("an unknown agent is base tier; disabled verification trusts the claim (rollback switch)", () => {
    const claimed = classifyHardware(CPU_HI);
    expect(verifier().effective("nobody", claimed)).toMatchObject({ tier: "cpu.std", creditsPerSecond: 1 });
    const off = verifier({ ...CFG, enabled: false });
    off.register({ agentId: "a1", claimed, profile: CPU_HI, challengeKinds: ["cpu"], nowMs: T0 });
    expect(off.effective("a1", claimed)).toMatchObject({ tier: "cpu.hi", creditsPerSecond: 4 });
    expect(off.nextChallenge("a1", { nowMs: T0 })).toBeUndefined();
  });
});

describe("CPU challenge: nonce, deadline, grant, demotion", () => {
  it("fresh seed per challenge, deadline from the claimed tier's speed, one outstanding at a time", () => {
    const v = verifier();
    registerCpuHi(v);
    const c = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    expect(c.kind).toBe("cpu");
    expect(c.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(c.workUnits).toBe(200); // 50 units/s × 4 s
    expect(c.deadlineMs).toBe(3_000 + 5_000); // allowance + work / min × slack
    expect(v.get("a1")?.status).toBe("pending");
    expect(v.nextChallenge("a1", { nowMs: T0 + 1 })).toBeUndefined();
    const other = verifier();
    registerCpuHi(other);
    expect((other.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge).seed).not.toBe(c.seed);
  });

  it("pass on time grants the claimed tier; the answer cannot be replayed", async () => {
    const v = verifier();
    registerCpuHi(v);
    const c = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    const ans = await answerCpu(c);
    const res = v.submit("a1", { ...ans, elapsedMs: 3_500 }, T0 + 4_000);
    expect(res).toMatchObject({ accepted: true, changed: true });
    const rec = v.get("a1")!;
    expect(rec.status).toBe("verified");
    expect(rec.measured).toMatchObject({ metric: "cpu", unit: "workUnits/s", supportedTier: "cpu.hi" });
    expect(rec.nextChallengeAtMs).toBe(T0 + 4_000 + CFG.revalidateMs);
    expect(v.effective("a1", classifyHardware(CPU_HI))).toMatchObject({ tier: "cpu.hi", creditsPerSecond: 4 });
    expect(v.submit("a1", { ...ans, elapsedMs: 3_500 }, T0 + 5_000)).toMatchObject({ accepted: false, reason: "unknown_challenge" });
    expect(v.tick(T0 + 5_000)).toEqual(["a1"]);
  });

  it("a late answer demotes to what the measurement supports; the server clock bounds a lying agent timer", async () => {
    const v = verifier();
    registerCpuHi(v);
    const c = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    // Agent claims it took 100 ms; the server saw 20 s.
    v.submit("a1", { ...(await answerCpu(c)), elapsedMs: 100 }, T0 + 20_000);
    const rec = v.get("a1")!;
    expect(rec.status).toBe("demoted");
    expect(rec.lastFailReason).toBe("below_claimed_tier");
    expect(rec.measured?.value).toBeCloseTo(200 / 17, 0);
    expect(v.effective("a1", classifyHardware(CPU_HI))).toMatchObject({ tier: "cpu.std", creditsPerSecond: 1 });
    expect(rec.nextChallengeAtMs).toBe(T0 + 20_000 + CFG.retryMs);
  });

  it("an honest agent's own timer stops network slack from inflating the measurement", async () => {
    const v = verifier();
    registerCpuHi(v);
    const c = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    // Server: 9 s round trip (6 s after allowance); agent measured 9 s itself: 200 / 9 = 22 units/s < 40.
    v.submit("a1", { ...(await answerCpu(c)), elapsedMs: 9_000 }, T0 + 9_000);
    expect(v.get("a1")?.granted.tier).toBe("cpu.std");
  });

  it("a forged or replayed proof is invalid: base tier and a flag", async () => {
    const v = verifier();
    registerCpuHi(v);
    const c1 = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    const ans1 = await answerCpu(c1);
    v.submit("a1", { ...ans1, elapsedMs: 3_000 }, T0 + 3_000);
    expect(v.get("a1")?.status).toBe("verified");
    // Revalidation: replaying the previous proof against the new seed.
    const c2 = v.nextChallenge("a1", { nowMs: T0 + CFG.revalidateMs + 4_000 }) as CpuChallenge;
    expect(c2.seed).not.toBe(c1.seed);
    const res = v.submit("a1", { challengeId: c2.challengeId, kind: "cpu", solutions: ans1.solutions, elapsedMs: 3_000 }, T0 + CFG.revalidateMs + 7_000);
    expect(res.invalid).toBeDefined();
    const rec = v.get("a1")!;
    expect(rec.status).toBe("demoted");
    expect(rec.lastFailReason).toMatch(/^invalid:/);
    expect(rec.flags.some((f) => f.startsWith("challenge_invalid:"))).toBe(true);
    expect(v.effective("a1", classifyHardware(CPU_HI)).creditsPerSecond).toBe(1);
  });

  it("an unanswered challenge expires: no grant above base, retried later", () => {
    const v = verifier();
    registerCpuHi(v);
    const c = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    v.tick(T0 + c.deadlineMs * CFG.expiryFactor - 1);
    expect(v.get("a1")?.status).toBe("pending");
    v.tick(T0 + c.deadlineMs * CFG.expiryFactor + 1);
    const rec = v.get("a1")!;
    expect(rec).toMatchObject({ status: "unverified", lastFailReason: "challenge_timeout" });
    expect(rec.flags).toContain("challenge_timeout");
    expect(v.nextChallenge("a1", { nowMs: T0 + c.deadlineMs * 4 + 2 })).toBeUndefined();
    expect(v.nextChallenge("a1", { nowMs: rec.nextChallengeAtMs! })?.kind).toBe("cpu");
  });

  it("a declined challenge measures nothing and is retried", () => {
    const v = verifier();
    registerCpuHi(v);
    const c = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    expect(v.submit("a1", { challengeId: c.challengeId, kind: "cpu", elapsedMs: 5, declined: "busy" }, T0 + 10)).toMatchObject({ accepted: true, changed: false });
    expect(v.get("a1")).toMatchObject({ status: "unverified", nextChallengeAtMs: T0 + 10 + CFG.retryMs });
  });

  it("a periodic re-registration with the same hardware keeps the grant; different hardware resets it", async () => {
    const v = verifier();
    registerCpuHi(v);
    const c = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    v.submit("a1", { ...(await answerCpu(c)), elapsedMs: 3_000 }, T0 + 3_000);
    registerCpuHi(v, { nowMs: T0 + 240_000 });
    expect(v.get("a1")).toMatchObject({ status: "verified", granted: { tier: "cpu.hi" } });
    const changed = { ...CPU_HI, cpuCores: 128 };
    v.register({ agentId: "a1", claimed: classifyHardware(changed), profile: changed, challengeKinds: ["cpu"], nowMs: T0 + 480_000 });
    expect(v.get("a1")).toMatchObject({ status: "unverified", granted: { tier: "cpu.std" } });
    expect(v.get("a1")?.flags).toContain("profile_changed");
  });
});

describe("GPU challenge: cross-check, plausibility, demotion", () => {
  const model = "qwen3.5:9b";
  const claimed = classifyHardware(RTX4090);

  function setup(config: HardwareVerificationConfig = CFG) {
    const v = verifier(config);
    v.register({ agentId: "g1", claimed, profile: RTX4090, benchmark: GPU_BENCH, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
    v.register({ agentId: "w1", claimed: classifyHardware(RTX3060), profile: RTX3060, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
    return v;
  }
  /** Answer timed for `gbps` effective bandwidth (512 tokens × 5.4 GB). */
  function answer(c: GpuChallenge, gbps: number, variant = "a", tokens = 512) {
    const ms = Math.round(((tokens * 5.4) / gbps) * 1000);
    return { at: T0 + ms + 300, res: { challengeId: c.challengeId, kind: "gpu" as const, output: fakeModelOutput(c.nonce, c.lines, variant), evalCount: tokens, evalDurationMs: ms, elapsedMs: ms + 200 } };
  }

  it("challenge parameters: agent's model, nonce, greedy seed, deadline from the tier's bandwidth", () => {
    const v = setup();
    const c = v.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    expect(c).toMatchObject({ kind: "gpu", model, lines: 24, numPredict: 512 });
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(c.deadlineMs).toBe(2_000 + Math.ceil(((512 * 5.4) / 350) * 1000 * 1.25));
  });

  it("matching witness output grants the claimed tier (cross-checked)", () => {
    const v = setup();
    const c = v.nextChallenge("g1", { nowMs: T0, model, pickWitness: () => "w1" }) as GpuChallenge;
    const w = v.nextChallenge("w1", { nowMs: T0 + 1_000, model }) as GpuChallenge;
    expect(w.nonce).toBe(c.nonce); // same prompt; the witness cannot tell it is a witness
    expect(w.challengeId).not.toBe(c.challengeId);
    const a = answer(c, 450);
    expect(v.submit("g1", a.res, a.at)).toMatchObject({ accepted: true, changed: false });
    expect(v.get("g1")?.status).toBe("pending");
    const wr = v.submit("w1", { ...answer(w, 200).res, challengeId: w.challengeId }, T0 + 20_000);
    expect(wr).toMatchObject({ accepted: true, changed: true });
    expect(wr.record?.agentId).toBe("g1");
    expect(v.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" }, measured: { crossChecked: true, supportedTier: "gpu.c24", model } });
    expect(v.effective("g1", claimed)).toMatchObject({ tier: "gpu.c24", creditsPerSecond: 3.5 });
  });

  it("a witness that answered first is used when the subject answers", () => {
    const v = setup();
    const c = v.nextChallenge("g1", { nowMs: T0, model, pickWitness: () => "w1" }) as GpuChallenge;
    const w = v.nextChallenge("w1", { nowMs: T0, model }) as GpuChallenge;
    v.submit("w1", { ...answer(w, 200).res, challengeId: w.challengeId }, T0 + 5_000);
    const a = answer(c, 450);
    expect(v.submit("g1", a.res, a.at)).toMatchObject({ changed: true });
    expect(v.get("g1")?.measured?.crossChecked).toBe(true);
  });

  it("output that does not match the witness (fabricated or another model) is invalid", () => {
    const v = setup();
    const c = v.nextChallenge("g1", { nowMs: T0, model, pickWitness: () => "w1" }) as GpuChallenge;
    const w = v.nextChallenge("w1", { nowMs: T0, model }) as GpuChallenge;
    const a = answer(c, 450, "small-model");
    v.submit("g1", a.res, a.at);
    const wr = v.submit("w1", { ...answer(w, 200).res, challengeId: w.challengeId }, T0 + 20_000);
    expect(wr.invalid).toBe("cross_check_mismatch");
    expect(v.get("g1")).toMatchObject({ status: "demoted", granted: { tier: "gpu.c8" }, lastFailReason: "invalid:cross_check_mismatch" });
  });

  it("no witness: base tier when the cross-check is required, the measured tier when it is not", () => {
    const strict = setup();
    const c = strict.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    const a = answer(c, 450);
    strict.submit("g1", a.res, a.at);
    expect(strict.get("g1")).toMatchObject({ status: "unverified", granted: { tier: "gpu.c8" }, lastFailReason: "cross_check_unavailable" });
    expect(strict.get("g1")?.flags).toContain("challenge_unconfirmed");
    const lax = setup({ ...CFG, requireCrossCheck: false });
    const c2 = lax.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    const a2 = answer(c2, 450);
    lax.submit("g1", a2.res, a2.at);
    expect(lax.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" }, measured: { crossChecked: false } });
  });

  it("a witness that never answers: settled unconfirmed after the witness timeout", () => {
    const v = setup();
    const c = v.nextChallenge("g1", { nowMs: T0, model, pickWitness: () => "w1" }) as GpuChallenge;
    const a = answer(c, 450);
    v.submit("g1", a.res, a.at);
    v.tick(a.at + CFG.witnessTimeoutMs + 1);
    expect(v.get("g1")).toMatchObject({ status: "unverified", lastFailReason: "cross_check_unavailable" });
  });

  it("slow answers demote without a cross-check: within the class, or out of it when CPU-like", () => {
    const v = setup();
    const c = v.nextChallenge("g1", { nowMs: T0, model, pickWitness: () => "w1" }) as GpuChallenge;
    const a = answer(c, 200); // 4060 Ti-class bandwidth on a "4090"
    v.submit("g1", a.res, a.at);
    // gpu.c16 is above base: still waits for the witness before it is granted.
    expect(v.get("g1")?.status).toBe("pending");
    const v2 = setup();
    const c2 = v2.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    const a2 = answer(c2, 25, "a", 200); // CPU-like
    expect(v2.submit("g1", a2.res, a2.at)).toMatchObject({ changed: true });
    expect(v2.get("g1")).toMatchObject({ status: "demoted", granted: { computeClass: "cpu", tier: "cpu.std" } });
    expect(v2.effective("g1", claimed)).toMatchObject({ computeClass: "cpu", creditsPerSecond: 1 });
  });

  it("faster than the claimed part can physically be is not a measurement", () => {
    const v = setup({ ...CFG, requireCrossCheck: false });
    const c = v.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    const res = v.submit("g1", { challengeId: c.challengeId, kind: "gpu", output: fakeModelOutput(c.nonce, c.lines), evalCount: 512, evalDurationMs: 2_000, elapsedMs: 40 }, T0 + 50);
    expect(res.invalid).toBe("faster_than_hardware");
    expect(v.get("g1")?.granted.tier).toBe("gpu.c8");
  });

  it("missing tags or too little output is invalid", () => {
    const v = setup();
    const c = v.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    expect(v.submit("g1", { challengeId: c.challengeId, kind: "gpu", output: fakeModelOutput("another-nonce", 24), evalCount: 512, elapsedMs: 8_000 }, T0 + 8_000).invalid).toBe("output_missing_tags");
    const v2 = setup();
    const c2 = v2.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    expect(v2.submit("g1", { challengeId: c2.challengeId, kind: "gpu", output: fakeModelOutput(c2.nonce, 24), evalCount: 20, elapsedMs: 8_000 }, T0 + 8_000).invalid).toBe("output_too_short");
  });

  it("no challenge without a sized model of meaningful size", () => {
    const v = setup();
    expect(v.nextChallenge("g1", { nowMs: T0, model: "qwen3.5:0.8b" })).toBeUndefined();
    expect(v.get("g1")?.flags).toContain("challenge_model_too_small");
    expect(v.nextChallenge("g1", { nowMs: T0 + 1, model: "qwen3.5:9b" })).toBeUndefined(); // waits for the retry
    expect(v.nextChallenge("g1", { nowMs: T0 + CFG.retryMs, model: "custom:latest" })).toBeUndefined();
    expect(v.get("g1")?.flags).toContain("challenge_model_unknown");
  });

  it("ongoing evidence: real work far below the challenge baseline demotes and schedules a re-challenge", () => {
    const v = setup({ ...CFG, requireCrossCheck: false });
    const c = v.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    const a = answer(c, 450);
    v.submit("g1", a.res, a.at);
    const baseline = v.get("g1")!.evidence.baselineTokensPerSec!;
    expect(baseline).toBeGreaterThan(60);
    expect(v.reliability("g1")).toBeUndefined(); // not enough evidence yet
    // Honest work at ~40% of challenge speed: no demotion.
    const at = (ratio: number) => ({ ok: true, outputChars: 4_000, elapsedMs: Math.round((1_000 / (ratio * baseline)) * 1000) }); // 1000 tokens
    for (let i = 0; i < 12; i++) v.recordTask("g1", at(0.4), a.at + i);
    expect(v.get("g1")?.granted.tier).toBe("gpu.c24");
    expect(v.reliability("g1")).toBe(1);
    // The work moves to a CPU (2% of the challenge speed).
    let changed = false;
    for (let i = 0; i < 40 && !changed; i++) changed = v.recordTask("g1", at(0.02), a.at + 100 + i);
    expect(changed).toBe(true);
    const rec = v.get("g1")!;
    expect(rec).toMatchObject({ status: "demoted", granted: { tier: "gpu.c8" }, lastFailReason: "task_speed_below_tier" });
    expect(rec.nextChallengeAtMs).toBeGreaterThan(a.at + CFG.retryMs);
    expect(v.reliability("g1")).toBeLessThan(0.5);
  });

  it("short outputs do not count as speed evidence", () => {
    const v = setup({ ...CFG, requireCrossCheck: false });
    const c = v.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    const a = answer(c, 450);
    v.submit("g1", a.res, a.at);
    for (let i = 0; i < 30; i++) v.recordTask("g1", { ok: true, outputChars: 40, elapsedMs: 60_000 }, a.at + i);
    expect(v.get("g1")).toMatchObject({ status: "verified", evidence: { samples: 30 } });
    expect(v.get("g1")?.evidence.tokensPerSec).toBeUndefined();
  });

  it("failures lower the rolling success rate (published score)", () => {
    const v = setup();
    for (let i = 0; i < 10; i++) v.recordTask("w1", { ok: i % 2 === 0, outputChars: 400, elapsedMs: 5_000 }, T0 + i);
    const e = v.get("w1")!.evidence;
    expect(e.samples).toBe(10);
    expect(e.okRate).toBeLessThan(0.8);
    expect(v.reliability("w1")).toBe(e.score);
  });
});

describe("plausibility of self-reports", () => {
  it("flags overrides, slow self-benchmarks and impossible speeds; never grants", () => {
    const cfg = DEFAULT_HARDWARE_VERIFICATION;
    expect(plausibilityFlags("gpu.c24", { ...RTX4090, overridden: true }, undefined, cfg)).toEqual(["profile_overridden"]);
    expect(plausibilityFlags("gpu.c24", RTX4090, { ...GPU_BENCH, gpu: { ...GPU_BENCH.gpu, bandwidthGbps: 100 } }, cfg)).toContain("self_benchmark_below_claim");
    expect(plausibilityFlags("gpu.c24", RTX4090, { ...GPU_BENCH, gpu: { ...GPU_BENCH.gpu, bandwidthGbps: 3000 } }, cfg)).toContain("self_benchmark_exceeds_hardware");
    expect(plausibilityFlags("gpu.c24", RTX4090, GPU_BENCH, cfg)).toEqual([]);
    expect(plausibilityFlags("cpu.hi", CPU_HI, { version: 1, ranAtMs: 0, durationMs: 0, cpu: { workUnitsPerSec: 500, threads: 64, processed: 2000, elapsedMs: 4000, digest: "x" } }, cfg)).toContain("self_benchmark_below_claim");
    expect(plausibilityFlags("gpu.c8", RTX3060, { version: 1, ranAtMs: 0, durationMs: 0, loaded: { model: "big", vramGb: 20 } }, cfg)).toContain("loaded_vram_exceeds_claim");
  });

  it("a flattering self-benchmark does not grant the tier", () => {
    const v = verifier();
    const claimed = classifyHardware(RTX4090);
    v.register({ agentId: "g1", claimed, profile: RTX4090, benchmark: { ...GPU_BENCH, gpu: { ...GPU_BENCH.gpu, bandwidthGbps: 900 } }, challengeKinds: ["gpu"], nowMs: T0 });
    expect(v.effective("g1", claimed).creditsPerSecond).toBe(1);
  });
});

describe("persistence and restore", () => {
  async function verifiedCpuHi(persist?: (r: HardwareVerificationRecord) => unknown, overridden = false) {
    const v = verifier(CFG, persist);
    registerCpuHi(v, { overridden });
    const c = v.nextChallenge("a1", { nowMs: T0 }) as CpuChallenge;
    v.submit("a1", { ...(await answerCpu(c)), elapsedMs: 3_000 }, T0 + 3_000);
    return v;
  }

  it("persists self-contained copies on every change", async () => {
    const saved: HardwareVerificationRecord[] = [];
    const v = await verifiedCpuHi((r) => saved.push(r));
    expect(saved.length).toBeGreaterThanOrEqual(3);
    const last = saved.at(-1)!;
    expect(last).toMatchObject({ agentId: "a1", status: "verified", granted: { tier: "cpu.hi" } });
    expect(last).not.toBe(v.get("a1")); // a copy, not the live object
    expect(JSON.parse(JSON.stringify(last))).toEqual(last); // JSON round-trips (publishable)
  });

  it("works in memory when the store is missing or failing", async () => {
    const v1 = await verifiedCpuHi(undefined);
    expect(v1.get("a1")?.status).toBe("verified");
    const v2 = await verifiedCpuHi(() => Promise.reject(new Error("db down")));
    expect(v2.get("a1")?.status).toBe("verified");
    const v3 = await verifiedCpuHi(() => {
      throw new Error("db down");
    });
    expect(v3.get("a1")?.status).toBe("verified");
  });

  it("restored fresh pass is honored on a matching registration; stale or overridden ones are re-proven", async () => {
    const saved = (await verifiedCpuHi()).list();
    const fresh = verifier();
    fresh.load(saved);
    registerCpuHi(fresh, { nowMs: T0 + 60_000 });
    expect(fresh.get("a1")).toMatchObject({ status: "verified", granted: { tier: "cpu.hi" } });

    const stale = verifier();
    stale.load(saved);
    registerCpuHi(stale, { nowMs: T0 + CFG.revalidateMs + 10_000 });
    expect(stale.get("a1")).toMatchObject({ status: "unverified", granted: { tier: "cpu.std" } });
    expect(stale.nextChallenge("a1", { nowMs: T0 + CFG.revalidateMs + 10_000 })?.kind).toBe("cpu");

    const overriddenSaved = (await verifiedCpuHi(undefined, true)).list();
    const ov = verifier();
    ov.load(overriddenSaved);
    registerCpuHi(ov, { overridden: true, nowMs: T0 + 60_000 });
    expect(ov.get("a1")).toMatchObject({ status: "unverified", granted: { tier: "cpu.std" }, overridden: true });
    expect(ov.get("a1")?.flags).toContain("profile_overridden");
  });

  it("a restored record does not overwrite an agent that registered first, and a restored 'pending' is re-run", async () => {
    const saved = (await verifiedCpuHi()).list();
    const v = verifier();
    registerCpuHi(v, { nowMs: T0 });
    v.load(saved.map((r) => ({ ...r, granted: { computeClass: "cpu", tier: "cpu.hi" } })));
    expect(v.get("a1")?.granted.tier).toBe("cpu.std");
    const p = verifier();
    p.load([{ ...saved[0], agentId: "a2", status: "pending", granted: { computeClass: "cpu", tier: "cpu.std" } }]);
    expect(p.get("a2")?.status).toBe("unverified");
  });

  it("Postgres upsert/list round-trip a record (newer wins)", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const rows: Array<{ record_json: unknown }> = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql.startsWith("INSERT INTO hardware_verifications")) rows.push({ record_json: JSON.parse(params[1] as string) });
        return { rows, rowCount: 1 };
      }
    };
    const store = new PostgresStore(pool as any);
    const rec = (await verifiedCpuHi()).get("a1")!;
    await store.upsertHardwareVerification(rec);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(agent_id\) DO UPDATE/);
    expect(calls[0].sql).toMatch(/updated_at_ms <= EXCLUDED.updated_at_ms/);
    expect(calls[0].params[0]).toBe("a1");
    const listed = await store.listHardwareVerifications();
    expect(listed[0]).toEqual(JSON.parse(JSON.stringify(rec)));
  });

  it("the profile key covers the fields the claim rests on", () => {
    expect(hardwareProfileKey("gpu.c24", RTX4090)).not.toBe(hardwareProfileKey("gpu.c24", { ...RTX4090, gpu: { ...RTX4090.gpu, model: "NVIDIA GeForce RTX 3090" } }));
    expect(hardwareProfileKey("gpu.c24", RTX4090)).toBe(hardwareProfileKey("gpu.c24", { ...RTX4090, ramGb: 128 }));
  });
});

describe("reliability admission (minReliability)", () => {
  it("only asks with enough evidence at or above the score qualify", () => {
    expect(capabilityConstraints({ minReliability: 0.9 })).toEqual({ minReliability: 0.9 });
    expect(capabilityConstraints({ minReliability: 5 })).toEqual({ minReliability: 1 });
    expect(capabilityConstraints({ minReliability: -1 })).toEqual({});
    expect(meetsCapability({ reliability: 0.95 }, { minReliability: 0.9 })).toBe(true);
    expect(meetsCapability({ reliability: 0.5 }, { minReliability: 0.9 })).toBe(false);
    expect(meetsCapability({}, { minReliability: 0.1 })).toBe(false); // no evidence never qualifies
    expect(meetsCapability({}, {})).toBe(true);
  });
});


describe("real token counts on real work", () => {
  it("uses the model's count, kept within what the text can hold", async () => {
    const { workTokens } = await import("../../src/swarm/hardware-verification.js");
    expect(workTokens(4000)).toBe(1000);
    expect(workTokens(4000, 900)).toBe(900);
    // An inflated count can't make the hardware look faster than the text allows.
    expect(workTokens(4000, 1_000_000)).toBeCloseTo(4000 / 1.5);
    expect(workTokens(4000, 1)).toBe(500);
  });
});

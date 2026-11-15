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
  ipNetworkPrefix,
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
    expect(supportedTier("gpu.dc80", "gpu", 150, cfg)).toEqual({ computeClass: "gpu.dc", tier: "gpu.dc40" }); // the dc floor is a GPU floor, not an A100 bar
    expect(supportedTier("gpu.dc40", "gpu", 95, cfg)).toEqual({ computeClass: "gpu.dc", tier: "gpu.dc40" }); // a warm 2x A16 on qwen3-coder:30b
    expect(supportedTier("gpu.dc40", "gpu", 50, cfg)).toEqual({ computeClass: "gpu", tier: "gpu.c8" }); // below the dc floor: consumer tiers
    expect(supportedTier("gpu.dc40", "gpu", 40, cfg)).toEqual({ computeClass: "cpu", tier: "cpu.std" }); // CPU-like
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
    expect(hardwareVerificationConfigFromEnv({})).toMatchObject({ witnessStrikeThreshold: 2, witnessStrikeWindowMs: 30 * 86_400_000, witnessMaxDisagreements: 3 });
    expect(hardwareVerificationConfigFromEnv({ HARDWARE_WITNESS_STRIKE_THRESHOLD: "4", HARDWARE_WITNESS_STRIKE_WINDOW_MS: "7200000" })).toMatchObject({ witnessStrikeThreshold: 4, witnessStrikeWindowMs: 7_200_000 });
    expect(hardwareVerificationConfigFromEnv({ HARDWARE_WITNESS_STRIKE_THRESHOLD: "0" }).witnessStrikeThreshold).toBe(2);
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

  /** Verifier with a second-witness picker (w2 by default) and three GPU agents: subject g1, witnesses w1, w2. */
  function setup2(pick: (subjectId: string, model: string, exclude: string[], nowMs: number) => string | undefined = () => "w2") {
    let n = 0;
    const calls: Array<{ subjectId: string; exclude: string[] }> = [];
    const v = new HardwareVerifier({
      config: CFG,
      random: { id: () => `ch-${++n}` },
      pickWitness: (subjectId, m, exclude, nowMs) => {
        calls.push({ subjectId, exclude });
        return pick(subjectId, m, exclude, nowMs);
      }
    });
    v.register({ agentId: "g1", claimed, profile: RTX4090, benchmark: GPU_BENCH, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
    for (const id of ["w1", "w2"]) v.register({ agentId: id, claimed: classifyHardware(RTX3060), profile: RTX3060, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
    return { v, calls };
  }
  /** Subject answers with `subject`, the first witness with `first`; returns the second witness's challenge (if one was issued). */
  function firstRound(v: HardwareVerifier, subject: string, first: string) {
    const c = v.nextChallenge("g1", { nowMs: T0, model, pickWitness: () => "w1" }) as GpuChallenge;
    const w = v.nextChallenge("w1", { nowMs: T0, model }) as GpuChallenge;
    const a = answer(c, 450, subject);
    v.submit("g1", a.res, a.at);
    const r1 = v.submit("w1", { ...answer(w, 200, first).res, challengeId: w.challengeId }, T0 + 20_000);
    // w2 would get its own GPU challenge when nothing else is queued: only the subject's prompt is a witness challenge.
    const next = v.nextChallenge("w2", { nowMs: T0 + 21_000, model }) as GpuChallenge | undefined;
    const w2 = next?.nonce === c.nonce ? next : undefined;
    return { c, r1, w2 };
  }

  it("first witness agrees: verified at once, no second witness asked", () => {
    const { v, calls } = setup2();
    const { r1, w2 } = firstRound(v, "a", "a");
    expect(r1).toMatchObject({ accepted: true, changed: true });
    expect(r1.invalid).toBeUndefined();
    expect(r1.disagreeingWitness).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(w2).toBeUndefined();
    expect(v.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" }, measured: { crossChecked: true } });
  });

  it("one lying witness no longer demotes: a second witness that agrees with the subject verifies it", () => {
    const { v, calls } = setup2();
    const { c, r1, w2 } = firstRound(v, "a", "small-model"); // w1 lies
    expect(r1.invalid).toBeUndefined();
    expect(r1.changed).toBe(false);
    expect(v.get("g1")?.status).toBe("pending");
    expect(calls).toEqual([{ subjectId: "g1", exclude: ["g1", "w1"] }]);
    expect(w2).toBeDefined();
    expect(w2!.nonce).toBe(c.nonce); // same prompt
    expect(w2!.challengeId).not.toBe(c.challengeId);
    const r2 = v.submit("w2", { ...answer(w2!, 200).res, challengeId: w2!.challengeId }, T0 + 40_000);
    expect(r2).toMatchObject({ accepted: true, changed: true, disagreeingWitness: "w1" });
    expect(r2.invalid).toBeUndefined();
    expect(r2.record?.agentId).toBe("g1");
    expect(v.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" }, measured: { crossChecked: true } });
    expect(v.get("w1")).toMatchObject({ witnessDisagreements: 1, lastWitnessDisagreementAtMs: T0 + 40_000 });
    expect(v.get("w2")?.witnessDisagreements).toBeUndefined();
  });

  it("the same holds when the lying witness answers before the subject", () => {
    const { v } = setup2();
    const c = v.nextChallenge("g1", { nowMs: T0, model, pickWitness: () => "w1" }) as GpuChallenge;
    const w = v.nextChallenge("w1", { nowMs: T0, model }) as GpuChallenge;
    v.submit("w1", { ...answer(w, 200, "small-model").res, challengeId: w.challengeId }, T0 + 5_000);
    const a = answer(c, 450);
    expect(v.submit("g1", a.res, a.at).invalid).toBeUndefined();
    expect(v.get("g1")?.status).toBe("pending");
    const w2 = v.nextChallenge("w2", { nowMs: a.at + 1, model }) as GpuChallenge;
    expect(v.submit("w2", { ...answer(w2, 200).res, challengeId: w2.challengeId }, a.at + 30_000)).toMatchObject({ disagreeingWitness: "w1" });
    expect(v.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" } });
  });

  /**
   * Witness pool for confirmatory rounds: g1 is the subject, w1 the first witness, w2 the second,
   * w3 and w4 the fresh witnesses of a confirmatory round. The picker returns the first agent of
   * `pool` not excluded.
   */
  function setupConfirm(pool: string[] = ["w2", "w3", "w4"], config: HardwareVerificationConfig = CFG) {
    let n = 0;
    const calls: Array<{ subjectId: string; exclude: string[] }> = [];
    const v = new HardwareVerifier({
      config,
      random: { id: () => `ch-${++n}` },
      pickWitness: (subjectId, _m, exclude) => {
        calls.push({ subjectId, exclude: [...exclude] });
        return pool.find((id) => !exclude.includes(id));
      }
    });
    v.register({ agentId: "g1", claimed, profile: RTX4090, benchmark: GPU_BENCH, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
    for (const id of ["w1", "w2", "w3", "w4", "w5"]) v.register({ agentId: id, claimed: classifyHardware(RTX3060), profile: RTX3060, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
    return { v, calls };
  }
  /** First and second witnesses answer `w1`/`w2` against the subject's `subject`; returns the second-round result. */
  function twoWitnesses(v: HardwareVerifier, subject: string, w1: string, w2: string, at = T0) {
    const c = v.nextChallenge("g1", { nowMs: at, model, pickWitness: () => "w1" }) as GpuChallenge;
    const w = v.nextChallenge("w1", { nowMs: at, model }) as GpuChallenge;
    const a = answer(c, 450, subject);
    v.submit("g1", { ...a.res }, at + (a.at - T0));
    v.submit("w1", { ...answer(w, 200, w1).res, challengeId: w.challengeId }, at + 20_000);
    const second = v.nextChallenge("w2", { nowMs: at + 21_000, model }) as GpuChallenge;
    expect(second.nonce).toBe(c.nonce);
    return { c, r2: v.submit("w2", { ...answer(second, 200, w2).res, challengeId: second.challengeId }, at + 40_000) };
  }
  /** The confirmatory round: the subject answers `subject` to its fresh prompt, w3 and w4 answer theirs. */
  function confirmRound(v: HardwareVerifier, first: GpuChallenge, subject: string, w3: string | undefined, w4: string | undefined, at = T0) {
    const c2 = v.nextChallenge("g1", { nowMs: at + 50_000, model }) as GpuChallenge;
    expect(c2.kind).toBe("gpu");
    expect(c2.nonce).not.toBe(first.nonce); // a fresh prompt
    const x3 = v.nextChallenge("w3", { nowMs: at + 50_000, model }) as GpuChallenge;
    const x4 = v.nextChallenge("w4", { nowMs: at + 50_000, model }) as GpuChallenge;
    expect(x3.nonce).toBe(c2.nonce);
    expect(x4.nonce).toBe(c2.nonce);
    const a = answer(c2, 450, subject);
    const results = [v.submit("g1", a.res, at + 50_000 + (a.at - T0))];
    if (w3 !== undefined) results.push(v.submit("w3", { ...answer(x3, 200, w3).res, challengeId: x3.challengeId }, at + 70_000));
    if (w4 !== undefined) results.push(v.submit("w4", { ...answer(x4, 200, w4).res, challengeId: x4.challengeId }, at + 80_000));
    return results[results.length - 1];
  }

  it("two colluding witnesses no longer demote an honest subject: a confirmatory round clears it and strikes them", () => {
    const { v, calls } = setupConfirm();
    const { c, r2 } = twoWitnesses(v, "a", "small-model", "small-model");
    // Two disagreeing witnesses: no demotion yet, the subject is re-challenged.
    expect(r2.invalid).toBeUndefined();
    expect(r2.changed).toBe(false);
    expect(v.get("g1")?.status).toBe("pending");
    // The fresh witnesses exclude the subject, both earlier witnesses and each other.
    expect(calls.slice(-2)).toEqual([
      { subjectId: "g1", exclude: ["g1", "w1", "w2"] },
      { subjectId: "g1", exclude: ["g1", "w1", "w2", "w3"] }
    ]);
    const r = confirmRound(v, c, "a", "a", "a");
    expect(r.invalid).toBeUndefined();
    expect(r).toMatchObject({ accepted: true, changed: true });
    expect(r.record?.agentId).toBe("g1");
    expect(v.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" }, measured: { crossChecked: true } });
    // Each colluder gets a witness strike (one strike is not yet exclusion).
    expect(r.struckWitnesses).toEqual([
      { agentId: "w1", strikes: 1, excluded: false, newlyExcluded: false },
      { agentId: "w2", strikes: 1, excluded: false, newlyExcluded: false }
    ]);
    expect(v.get("w1")).toMatchObject({ witnessStrikes: 1, witnessDisagreements: 1 });
    expect(v.get("w3")?.witnessStrikes).toBeUndefined();
  });

  it("the confirmatory round decides the same way when its witnesses answer before the subject", () => {
    const { v } = setupConfirm();
    const { c } = twoWitnesses(v, "a", "small-model", "small-model");
    const c2 = v.nextChallenge("g1", { nowMs: T0 + 50_000, model }) as GpuChallenge;
    const x3 = v.nextChallenge("w3", { nowMs: T0 + 50_000, model }) as GpuChallenge;
    const x4 = v.nextChallenge("w4", { nowMs: T0 + 50_000, model }) as GpuChallenge;
    expect(c2.nonce).not.toBe(c.nonce);
    v.submit("w3", { ...answer(x3, 200).res, challengeId: x3.challengeId }, T0 + 55_000);
    v.submit("w4", { ...answer(x4, 200).res, challengeId: x4.challengeId }, T0 + 56_000);
    const a = answer(c2, 450);
    const r = v.submit("g1", a.res, T0 + 50_000 + (a.at - T0));
    expect(r.struckWitnesses?.map((s) => s.agentId)).toEqual(["w1", "w2"]);
    expect(v.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" } });
  });

  it("a subject that fails the confirmatory round too is demoted (fabricated output or another model)", () => {
    const { v } = setupConfirm();
    const { c, r2 } = twoWitnesses(v, "small-model", "a", "a");
    expect(r2.invalid).toBeUndefined();
    const r = confirmRound(v, c, "small-model", "a", "a");
    expect(r.invalid).toBe("cross_check_mismatch");
    expect(r.struckWitnesses).toBeUndefined();
    expect(v.get("g1")).toMatchObject({ status: "demoted", granted: { tier: "gpu.c8" }, lastFailReason: "invalid:cross_check_mismatch" });
    for (const id of ["w1", "w2", "w3", "w4"]) expect(v.get(id)?.witnessStrikes).toBeUndefined();
  });

  it("a split confirmatory round proves nothing: unconfirmed, no demotion, no strike", () => {
    const { v } = setupConfirm();
    const { c } = twoWitnesses(v, "a", "small-model", "small-model");
    const r = confirmRound(v, c, "a", "a", "small-model");
    expect(r.invalid).toBeUndefined();
    expect(r.struckWitnesses).toBeUndefined();
    expect(v.get("g1")).toMatchObject({ status: "unverified", granted: { tier: "gpu.c8" }, lastFailReason: "cross_check_inconclusive" });
    for (const id of ["w1", "w2", "w4"]) expect(v.get(id)?.witnessStrikes).toBeUndefined();
  });

  it("no two fresh witnesses to be had: settled unconfirmed, never invalid", () => {
    const { v } = setupConfirm(["w2", "w3"]); // only one agent left for the confirmatory round
    const { r2 } = twoWitnesses(v, "a", "small-model", "small-model");
    expect(r2.invalid).toBeUndefined();
    expect(v.get("g1")).toMatchObject({ status: "unverified", granted: { tier: "gpu.c8" }, lastFailReason: "cross_check_unavailable" });
  });

  it("a confirmatory witness that never answers: settled unconfirmed after the witness timeout", () => {
    const { v } = setupConfirm();
    const { c } = twoWitnesses(v, "a", "small-model", "small-model");
    confirmRound(v, c, "a", "a", undefined);
    expect(v.get("g1")?.status).toBe("pending");
    v.tick(T0 + 60_000 + CFG.witnessTimeoutMs + 1);
    expect(v.get("g1")).toMatchObject({ status: "unverified", lastFailReason: "cross_check_unavailable" });
    expect(v.get("w1")?.witnessStrikes).toBeUndefined();
  });

  it("a subject that never takes its confirmatory challenge is not demoted (no answer, no measurement)", () => {
    const { v } = setupConfirm();
    twoWitnesses(v, "a", "small-model", "small-model");
    v.tick(T0 + 40_000 + CFG.witnessTimeoutMs + 1);
    expect(v.get("g1")).toMatchObject({ status: "unverified", granted: { tier: "gpu.c8" }, lastFailReason: "challenge_timeout" });
  });

  /** w1 passes a GPU challenge of its own (gpu.c8 is its class base: no cross-check needed), so it may witness. */
  function verifyWitness(v: HardwareVerifier, id: string, at = T0) {
    const own = v.nextChallenge(id, { nowMs: at, model }) as GpuChallenge;
    const a = answer(own, 200);
    v.submit(id, a.res, at + (a.at - T0));
    expect(v.get(id)).toMatchObject({ status: "verified", granted: { tier: "gpu.c8" } });
  }

  it("witness strikes accumulate; at the threshold the witness is excluded from witnessing", () => {
    const { v } = setupConfirm();
    verifyWitness(v, "w1");
    expect(v.canWitness("w1", T0 + 30_000)).toBe(true);
    const { c } = twoWitnesses(v, "a", "small-model", "small-model", T0 + 30_000);
    const r1 = confirmRound(v, c, "a", "a", "a", T0 + 30_000);
    expect(r1.struckWitnesses?.[0]).toMatchObject({ agentId: "w1", strikes: 1, excluded: false });
    expect(v.canWitness("w1", T0 + 200_000)).toBe(true);
    // Next re-validation of g1, the same two witnesses lie again.
    const later = v.get("g1")!.nextChallengeAtMs!;
    const { c: c2 } = twoWitnesses(v, "a", "small-model", "small-model", later);
    const r2 = confirmRound(v, c2, "a", "a", "a", later);
    expect(r2.struckWitnesses).toEqual([
      { agentId: "w1", strikes: 2, excluded: true, newlyExcluded: true },
      { agentId: "w2", strikes: 2, excluded: true, newlyExcluded: true }
    ]);
    expect(v.get("w1")).toMatchObject({ witnessStrikes: 2, witnessDisagreements: 2 });
    expect(v.canWitness("w1", later + 100_000)).toBe(false);
    // Strikes age out of the window.
    expect(v.canWitness("w1", later + CFG.witnessStrikeWindowMs + 1)).toBe(true);
  });

  it("too many recent disagreements also end witness duty", () => {
    const { v } = setupConfirm(undefined, { ...CFG, witnessStrikeThreshold: 10, witnessMaxDisagreements: 2 });
    verifyWitness(v, "w1");
    const { c } = twoWitnesses(v, "a", "small-model", "small-model", T0 + 30_000);
    confirmRound(v, c, "a", "a", "a", T0 + 30_000);
    expect(v.canWitness("w1", T0 + 200_000)).toBe(true);
    const later = v.get("g1")!.nextChallengeAtMs!;
    const { c: c2 } = twoWitnesses(v, "a", "small-model", "small-model", later);
    confirmRound(v, c2, "a", "a", "a", later);
    expect(v.canWitness("w1", later + 100_000)).toBe(false);
  });

  it("who may witness: a passed GPU challenge (or one unconfirmed for want of a witness), never a fresh or demoted agent", () => {
    const { v } = setupConfirm();
    expect(v.canWitness("w1", T0)).toBe(false); // registered, nothing proven
    expect(v.canWitness("nobody", T0)).toBe(false);
    verifyWitness(v, "w1");
    expect(v.canWitness("w1", T0 + 30_000)).toBe(true);
    // A gpu.c24 claim measured on a GPU challenge but with no witness to confirm it: may witness (bootstrap).
    const c = v.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    const a = answer(c, 450);
    v.submit("g1", a.res, a.at);
    expect(v.get("g1")).toMatchObject({ status: "unverified", lastFailReason: "cross_check_unavailable" });
    expect(v.canWitness("g1", a.at)).toBe(true);
    // Demoted on its own challenge: no.
    const { v: v2 } = setupConfirm();
    const c2 = v2.nextChallenge("g1", { nowMs: T0, model }) as GpuChallenge;
    v2.submit("g1", { challengeId: c2.challengeId, kind: "gpu", output: fakeModelOutput("another-nonce", 24), evalCount: 512, elapsedMs: 8_000 }, T0 + 8_000);
    expect(v2.canWitness("g1", T0 + 9_000)).toBe(false);
  });

  it("witness strikes survive new hardware (re-registering does not clear them)", () => {
    const { v } = setupConfirm();
    const { c } = twoWitnesses(v, "a", "small-model", "small-model");
    confirmRound(v, c, "a", "a", "a");
    const other = { ...RTX3060, gpu: { ...RTX3060.gpu!, model: "NVIDIA GeForce RTX 3060 Ti" } };
    v.register({ agentId: "w1", claimed: classifyHardware(other), profile: other, challengeKinds: ["cpu", "gpu"], nowMs: T0 + 100_000 });
    expect(v.get("w1")).toMatchObject({ witnessStrikes: 1, witnessStrikeTimes: [expect.any(Number)] });
  });


  it("no second witness available: settled unconfirmed, never invalid", () => {
    const { v } = setup2(() => undefined);
    const { r1, w2 } = firstRound(v, "a", "small-model");
    expect(w2).toBeUndefined();
    expect(r1.invalid).toBeUndefined();
    expect(v.get("g1")).toMatchObject({ status: "unverified", granted: { tier: "gpu.c8" }, lastFailReason: "cross_check_unavailable" });
    // A picker that returns an excluded agent counts as none.
    const again = setup2(() => "w1");
    expect(firstRound(again.v, "a", "small-model").r1.invalid).toBeUndefined();
    expect(again.v.get("g1")).toMatchObject({ status: "unverified", lastFailReason: "cross_check_unavailable" });
    // No picker configured at all: the same.
    const plain = setup();
    const c = plain.nextChallenge("g1", { nowMs: T0, model, pickWitness: () => "w1" }) as GpuChallenge;
    const w = plain.nextChallenge("w1", { nowMs: T0, model }) as GpuChallenge;
    const a = answer(c, 450);
    plain.submit("g1", a.res, a.at);
    expect(plain.submit("w1", { ...answer(w, 200, "small-model").res, challengeId: w.challengeId }, T0 + 20_000).invalid).toBeUndefined();
    expect(plain.get("g1")).toMatchObject({ status: "unverified", lastFailReason: "cross_check_unavailable" });
  });

  it("second witness never answers: settled unconfirmed after the witness timeout, never invalid", () => {
    const { v } = setup2();
    const { w2 } = firstRound(v, "a", "small-model");
    expect(w2).toBeDefined();
    expect(v.tick(T0 + 20_000 + CFG.witnessTimeoutMs - 1)).toEqual([]);
    expect(v.get("g1")?.status).toBe("pending");
    v.tick(T0 + 20_000 + CFG.witnessTimeoutMs + 1);
    expect(v.get("g1")).toMatchObject({ status: "unverified", lastFailReason: "cross_check_unavailable" });
    // The late answer finds nothing to settle.
    const late = v.submit("w2", { ...answer(w2!, 200, "small-model").res, challengeId: w2!.challengeId }, T0 + 20_000 + CFG.witnessTimeoutMs + 2);
    expect(late.invalid).toBeUndefined();
    expect(v.get("g1")?.status).toBe("unverified");
  });

  it("a second witness that did not follow the prompt counts as no witness", () => {
    const { v } = setup2();
    const { w2 } = firstRound(v, "a", "small-model");
    const r2 = v.submit("w2", { challengeId: w2!.challengeId, kind: "gpu", output: fakeModelOutput("another-nonce", 24), evalCount: 512, elapsedMs: 8_000 }, T0 + 40_000);
    expect(r2.invalid).toBeUndefined();
    expect(r2.disagreeingWitness).toBeUndefined();
    expect(v.get("g1")).toMatchObject({ status: "unverified", lastFailReason: "cross_check_unavailable" });
    expect(v.get("w1")?.witnessDisagreements).toBeUndefined();
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
    // One CPU-like sample is held and re-measured soon; a second one demotes out of the class.
    expect(v2.submit("g1", a2.res, a2.at)).toMatchObject({ changed: false });
    expect(v2.get("g1")).toMatchObject({ status: "unverified", granted: { tier: "gpu.c8" }, lastFailReason: "slow_sample_unconfirmed", nextChallengeAtMs: a2.at + CFG.slowConfirmMs });
    const c3 = v2.nextChallenge("g1", { nowMs: a2.at + CFG.slowConfirmMs, model }) as GpuChallenge;
    const a3 = answer(c3, 25, "a", 200);
    expect(v2.submit("g1", a3.res, a2.at + CFG.slowConfirmMs + (a3.at - T0))).toMatchObject({ changed: true });
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

describe("datacenter GPU grants (live regtest 2026-11-15: 2x NVIDIA A16 demoted to cpu)", () => {
  const model = "qwen3-coder:30b"; // MoE, 3.3B active: 1.98 GB read per token
  const A16x2: HardwareProfile = { cpuCores: 12, ramGb: 120, platform: "linux", arch: "x64", cpuModel: "Intel Xeon (Cascadelake)", gpu: { vendor: "nvidia", model: "NVIDIA A16", vramGb: 30, datacenter: true, count: 2 } };
  const claimed = classifyHardware(A16x2);

  function setup(config: HardwareVerificationConfig = CFG) {
    const v = verifier(config);
    v.register({ agentId: "a16", claimed, profile: A16x2, challengeKinds: ["cpu", "gpu"], nowMs: T0 });
    return v;
  }
  /** Answer `c` delivered at `at`: 512 tokens, Ollama's eval time, and the server's round trip. */
  function answerAt(c: GpuChallenge, evalMs: number, roundTripMs: number) {
    return { challengeId: c.challengeId, kind: "gpu" as const, output: fakeModelOutput(c.nonce, c.lines), evalCount: 512, evalDurationMs: evalMs, elapsedMs: roundTripMs - 100 };
  }

  it("claims gpu.dc40 with the pooled VRAM; unverified until measured, paid at the class base", () => {
    expect(claimed).toMatchObject({ computeClass: "gpu.dc", tier: "gpu.dc40", vramGb: 30 });
    const v = setup();
    expect(v.get("a16")).toMatchObject({ status: "unverified", hardware: { gpuModel: "NVIDIA A16", vramGb: 30, gpuCount: 2 } });
    expect(v.effective("a16", claimed)).toMatchObject({ computeClass: "gpu.dc", tier: "gpu.dc40" });
  });

  it("the live sample (cold first generation, 47 GB/s) no longer demotes to cpu; the warm re-measurement verifies gpu.dc40", () => {
    const v = setup();
    const c1 = v.nextChallenge("a16", { nowMs: T0, model }) as GpuChallenge;
    expect(c1.model).toBe(model);
    // As logged: 512 tokens in 18.9 s of eval (the first ~100 at ~10 tok/s), answered 23.5 s after delivery.
    const r1 = v.submit("a16", answerAt(c1, 18_937, 23_500), T0 + 23_500);
    expect(r1).toMatchObject({ accepted: true, changed: false });
    expect(v.get("a16")?.measured).toMatchObject({ supportedClass: "cpu", supportedTier: "cpu.std" });
    expect(v.get("a16")).toMatchObject({ status: "unverified", granted: { computeClass: "gpu.dc", tier: "gpu.dc40" }, lastFailReason: "slow_sample_unconfirmed" });
    expect(v.get("a16")?.flags).toContain("challenge_slow_unconfirmed");
    expect(v.effective("a16", claimed)).toMatchObject({ computeClass: "gpu.dc", tier: "gpu.dc40" });
    // Re-measured a minute later, warm: ~48 tok/s.
    const t2 = T0 + 23_500 + CFG.slowConfirmMs;
    expect(v.nextChallenge("a16", { nowMs: t2 - 1, model })).toBeUndefined();
    const c2 = v.nextChallenge("a16", { nowMs: t2, model }) as GpuChallenge;
    expect(c2.nonce).not.toBe(c1.nonce);
    const r2 = v.submit("a16", answerAt(c2, 10_667, 11_500), t2 + 11_500);
    expect(r2.invalid).toBeUndefined();
    const rec = v.get("a16")!;
    expect(rec.measured?.value).toBeGreaterThan(90);
    expect(rec).toMatchObject({ status: "verified", granted: { computeClass: "gpu.dc", tier: "gpu.dc40" } });
    expect(rec.flags).not.toContain("challenge_slow_unconfirmed");
    expect(rec.slowSample).toBeUndefined();
  });

  it("anti-spoofing: a CPU claiming a datacenter GPU measures CPU-like twice and is paid as cpu", () => {
    const v = setup();
    const c1 = v.nextChallenge("a16", { nowMs: T0, model }) as GpuChallenge;
    v.submit("a16", answerAt(c1, 30_000, 31_000), T0 + 31_000); // ~35 GB/s
    const t2 = T0 + 31_000 + CFG.slowConfirmMs;
    const c2 = v.nextChallenge("a16", { nowMs: t2, model }) as GpuChallenge;
    expect(v.submit("a16", answerAt(c2, 33_000, 34_000), t2 + 34_000)).toMatchObject({ changed: true });
    expect(v.get("a16")).toMatchObject({ status: "demoted", granted: { computeClass: "cpu", tier: "cpu.std" }, lastFailReason: "below_claimed_tier" });
    expect(v.effective("a16", claimed)).toMatchObject({ computeClass: "cpu", creditsPerSecond: 1 });
  });

  it("declining or ignoring the confirmation does not keep the grant: the held sample stands", () => {
    const declined = setup();
    const c1 = declined.nextChallenge("a16", { nowMs: T0, model }) as GpuChallenge;
    declined.submit("a16", answerAt(c1, 30_000, 31_000), T0 + 31_000);
    const c2 = declined.nextChallenge("a16", { nowMs: T0 + 31_000 + CFG.slowConfirmMs, model }) as GpuChallenge;
    expect(declined.submit("a16", { challengeId: c2.challengeId, kind: "gpu", elapsedMs: 5, declined: "busy" }, T0 + 100_000)).toMatchObject({ changed: true });
    expect(declined.get("a16")).toMatchObject({ status: "demoted", granted: { computeClass: "cpu" } });

    const silent = setup();
    const s1 = silent.nextChallenge("a16", { nowMs: T0, model }) as GpuChallenge;
    silent.submit("a16", answerAt(s1, 30_000, 31_000), T0 + 31_000);
    const t2 = T0 + 31_000 + CFG.slowConfirmMs;
    const s2 = silent.nextChallenge("a16", { nowMs: t2, model }) as GpuChallenge;
    silent.tick(t2 + s2.deadlineMs * CFG.expiryFactor + 1);
    expect(silent.get("a16")).toMatchObject({ status: "demoted", granted: { computeClass: "cpu" } });
  });

  it("a held slow sample older than the window is forgotten (a slow sample hours apart is a new first one)", () => {
    const v = setup();
    const c1 = v.nextChallenge("a16", { nowMs: T0, model }) as GpuChallenge;
    v.submit("a16", answerAt(c1, 30_000, 31_000), T0 + 31_000);
    const late = T0 + 31_000 + CFG.slowConfirmWindowMs + 1;
    const c2 = v.nextChallenge("a16", { nowMs: late, model }) as GpuChallenge;
    expect(v.submit("a16", answerAt(c2, 30_000, 31_000), late + 31_000)).toMatchObject({ changed: false });
    expect(v.get("a16")).toMatchObject({ status: "unverified", granted: { tier: "gpu.dc40" }, lastFailReason: "slow_sample_unconfirmed" });
  });

  it("an invalid answer still demotes at once (no confirmation for forged output)", () => {
    const v = setup();
    const c1 = v.nextChallenge("a16", { nowMs: T0, model }) as GpuChallenge;
    v.submit("a16", answerAt(c1, 30_000, 31_000), T0 + 31_000);
    const c2 = v.nextChallenge("a16", { nowMs: T0 + 31_000 + CFG.slowConfirmMs, model }) as GpuChallenge;
    const res = v.submit("a16", { ...answerAt(c2, 10_000, 11_000), output: fakeModelOutput("replayed", 24) }, T0 + 200_000);
    expect(res.invalid).toBe("output_missing_tags");
    expect(v.get("a16")).toMatchObject({ status: "demoted", granted: { tier: "gpu.dc40" } });
    expect(v.get("a16")?.slowSample).toBeUndefined();
  });

  it("faster than two A16s can be is not a measurement; the pool's sum bounds it", () => {
    const v = setup();
    const c = v.nextChallenge("a16", { nowMs: T0, model }) as GpuChallenge;
    // 1014 GB in 2.2 s by the server clock = 460 GB/s: under 2 x 200 x 1.2, so measured (and verified).
    expect(v.submit("a16", answerAt(c, 2_000, 2_200), T0 + 2_200).invalid).toBeUndefined();
    const single = verifier();
    const one = { ...A16x2, gpu: { ...A16x2.gpu!, vramGb: 15, count: undefined } };
    single.register({ agentId: "one", claimed: classifyHardware(one), profile: one, challengeKinds: ["gpu"], nowMs: T0 });
    const c1 = single.nextChallenge("one", { nowMs: T0, model }) as GpuChallenge;
    expect(single.submit("one", answerAt(c1, 2_000, 2_200), T0 + 2_200).invalid).toBe("faster_than_hardware");
  });

  it("a verified tier survives one cold revalidation; two slow ones demote to the better of the two", () => {
    const v = verifier({ ...CFG, requireCrossCheck: false });
    const rtx = classifyHardware(RTX4090);
    v.register({ agentId: "g1", claimed: rtx, profile: RTX4090, challengeKinds: ["gpu"], nowMs: T0 });
    const m9 = "qwen3.5:9b";
    const at = (c: GpuChallenge, gbps: number, t: number) => {
      const ms = Math.round(((512 * 5.4) / gbps) * 1000);
      return v.submit("g1", { challengeId: c.challengeId, kind: "gpu", output: fakeModelOutput(c.nonce, c.lines), evalCount: 512, evalDurationMs: ms, elapsedMs: ms }, t + ms + 100);
    };
    at(v.nextChallenge("g1", { nowMs: T0, model: m9 }) as GpuChallenge, 450, T0);
    expect(v.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" } });
    const t1 = v.get("g1")!.nextChallengeAtMs!;
    expect(at(v.nextChallenge("g1", { nowMs: t1, model: m9 }) as GpuChallenge, 200, t1)).toMatchObject({ changed: false });
    expect(v.get("g1")).toMatchObject({ status: "verified", granted: { tier: "gpu.c24" }, slowSample: { tier: "gpu.c16" } });
    const t2 = v.get("g1")!.nextChallengeAtMs!;
    expect(t2 - t1).toBeLessThan(CFG.slowConfirmMs + 30_000);
    expect(at(v.nextChallenge("g1", { nowMs: t2, model: m9 }) as GpuChallenge, 100, t2)).toMatchObject({ changed: true });
    expect(v.get("g1")).toMatchObject({ status: "demoted", granted: { tier: "gpu.c16" } }); // the better sample (c16), not c8
  });

  it("an unanswered challenge on a base-tier claim is not reported as verified", () => {
    const v = setup();
    const c = v.nextChallenge("a16", { nowMs: T0, model }) as GpuChallenge;
    v.tick(T0 + c.deadlineMs * CFG.expiryFactor + 1);
    expect(v.get("a16")).toMatchObject({ status: "unverified", lastFailReason: "challenge_timeout", granted: { tier: "gpu.dc40" } });
    expect(v.get("a16")?.lastPassAtMs).toBeUndefined();
  });

  it("pooled cards change the profile key only when there are several", () => {
    const single = { ...A16x2, gpu: { ...A16x2.gpu!, count: undefined } };
    expect(hardwareProfileKey("gpu.dc40", A16x2)).toBe(`${hardwareProfileKey("gpu.dc40", single)}|x2`);
    expect(hardwareProfileKey("gpu.dc40", { ...A16x2, gpu: { ...A16x2.gpu!, count: 1 } })).toBe(hardwareProfileKey("gpu.dc40", single));
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

describe("ipNetworkPrefix (witness independence)", () => {
  it("is the /24 of IPv4 and the /48 of IPv6", () => {
    expect(ipNetworkPrefix("203.0.113.45")).toBe("203.0.113.0/24");
    expect(ipNetworkPrefix("203.0.113.200")).toBe(ipNetworkPrefix("203.0.113.1"));
    expect(ipNetworkPrefix("203.0.114.1")).not.toBe(ipNetworkPrefix("203.0.113.1"));
    expect(ipNetworkPrefix("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
    expect(ipNetworkPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(ipNetworkPrefix("2001:0db8:abcd:ffff:1:2:3:4")).toBe("2001:db8:abcd::/48");
    expect(ipNetworkPrefix("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(ipNetworkPrefix("[2001:db8:abcd::5]")).toBe("2001:db8:abcd::/48");
    expect(ipNetworkPrefix("fe80::1%en0")).toBe("fe80:0:0::/48");
    expect(ipNetworkPrefix(undefined)).toBeUndefined();
    expect(ipNetworkPrefix("not-an-ip")).toBeUndefined();
    expect(ipNetworkPrefix("300.1.1.1")).toBeUndefined();
  });
});

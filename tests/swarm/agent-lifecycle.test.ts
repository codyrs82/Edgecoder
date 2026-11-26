import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "undici";
import { AgentLifecycle, announceGoingOffline, blacklistReasonFromError, handBackOnCriticalPressure } from "../../src/swarm/agent-lifecycle.js";
import { createLocalForwarder } from "../../src/swarm/local-forwarder.js";

describe("agent lifecycle (BHV006: drain before a restart, paused reason)", () => {
  it("draining stops pulls and lapses by itself; a stop drain does not", () => {
    let now = 1_000;
    const l = new AgentLifecycle(() => now);
    expect(l.canPull()).toBe(true);
    l.startDrain(60_000);
    expect(l.canPull()).toBe(false);
    expect(l.status()).toMatchObject({ draining: true, drainingUntilMs: 61_000 });
    now = 61_001;
    expect(l.canPull()).toBe(true);
    l.startDrain(60_000);
    l.endDrain();
    expect(l.canPull()).toBe(true);
    l.startDrain(Infinity);
    l.endDrain();
    expect(l.canPull()).toBe(false);
  });

  it("keeps the blacklist reason until the coordinator accepts the agent again", () => {
    const l = new AgentLifecycle(() => 5);
    l.notePaused("Auto-blacklisted by behavioral monitoring: BHV006");
    expect(l.status().paused).toEqual({ reason: "Auto-blacklisted by behavioral monitoring: BHV006", sinceMs: 5 });
    expect(l.canPull()).toBe(false);
    l.noteAccepted();
    expect(l.status().paused).toBeNull();
  });

  it("counts running claims, each ended once", () => {
    const l = new AgentLifecycle();
    const a = l.claimStarted();
    const b = l.claimStarted();
    expect(l.status().claims).toBe(2);
    a();
    a();
    expect(l.status().claims).toBe(1);
    b();
    expect(l.status().claims).toBe(0);
  });

  it("reads the reason from the worker's register refusal", () => {
    const err = new Error('POST /register failed (403): {"error":"agent_blacklisted","reason":"Auto-blacklisted by behavioral monitoring: BHV006, BHV006, BHV006 — Max heartbeat gap 495s while still claiming tasks"}');
    expect(blacklistReasonFromError(err)).toContain("Max heartbeat gap 495s");
    expect(blacklistReasonFromError(new Error("POST /register failed (401): {}"))).toBeNull();
  });

  it("announces going offline, bounded and never throwing", async () => {
    const sent: unknown[] = [];
    expect(await announceGoingOffline(async (b) => { sent.push(b); return { ok: true, offline: true, released: 2 }; }, "mac", "update")).toEqual({ ok: true, released: 2 });
    expect(sent).toEqual([{ agentId: "mac", goingOffline: "update" }]);
    expect(await announceGoingOffline(async () => { throw new Error("down"); }, "mac", "quit")).toEqual({ ok: false, released: 0 });
    expect(await announceGoingOffline(() => new Promise(() => {}), "mac", "quit", 20)).toEqual({ ok: false, released: 0 });
  });
});

describe("local forwarder: lifecycle on /forward/health and /forward/drain", () => {
  it("reports paused/claims and drains or resumes", async () => {
    const l = new AgentLifecycle();
    l.notePaused("Auto-blacklisted: test");
    const calls: boolean[] = [];
    const fwd: Server = createLocalForwarder({
      token: () => "t",
      coordinatorUrl: () => "http://127.0.0.1:1",
      meshHeaders: () => ({}),
      signedHeaders: () => ({}),
      agentId: "mac",
      lifecycle: () => l.status(),
      drain: async (resume) => { calls.push(resume); return { draining: !resume, released: resume ? 0 : 1, told: !resume }; },
    });
    await new Promise<void>((r) => fwd.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(fwd.address() as AddressInfo).port}`;
    try {
      const health = await request(`${url}/forward/health`, { headers: { authorization: "Bearer t" } });
      expect(await health.body.json()).toMatchObject({ paused: { reason: "Auto-blacklisted: test" }, claims: 0, draining: false });
      expect((await request(`${url}/forward/drain`, { method: "POST", body: "{}" })).statusCode).toBe(401);
      const drained = await request(`${url}/forward/drain`, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
      expect(await drained.body.json()).toEqual({ ok: true, draining: true, released: 1, told: true });
      const resumed = await request(`${url}/forward/drain`, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ resume: true }) });
      expect((await resumed.body.json()).draining).toBe(false);
      expect(calls).toEqual([false, true]);
    } finally {
      fwd.close();
    }
  });
});

describe("critical memory pressure hand-back (network run 17)", () => {
  it("hands claims back only when a network call was running to cancel", () => {
    // Nothing running: any claim held is one whose finished result is on its way.
    expect(handBackOnCriticalPressure(0)).toBe(false);
    expect(handBackOnCriticalPressure(1)).toBe(true);
    expect(handBackOnCriticalPressure(3)).toBe(true);
  });
});

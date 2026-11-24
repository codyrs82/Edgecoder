import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { CoordinatorDrain, installDrainHooks, installDrainSignals, RESTART_CLOSE_CODE, type DrainSocket } from "../../src/swarm/coordinator/drain.js";
import { createCoordinatorReconnectFrame, verifyCoordinatorReconnectFrame } from "../../src/mesh/coordinator-reconnect.js";
import { createPeerKeys } from "../../src/mesh/peer.js";

/*
 * Graceful coordinator stop (src/swarm/coordinator/drain.ts): while draining, new work is refused
 * (retryable, nothing charged) and claims get "no work"; running work finishes and its billing
 * settles; every agent gets a signed reconnect frame; then the server closes and the process exits.
 */
const log = { info: () => undefined, warn: () => undefined };
const coordKeys = createPeerKeys("coord-1");

function fakeSocket(peerId: string, agent: boolean, events: string[]): DrainSocket & { sent: string[]; closed: number | null } {
  const s = {
    peerId,
    agent,
    sent: [] as string[],
    closed: null as number | null,
    send(frame: string) {
      s.sent.push(frame);
      events.push(`frame:${peerId}`);
    },
    close(code: number) {
      s.closed = code;
      events.push(`close:${peerId}`);
    }
  };
  return s;
}

async function appWith(drain: CoordinatorDrain) {
  const app = Fastify();
  installDrainHooks(app as never, drain);
  let releaseSlow: (() => void) | null = null;
  for (const path of ["/submit", "/inference/submit", "/portal/chat", "/register", "/result", "/heartbeat"]) app.post(path, async () => ({ ok: true }));
  app.post("/pull", async () => ({ subtask: { id: "s1" } }));
  app.post("/slow", async () => {
    await new Promise<void>((r) => (releaseSlow = r));
    return { ok: true };
  });
  await app.ready();
  return { app, releaseSlow: () => releaseSlow?.() };
}

describe("coordinator drain", () => {
  it("serves as usual until a drain starts", async () => {
    const drain = new CoordinatorDrain();
    const { app } = await appWith(drain);
    expect((await app.inject({ method: "POST", url: "/submit", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/pull", payload: {} })).json()).toEqual({ subtask: { id: "s1" } });
    expect(drain.draining).toBe(false);
    await app.close();
  });

  it("refuses new work and claims, lets the running job finish and settle, tells every agent to reconnect, then exits", async () => {
    const drain = new CoordinatorDrain();
    drain.peerUrl = () => "https://coordinator-eu.example";
    const { app } = await appWith(drain);
    const events: string[] = [];
    let claims = 1;
    let accruals = 0;
    const agentA = fakeSocket("agent-a", true, events);
    const agentB = fakeSocket("agent-b", true, events);
    const peer = fakeSocket("coord-2", false, events);
    let exitCode: number | null = null;
    const done = drain.run({
      drainMs: 5_000,
      pollMs: 5,
      flushMs: 1,
      busy: () => ({ claims, accruals }),
      settle: async () => {
        events.push("settle");
        return 1;
      },
      sockets: () => [agentA, agentB, peer],
      frameFor: (agentId) => JSON.stringify(createCoordinatorReconnectFrame({ agentId, coordinatorId: coordKeys.peerId, privateKeyPem: coordKeys.privateKeyPem, delayMs: 2_000, jitterMs: 8_000 })),
      close: async () => {
        events.push("server_closed");
        await app.close();
      },
      exit: (code) => {
        exitCode = code;
        events.push("exit");
      },
      log
    });
    expect(drain.draining).toBe(true);

    // New jobs: retryable 503 with a peer to go to, nothing charged.
    for (const url of ["/submit", "/inference/submit", "/portal/chat"]) {
      const res = await app.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(503);
      expect(res.headers["retry-after"]).toBe("3");
      expect(res.json()).toMatchObject({ error: "coordinator_draining", retryable: true, charged: false, coordinatorUrl: "https://coordinator-eu.example" });
    }
    // Claims: no work (agents keep polling calmly); registration goes to the next instance.
    expect((await app.inject({ method: "POST", url: "/pull", payload: {} })).json()).toMatchObject({ subtask: null, draining: true });
    const reg = await app.inject({ method: "POST", url: "/register", payload: {} });
    expect(reg.statusCode).toBe(503);
    expect(reg.json().coordinatorUrl).toBeUndefined();
    // The running job's result and heartbeats still land.
    expect((await app.inject({ method: "POST", url: "/result", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/heartbeat", payload: {} })).statusCode).toBe(200);

    // Still waiting for the claim: nothing sent yet.
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual([]);
    // The job's result is being paid, then done.
    accruals = 1;
    claims = 0;
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual([]);
    events.push("job_done");
    accruals = 0;

    const report = await done;
    expect(report).toMatchObject({ idle: true, settled: 1, reconnectSent: 2, socketsClosed: 3 });
    expect(events).toEqual(["job_done", "settle", "frame:agent-a", "frame:agent-b", "close:agent-a", "close:agent-b", "close:coord-2", "server_closed", "exit"]);
    expect(exitCode).toBe(0);
    expect(peer.sent).toEqual([]);
    expect([agentA.closed, agentB.closed, peer.closed]).toEqual([RESTART_CLOSE_CODE, RESTART_CLOSE_CODE, RESTART_CLOSE_CODE]);
    // Each frame is signed for its own agent by this coordinator.
    const frame = JSON.parse(agentA.sent[0]);
    expect(verifyCoordinatorReconnectFrame(frame, { agentId: "agent-a", coordinator: coordKeys })).toMatchObject({ ok: true, command: { delayMs: 2_000, jitterMs: 8_000, reason: "draining" } });
    expect(verifyCoordinatorReconnectFrame(frame, { agentId: "agent-b", coordinator: coordKeys })).toEqual({ ok: false, reason: "wrong_agent" });
  });

  it("waits for open requests, and exits at the deadline when work is still running", async () => {
    const drain = new CoordinatorDrain();
    const { app, releaseSlow } = await appWith(drain);
    const slow = app.inject({ method: "POST", url: "/slow", payload: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(drain.openRequests).toBe(1);
    let exited = false;
    const t0 = Date.now();
    const report = await drain.run({
      drainMs: 120,
      pollMs: 5,
      busy: () => ({ claims: 0, accruals: 0 }),
      settle: async () => 0,
      sockets: () => [],
      frameFor: () => "",
      close: async () => undefined,
      exit: () => (exited = true),
      log
    });
    expect(report.idle).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    expect(exited).toBe(true);
    releaseSlow();
    expect((await slow).statusCode).toBe(200);
    expect(drain.openRequests).toBe(0);
    await app.close();
  });

  it("a second signal joins the first drain; SIGTERM and SIGINT both start it", async () => {
    const handlers = new Map<string, () => void>();
    const started: string[] = [];
    installDrainSignals((sig) => started.push(sig), { once: ((sig: string, fn: () => void) => handlers.set(sig, fn)) as never });
    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    expect(started).toEqual(["SIGTERM", "SIGINT"]);

    const drain = new CoordinatorDrain();
    let exits = 0;
    const deps = { drainMs: 0, busy: () => ({ claims: 0, accruals: 0 }), settle: async () => 0, sockets: () => [], frameFor: () => "", close: async () => undefined, exit: () => void exits++, log };
    const a = drain.run(deps);
    const b = drain.run(deps);
    expect(a).toBe(b);
    await a;
    expect(exits).toBe(1);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DRAIN_AWAY_MAX_MS,
  DRAIN_FAILOVER_JITTER_MS,
  DrainFailover,
  HOME_PROBE_JITTER_MS,
  HOME_PROBE_MS,
  HOME_RETURN_HOLD_MAX_MS,
  HOME_RETURN_JITTER_MS,
  NO_PEER_RETRY_MS,
  HomeProbe,
  ReturnHome,
  homeProbeState
} from "../../src/mesh/drain-failover.js";
import {
  CoordinatorReconnectState,
  CoordinatorRestartWindow,
  RESTART_FAILOVER_AFTER_MS,
  createCoordinatorDrainNoticeFrame,
  createCoordinatorReconnectFrame,
  verifyCoordinatorDrainNoticeFrame
} from "../../src/mesh/coordinator-reconnect.js";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { ActiveCoordinator } from "../../src/swarm/active-coordinator.js";
import { createCoordinatorClient, type RequestFn } from "../../src/swarm/coordinator-client.js";
import { decodePendingResult, encodePendingResult, flushPendingResultBuffer, ResultNotRoutableYetError } from "../../src/swarm/pending-results.js";
import { pullSkipReason, runsBesideLoop } from "../../src/swarm/pull-skip.js";

/*
 * Outage test 3b (run 8): a planned restart of the US seed left its agents unused for 39-45 s while
 * buyers redirected to the EU seed got "busy". On a drain signal the agent now serves through a peer
 * within about a second, keeps its claims' traffic on the coordinator that issued them, and comes
 * home once the restarted instance answers.
 */
const US = "https://us.example";
const EU = "https://eu.example";
const T0 = 1_800_000_000_000;

describe("restart window: planned vs unplanned", () => {
  it("a planned drain may fail over at once", () => {
    const w = new CoordinatorRestartWindow();
    w.open(T0, true);
    expect(w.isPlanned(T0)).toBe(true);
    expect(w.mayFailOver(T0)).toBe(true);
  });
  it("an unexplained loss still waits RESTART_FAILOVER_AFTER_MS (a blip does not bounce agents)", () => {
    const w = new CoordinatorRestartWindow();
    w.open(T0);
    expect(w.mayFailOver(T0 + 1_000)).toBe(false);
    expect(w.mayFailOver(T0 + RESTART_FAILOVER_AFTER_MS - 1)).toBe(false);
    expect(w.mayFailOver(T0 + RESTART_FAILOVER_AFTER_MS)).toBe(true);
  });
  it("a planned signal upgrades an open window without extending it; close resets", () => {
    const w = new CoordinatorRestartWindow();
    w.open(T0);
    w.open(T0 + 5_000, true);
    expect(w.mayFailOver(T0 + 5_000)).toBe(true);
    w.close();
    w.open(T0 + 10_000);
    expect(w.isPlanned(T0 + 10_000)).toBe(false);
  });
  it("the reconnect hold can be cleared when the agent moves to a peer", () => {
    const keys = createPeerKeys("coord-x");
    const r = new CoordinatorReconnectState(() => 0.5);
    const f = createCoordinatorReconnectFrame({ agentId: "a", coordinatorId: keys.peerId, privateKeyPem: keys.privateKeyPem, delayMs: 2_000, jitterMs: 8_000, nowMs: T0 });
    r.accept(f.command, T0);
    expect(r.holdMs(T0)).toBeGreaterThan(0);
    r.clear();
    expect(r.holdMs(T0)).toBe(0);
    expect(r.pending(T0)).toBe(false);
  });
});

describe("drain notice frame", () => {
  const coord = createPeerKeys("coord-us");
  const verified = { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem };
  it("verifies and carries the signed peer URL", () => {
    const f = createCoordinatorDrainNoticeFrame({ agentId: "a1", coordinatorId: coord.peerId, privateKeyPem: coord.privateKeyPem, peerUrl: EU, nowMs: T0 });
    const v = verifyCoordinatorDrainNoticeFrame(JSON.parse(JSON.stringify(f)), { agentId: "a1", coordinator: verified, nowMs: T0 + 100 });
    expect(v.ok && v.command.peerUrl).toBe(EU);
  });
  it("refuses a changed peer URL, another agent, another coordinator, an expired frame", () => {
    const f = createCoordinatorDrainNoticeFrame({ agentId: "a1", coordinatorId: coord.peerId, privateKeyPem: coord.privateKeyPem, peerUrl: EU, nowMs: T0 });
    const tampered = { ...f, command: { ...f.command, peerUrl: "https://evil.example" } };
    expect(verifyCoordinatorDrainNoticeFrame(tampered, { agentId: "a1", coordinator: verified, nowMs: T0 })).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyCoordinatorDrainNoticeFrame(f, { agentId: "a2", coordinator: verified, nowMs: T0 })).toEqual({ ok: false, reason: "wrong_agent" });
    const other = createPeerKeys("coord-eu");
    expect(verifyCoordinatorDrainNoticeFrame(f, { agentId: "a1", coordinator: { peerId: other.peerId, publicKeyPem: other.publicKeyPem }, nowMs: T0 })).toEqual({ ok: false, reason: "wrong_coordinator" });
    expect(verifyCoordinatorDrainNoticeFrame(f, { agentId: "a1", coordinator: verified, nowMs: T0 + 120_000 })).toEqual({ ok: false, reason: "expired" });
    expect(verifyCoordinatorDrainNoticeFrame(f, { agentId: "a1", coordinator: null, nowMs: T0 })).toEqual({ ok: false, reason: "no_verified_coordinator" });
  });
  it("is a different type and signing domain from the reconnect frame (older agents ignore it)", () => {
    const n = createCoordinatorDrainNoticeFrame({ agentId: "a1", coordinatorId: coord.peerId, privateKeyPem: coord.privateKeyPem, nowMs: T0 });
    expect(n.type).toBe("coordinator_drain_notice");
    expect(n.command.peerUrl).toBe("");
  });
});

describe("home probe", () => {
  it("up only for an identity answer without draining", () => {
    expect(homeProbeState(200, { peerId: "p" })).toBe("up");
    expect(homeProbeState(200, { peerId: "p", draining: true })).toBe("draining");
    expect(homeProbeState(502, null)).toBe("down");
    expect(homeProbeState(null, null)).toBe("down");
    expect(homeProbeState(200, "<html>")).toBe("down");
  });
});

describe("drain failover", () => {
  it("drain notice -> serving through the peer within ~1 s -> home after the restart", () => {
    const f = new DrainFailover(() => 0.999);
    expect(f.notice({ drainingUrl: US, peerUrl: EU, reason: "drain_notice", nowMs: T0 })).toBe(true);
    expect(f.failoverDue(T0)).toBe(false);
    const due = T0 + DRAIN_FAILOVER_JITTER_MS;
    expect(f.failoverDue(due)).toBe(true);
    expect(DRAIN_FAILOVER_JITTER_MS).toBeLessThanOrEqual(1_000); // + one register: well within ~3 s
    // Steering still picks the draining home (or nothing): the notice's peer is used.
    expect(f.pickPeer([US, f.peerHint])).toBe(EU);
    f.moved(EU, due);
    expect(f.state).toBe("away");
    // The old instance drains, then restarts: keep serving through the peer.
    let t = due + HOME_PROBE_MS + HOME_PROBE_JITTER_MS;
    expect(f.homeProbeDue(t)).toBe(true);
    expect(f.onHomeProbe("draining", t)).toBe(false);
    t += HOME_PROBE_MS + HOME_PROBE_JITTER_MS;
    expect(f.onHomeProbe("down", t)).toBe(false);
    t += HOME_PROBE_MS + HOME_PROBE_JITTER_MS;
    expect(f.onHomeProbe("up", t)).toBe(true);
    expect(f.state).toBe("returning");
    expect(f.returnDue(t + HOME_RETURN_JITTER_MS)).toBe(true);
    f.homing();
    f.registered(US + "/");
    expect(f.state).toBe("idle");
    expect(f.home).toBeNull();
  });

  it("a second signal for the same drain does not restart it; a late home signal while away is ignored", () => {
    const f = new DrainFailover(() => 0);
    expect(f.notice({ drainingUrl: US, reason: "pull_draining", nowMs: T0 })).toBe(true);
    expect(f.notice({ drainingUrl: US, peerUrl: EU, reason: "reconnect_frame", nowMs: T0 + 10 })).toBe(false);
    expect(f.peerHint).toBe(EU);
    f.moved(EU, T0 + 20);
    expect(f.notice({ drainingUrl: US, reason: "restart_close", nowMs: T0 + 30 })).toBe(false);
    expect(f.state).toBe("away");
  });

  it("never picks a draining coordinator; with no peer it waits and stays home", () => {
    const f = new DrainFailover(() => 0);
    f.notice({ drainingUrl: US, reason: "drain_notice", nowMs: T0 });
    expect(f.pickPeer([US, `${US}/`, null])).toBeNull();
    f.noPeer(T0);
    expect(f.failoverDue(T0 + NO_PEER_RETRY_MS - 1)).toBe(false);
    expect(f.failoverDue(T0 + NO_PEER_RETRY_MS)).toBe(true);
  });

  it("the peer drains too: leaves it as well, excluding both", () => {
    const f = new DrainFailover(() => 0);
    f.notice({ drainingUrl: US, reason: "drain_notice", nowMs: T0 });
    f.moved(EU, T0);
    expect(f.notice({ drainingUrl: EU, reason: "drain_notice", nowMs: T0 + 1 })).toBe(true);
    expect(f.pickPeer([US, EU, "https://ap.example"])).toBe("https://ap.example");
    expect(f.home).toBe(US);
  });

  it("home not ready on return: back to the peer, probe again", () => {
    const f = new DrainFailover(() => 0);
    f.notice({ drainingUrl: US, reason: "drain_notice", nowMs: T0 });
    f.moved(EU, T0);
    f.onHomeProbe("up", T0 + HOME_PROBE_MS);
    f.homing();
    expect(f.homeNotReady(T0 + HOME_PROBE_MS + 1)).toBe(EU);
    expect(f.state).toBe("away");
  });

  it("comes home only once the peer's own calls are done (bounded), so the peer does not take them back", () => {
    const f = new DrainFailover(() => 0);
    f.notice({ drainingUrl: US, reason: "drain_notice", nowMs: T0 });
    f.moved(EU, T0);
    expect(f.holdingForPeerCalls(2, T0)).toBe(false); // not returning yet: serving the peer as usual
    f.onHomeProbe("up", T0 + 3_000);
    expect(f.returnDue(T0 + 3_000)).toBe(true);
    expect(f.holdingForPeerCalls(2, T0 + 3_000)).toBe(true);
    expect(f.holdingForPeerCalls(0, T0 + 3_000)).toBe(false);
    expect(f.holdingForPeerCalls(1, T0 + 3_000 + HOME_RETURN_HOLD_MAX_MS)).toBe(false);
  });

  it("bounded: after DRAIN_AWAY_MAX_MS it stops probing and stays", () => {
    const f = new DrainFailover(() => 0);
    f.notice({ drainingUrl: US, reason: "drain_notice", nowMs: T0 });
    f.moved(EU, T0);
    f.onHomeProbe("down", T0 + DRAIN_AWAY_MAX_MS + 1);
    expect(f.state).toBe("idle");
  });

  it("spreads the agents of one coordinator over the jitter (no registration storm on the peer)", () => {
    const dues = [0, 0.25, 0.5, 0.75, 0.99].map((r) => {
      const f = new DrainFailover(() => r);
      f.notice({ drainingUrl: US, reason: "drain_notice", nowMs: T0 });
      return f.msUntilDue(T0);
    });
    expect(new Set(dues).size).toBe(5);
    expect(Math.max(...dues)).toBeLessThan(DRAIN_FAILOVER_JITTER_MS);
  });
});

describe("claims across the switch: traffic stays with the issuing coordinator", () => {
  const usKeys = createPeerKeys("coord-us");
  const euKeys = createPeerKeys("coord-eu");
  const ids: Record<string, { peerId: string; publicKeyPem: string }> = {
    [US]: { peerId: usKeys.peerId, publicKeyPem: usKeys.publicKeyPem },
    [EU]: { peerId: euKeys.peerId, publicKeyPem: euKeys.publicKeyPem }
  };
  function setup(opts: { accept?: (url: string) => boolean } = {}) {
    const trust = {
      check: async (url: string) => ({ trusted: true, coordinatorUrl: url, peerId: ids[url].peerId, publicKeyPem: ids[url].publicKeyPem, responseSigning: true }),
      forget: () => undefined
    };
    const active = new ActiveCoordinator(US, trust as never);
    const sent: Array<{ url: string; peer: string }> = [];
    let lastUrl = "";
    const request: RequestFn = async (url) => {
      lastUrl = url;
      return { statusCode: 200, headers: {}, body: { arrayBuffer: async () => new TextEncoder().encode("{}").buffer as ArrayBuffer } };
    };
    // The verifier sees which key the response is checked against for each URL.
    const verifier = {
      check: (_res: unknown, _sent: unknown, identity: { peerId: string }) => {
        sent.push({ url: lastUrl, peer: identity.peerId });
        return opts.accept && !opts.accept(lastUrl) ? { accept: false, error: "response_bad_signature" } : { accept: true, signed: true };
      }
    };
    const client = createCoordinatorClient({ coordinator: active, verifier: verifier as never, agentId: "a1", request });
    return { active, client, sent };
  }

  it("lease renewals, chunks and the result of a claim pulled before the move go to the home; new work goes to the peer", async () => {
    const s = setup();
    await s.active.verify();
    const issuer = s.active.requireVerifiedIdentity(); // snapshot at pull time
    s.active.set(EU, "drain_failover:drain_notice");
    await s.active.verify();
    await s.client.call({ method: "POST", path: "/heartbeat" }, issuer);
    await s.client.call({ method: "POST", path: "/inference/chunks" }, issuer);
    await s.client.call({ method: "POST", path: "/result" }, issuer);
    await s.client.call({ method: "POST", path: "/pull" });
    expect(s.sent).toEqual([
      { url: `${US}/heartbeat`, peer: usKeys.peerId },
      { url: `${US}/inference/chunks`, peer: usKeys.peerId },
      { url: `${US}/result`, peer: usKeys.peerId },
      { url: `${EU}/pull`, peer: euKeys.peerId }
    ]);
  });

  it("a claim's traffic still flows while the active coordinator is being re-verified", async () => {
    const s = setup();
    await s.active.verify();
    const issuer = s.active.requireVerifiedIdentity();
    s.active.set(EU, "drain_failover");
    // EU not verified yet: the pinned US claim is unaffected.
    await s.client.call({ method: "POST", path: "/result" }, issuer);
    expect(s.sent[0].url).toBe(`${US}/result`);
    await expect(s.client.call({ method: "POST", path: "/pull" })).rejects.toThrow(/coordinator_not_verified/);
  });

  it("a refused response from the old coordinator does not drop the peer's verification", async () => {
    const s = setup({ accept: (url) => !url.startsWith(US) });
    await s.active.verify();
    const issuer = s.active.requireVerifiedIdentity();
    s.active.set(EU, "drain_failover");
    await s.active.verify();
    await expect(s.client.call({ method: "POST", path: "/result" }, issuer)).rejects.toThrow(/coordinator_response_rejected/);
    expect(s.active.isVerified()).toBe(true);
  });

  it("a buffered result goes to its issuer, waits when that cannot be reached, and old rows go to the active one", async () => {
    const rows = [
      { subtaskId: "old", payload: JSON.stringify({ subtaskId: "old" }), attempts: 0 },
      { subtaskId: "us-1", payload: encodePendingResult({ subtaskId: "us-1" }, US), attempts: 0 },
      { subtaskId: "ap-1", payload: encodePendingResult({ subtaskId: "ap-1" }, "https://ap.example"), attempts: 0 }
    ];
    const synced: string[] = [];
    const store = { listPendingResults: () => rows, markResultSynced: (id: string) => synced.push(id), incrementResultAttempt: () => undefined };
    const delivered: Array<[string, string | undefined]> = [];
    const out = await flushPendingResultBuffer(
      store,
      async (payload, issuer) => {
        if (issuer === "https://ap.example") throw new ResultNotRoutableYetError(issuer);
        delivered.push([(payload as { subtaskId: string }).subtaskId, issuer]);
      },
      { info: () => undefined, warn: () => undefined }
    );
    expect(delivered).toEqual([["old", undefined], ["us-1", US]]);
    expect(out.skipped).toEqual(["ap-1"]);
    expect(synced).toEqual(["old", "us-1"]);
    expect(decodePendingResult(JSON.parse(rows[1].payload))).toEqual({ payload: { subtaskId: "us-1" }, issuerUrl: US });
    expect(decodePendingResult({ subtaskId: "x" })).toEqual({ payload: { subtaskId: "x" } });
  });
});

describe("worker wiring", () => {
  const src = readFileSync(new URL("../../src/swarm/worker-runner.ts", import.meta.url), "utf8");
  it("every planned signal starts the drain failover", () => {
    expect(src).toContain('onCoordinatorDrainNotice(message, coordinatorUrl)');
    expect(src).toContain('onPlannedDrain("pull_draining"');
    expect(src).toContain('onPlannedDrain("reconnect_frame"');
    expect(src).toContain('onPlannedDrain("restart_close"');
    expect(src).toContain('onPlannedDrain("register_draining"');
    expect(src).toMatch(/function onPlannedDrain[\s\S]{0,300}restartWindow\.open\(Date\.now\(\), true\)/);
  });
  it("pins a claim's lease renewals, chunks, result and buffered result to its issuer", () => {
    expect(src).toContain("startLeaseHeartbeat(issuer)");
    expect(src).toContain("signed: true, to: issuer })");
    expect(src).toContain('await post("/result", resultPayload, { signed: true, to: issuer });');
    expect(src).toContain("encodePendingResult(resultPayload, issuer?.url, envelopeForTask ? ENVELOPE_KEY_ID : undefined)");
    expect(src).toMatch(/pullIssuer = coordinator\.requireVerifiedIdentity\(\)[\s\S]{0,500}await post\("\/pull"/);
  });
  it("the return waits for the peer's calls and reports no free slot meanwhile", () => {
    expect(src).toContain("peerCallsInFlight: () => claimsInFlightFor(drainFailover.away),");
    expect(src).toContain("freeInferenceSlots: drainReturnHold ? 0 : freeInferenceSlots");
    expect(src).toMatch(/claimsInFlight\.set\(key, \(claimsInFlight\.get\(key\) \?\? 0\) \+ 1\);\s*try \{\s*await runAndReportClaim\(\);/);
  });
  it("run 11: a model call runs beside the loop on any slot count, so a busy host still moves for a drain", () => {
    expect(src).toContain("if (runsBesideLoop(st.kind, MAX_PARALLEL_INFERENCE)) {");
    expect(src).not.toContain('st.kind === "inference" && MAX_PARALLEL_INFERENCE > 1');
    // The notice wakes the loop, and each pass steps the failover before anything else (no pull needed).
    expect(src).toMatch(/function onPlannedDrain[\s\S]{0,900}wakeLoop\(false\);/);
    expect(src).toMatch(/if \(coordinatorOnline\) \{[\s\S]{0,300}if \(drainFailover\.active\(\)\) await stepDrainFailover\(homeReturn\);/);
  });
  it("run 15: the return home registers at home beside the loop and switches only after (make before break)", () => {
    expect(src).not.toContain('coordinator.set(home, "drain_return")');
    expect(src).toContain('coordinator.adopt(reg.target.url, reg.target.identity, "drain_return");');
    expect(src).toContain("{ signed: true, to: target, retries: 0, timeoutMs: HOME_REGISTER_TIMEOUT_MS }");
    expect(src).toContain("if (home) homeReturn.step();");
    // The old switch-then-register path and its error branch are gone.
    expect(src).not.toContain("drain_return_not_ready");
  });
  it("run 19: going home, the agent sends the peer its leaving pull (pinned to the peer, before nothing else)", () => {
    expect(src).toMatch(/peerTarget = coordinator\.requireVerifiedIdentity\(\);[\s\S]{0,200}coordinator\.adopt\(reg\.target\.url, reg\.target\.identity, "drain_return"\);[\s\S]{0,200}if \(peerTarget\) void tellPeerLeaving\(peerTarget\);/);
    expect(src).toContain('post("/pull", leavingPullBody({ agentId: AGENT_ID, slots: MAX_PARALLEL_INFERENCE, contextWindow: CONTEXT_WINDOW }), { signed: true, to: peer, retries: 0, timeoutMs: 3_000 })');
  });
  it("run 19: the home probe runs beside the loop (HomeProbe), not awaited in the drain step", () => {
    expect(src).not.toContain("onHomeProbe(await probeDrainHome(home))");
    expect(src).toContain("if (home) homeProbe.step();");
    expect(src).toContain("probe: (home) => probeDrainHome(home),");
  });
  it("run 15: with a peer named, the move waits for steering at most DRAIN_STEER_WAIT_MS", () => {
    expect(src).toMatch(/drainFailover\.peerHint\s*\? await Promise\.race\(\[steering, new Promise<null>\(\(r\) => setTimeout\(\(\) => r\(null\), DRAIN_STEER_WAIT_MS\)/);
  });
  it("the generic in-window failover does not run during a planned drain failover (it comes home instead)", () => {
    expect(src).toContain("if (!drainFailover.active() && restartWindow.mayFailOver()) {");
  });
});

/*
 * Network run 11 (1 slot per host since #589): after a planned restart of the US seed its agents took
 * 14-66 s to reach the EU peer, against 2-3 s in run 9 at 2 slots. A 1-slot host ran its model call
 * inside the loop, so the loop that moves to the peer and registers there waited for the call. A
 * miniature of the loop: each pass steps the failover, registers where it works now, then pulls if it
 * has a free slot; model calls run beside it (runsBesideLoop), their result going to their issuer.
 */
describe("busy 1-slot host during a planned drain (run 11)", () => {
  const HOME = "https://us.example";
  const PEER = "https://eu.example";
  const CALL_MS = 60_000;

  function simulate(besideLoop: (kind: string, slots: number) => boolean) {
    let now = 0;
    const slots = 1;
    const failover = new DrainFailover(() => 0.5);
    let url = HOME;
    let registeredWith = HOME;
    let registeredPeerAt: number | null = null;
    let inflight: { endsAt: number; issuer: string } | null = null;
    const results: Array<{ issuer: string; at: number }> = [];
    const pulls: Array<{ url: string; at: number }> = [];
    let noticeAt: number | null = 500;
    let loopFreeAt = 0;
    const finishCall = () => {
      if (inflight && now >= inflight.endsAt) {
        results.push({ issuer: inflight.issuer, at: inflight.endsAt });
        inflight = null;
      }
    };
    while (now <= 120_000) {
      finishCall();
      if (noticeAt !== null && now >= noticeAt) {
        failover.notice({ drainingUrl: HOME, peerUrl: PEER, reason: "drain_notice", nowMs: now });
        noticeAt = null;
      }
      if (now >= loopFreeAt) {
        if (failover.failoverDue(now)) {
          url = failover.pickPeer([PEER])!;
          failover.moved(url, now);
        }
        if (registeredWith !== url) {
          registeredWith = url;
          if (url === PEER && registeredPeerAt === null) registeredPeerAt = now;
        }
        const busy = inflight ? 1 : 0;
        const skip = pullSkipReason({
          pullsFromCoordinator: true, sandboxDown: false, lifecycleCanPull: true, memoryOk: true, shuttingDown: false, inferenceOnly: true,
          slots, inflight: busy, free: slots - busy, reportAnyway: false, drainReturnHold: false, cpuThrottled: false
        });
        // The home hands it a call before the drain (and nothing once draining); the peer, one per pull.
        if (skip === null && (now === 0 || url === PEER)) {
          pulls.push({ url, at: now });
          inflight = { endsAt: now + CALL_MS, issuer: url };
          // Inside the loop: the loop is held until the call ends.
          if (!besideLoop("inference", slots)) loopFreeAt = inflight.endsAt;
        }
      }
      now += 100;
    }
    return { registeredPeerAt, results, pulls };
  }

  it("beside the loop: registers with the peer within about a second while its call runs; the call finishes at its issuer", () => {
    const r = simulate(runsBesideLoop);
    expect(r.registeredPeerAt).not.toBeNull();
    expect(r.registeredPeerAt! - 500).toBeLessThanOrEqual(DRAIN_FAILOVER_JITTER_MS + 100);
    // The call the home issued finishes and reports to the home.
    expect(r.results[0]).toEqual({ issuer: HOME, at: CALL_MS });
    // Its next pull, once the slot is free, goes to the peer.
    expect(r.pulls[1]).toEqual({ url: PEER, at: CALL_MS });
  });

  it("inside the loop (the old 1-slot path): the move waits for the running call", () => {
    const r = simulate((kind, slots) => kind === "inference" && slots > 1);
    expect(r.registeredPeerAt).toBe(CALL_MS);
  });

  it("runsBesideLoop: model calls on any slot count; code jobs never", () => {
    expect(runsBesideLoop("inference", 1)).toBe(true);
    expect(runsBesideLoop("inference", 4)).toBe(true);
    expect(runsBesideLoop("inference", 0)).toBe(false);
    expect(runsBesideLoop("single_step", 1)).toBe(false);
  });
});

/*
 * Network run 15 (3b): the US seed was back 8 s after its restart. Its agents left the EU peer as
 * soon as it answered and then took 10-25 s to register on the just-booted instance (15 s timeout,
 * two retries), listed by neither coordinator meanwhile. The return is now make before break.
 */
describe("return home, make before break (run 15)", () => {
  const HOME = "https://us.example";
  const PEER = "https://eu.example";
  const flush = () => new Promise<void>((r) => setImmediate(r));

  function setup(attempts: Array<{ resolveAtMs: number; ok: boolean }>) {
    let now = 0;
    const failover = new DrainFailover(() => 0.5);
    let active = HOME;
    const switches: number[] = [];
    const started: number[] = [];
    const pending: Array<{ at: number; ok: boolean; resolve: () => void; reject: (e: Error) => void }> = [];
    const homeUpAtMs = 8_000;
    const homeReturn = new ReturnHome({
      failover,
      peerCallsInFlight: () => 0,
      registerAtHome: () => {
        const plan = attempts[started.length] ?? { resolveAtMs: 1_000, ok: true };
        started.push(now);
        return new Promise<void>((resolve, reject) => pending.push({ at: now + plan.resolveAtMs, ok: plan.ok, resolve, reject }));
      },
      switchHome: (home) => {
        active = home;
        switches.push(now);
      },
      wake: () => undefined,
      now: () => now
    });
    failover.notice({ drainingUrl: HOME, peerUrl: PEER, reason: "drain_notice", nowMs: 0 });
    /** One worker pass every 100 ms, as stepDrainFailover drives it. */
    async function run(untilMs: number, onTick?: (t: number) => void) {
      for (; now <= untilMs; now += 100) {
        for (const p of pending.splice(0)) {
          if (now >= p.at) {
            if (p.ok) p.resolve();
            else p.reject(new Error("POST /register failed: timeout"));
          } else pending.push(p);
        }
        await flush();
        if (failover.failoverDue(now)) {
          active = failover.pickPeer([PEER])!;
          failover.moved(active, now);
        }
        if (failover.homeProbeDue(now)) failover.onHomeProbe(now >= homeUpAtMs ? "up" : "down", now);
        if (failover.home) homeReturn.step();
        onTick?.(now);
      }
    }
    return { run, get active() { return active; }, switches, started, failover, homeReturn };
  }

  it("home back at 8 s, its first registration times out: the agent stays on the peer throughout, then switches once home takes it", async () => {
    const sim = setup([{ resolveAtMs: 8_000, ok: false }, { resolveAtMs: 3_000, ok: true }]);
    const onPeerWhileRegistering: boolean[] = [];
    await sim.run(40_000, (t) => {
      if (sim.homeReturn.registering) onPeerWhileRegistering.push(sim.active === PEER);
      // Never between coordinators: on the peer until the switch, home after.
      if (t >= 600) expect(sim.active === PEER || sim.active === HOME).toBe(true);
    });
    expect(sim.started.length).toBe(2);
    // The first attempt starts after home answers (8 s) and the return jitter, while still on the peer.
    expect(sim.started[0]).toBeGreaterThanOrEqual(8_000);
    expect(onPeerWhileRegistering.length).toBeGreaterThan(0);
    expect(onPeerWhileRegistering.every(Boolean)).toBe(true);
    // One switch, right after the second registration succeeded; then the failover is over.
    expect(sim.switches).toHaveLength(1);
    expect(sim.switches[0]).toBeGreaterThanOrEqual(sim.started[1] + 3_000);
    expect(sim.switches[0]).toBeLessThanOrEqual(sim.started[1] + 3_100);
    expect(sim.active).toBe(HOME);
    expect(sim.failover.state).toBe("idle");
  });

  it("a slow registration that succeeds: still on the peer until it does", async () => {
    const sim = setup([{ resolveAtMs: 6_000, ok: true }]);
    await sim.run(30_000);
    expect(sim.started).toHaveLength(1);
    expect(sim.switches).toEqual([sim.started[0] + 6_000]);
  });

  it("a new drain signal during the registration wins: its outcome is dropped", async () => {
    const sim = setup([{ resolveAtMs: 2_000, ok: true }]);
    await sim.run(9_600);
    expect(sim.homeReturn.registering).toBe(true);
    sim.failover.notice({ drainingUrl: HOME, peerUrl: PEER, reason: "drain_notice", nowMs: 9_600 });
    await sim.run(12_000);
    expect(sim.switches).toEqual([]);
    expect(sim.failover.state).not.toBe("idle");
  });
});

/*
 * Network run 19 (outage 3b): while the US seed booted, Fly's proxy held each home probe (GET
 * /identity) for its 3 s timeout, and the probe was awaited inside the loop every 2-3 s. The agents
 * serving through the EU seed hardly pulled there: iad, preferred and "ready" for a call, did not
 * pull for 1.4 s and the call was refused (inf-1795713435546-c2551d8d, not_claimed_in_time).
 */
describe("home probe beside the loop (run 19)", () => {
  const HOME = "https://us.example";
  const PEER = "https://eu.example";
  const flush = () => new Promise<void>((r) => setImmediate(r));

  function away(now = 0) {
    const f = new DrainFailover(() => 0.5);
    f.notice({ drainingUrl: HOME, peerUrl: PEER, reason: "drain_notice", nowMs: now });
    f.moved(PEER, now + 500);
    return f;
  }

  it("a probe that hangs does not hold the step; its answer is applied when it comes, one probe at a time", async () => {
    let now = 0;
    const f = away();
    let release: (s: "up" | "down" | "draining") => void = () => undefined;
    let probes = 0;
    const back: number[] = [];
    let wakes = 0;
    const p = new HomeProbe({
      failover: f,
      probe: () => {
        probes++;
        return new Promise((r) => (release = r));
      },
      onBack: (_home, waitMs) => back.push(waitMs),
      wake: () => wakes++,
      now: () => now,
    });
    now = 500 + HOME_PROBE_MS + HOME_PROBE_JITTER_MS;
    expect(p.step()).toBe("started");
    // The loop goes on (pulls the peer) while the probe is out; no second probe meanwhile.
    for (let i = 0; i < 30; i++) {
      now += 100;
      expect(p.step()).toBe("probing");
    }
    expect(probes).toBe(1);
    release("up");
    await flush();
    expect(p.probing).toBe(false);
    expect(f.state).toBe("returning");
    expect(back).toHaveLength(1);
    expect(back[0]).toBeLessThanOrEqual(HOME_RETURN_JITTER_MS);
    expect(wakes).toBe(1);
  });

  it("home still down: probes again after the usual wait", async () => {
    let now = 0;
    const f = away();
    const p = new HomeProbe({ failover: f, probe: async () => "down", onBack: () => undefined, wake: () => undefined, now: () => now });
    now = 500 + HOME_PROBE_MS + HOME_PROBE_JITTER_MS;
    expect(p.step()).toBe("started");
    await flush();
    expect(f.state).toBe("away");
    expect(p.step()).toBe("idle");
    now += HOME_PROBE_MS + HOME_PROBE_JITTER_MS;
    expect(p.step()).toBe("started");
  });

  it("a new drain signal while the probe is out: its answer changes nothing", async () => {
    let now = 0;
    const f = away();
    let release: (s: "up") => void = () => undefined;
    const back: number[] = [];
    const p = new HomeProbe({ failover: f, probe: () => new Promise((r) => (release = r)), onBack: (_h, w) => back.push(w), wake: () => undefined, now: () => now });
    now = 500 + HOME_PROBE_MS + HOME_PROBE_JITTER_MS;
    p.step();
    f.notice({ drainingUrl: PEER, peerUrl: HOME, reason: "drain_notice", nowMs: now });
    release("up");
    await flush();
    expect(back).toEqual([]);
    expect(f.state).toBe("leaving");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DRAIN_AWAY_MAX_MS,
  DRAIN_FAILOVER_JITTER_MS,
  DrainFailover,
  HOME_PROBE_JITTER_MS,
  HOME_PROBE_MS,
  HOME_RETURN_JITTER_MS,
  NO_PEER_RETRY_MS,
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
    expect(src).toContain("encodePendingResult(resultPayload, issuer?.url)");
    expect(src).toMatch(/pullIssuer = coordinator\.requireVerifiedIdentity\(\)[\s\S]{0,500}await post\("\/pull"/);
  });
  it("the generic in-window failover does not run during a planned drain failover (it comes home instead)", () => {
    expect(src).toContain("if (!drainFailover.active() && restartWindow.mayFailOver()) {");
  });
});

import { describe, expect, it } from "vitest";
import {
  CoordinatorReconnectState,
  createCoordinatorReconnectFrame,
  RECONNECT_PENDING_MAX_MS,
  verifyCoordinatorReconnectFrame
} from "../../src/mesh/coordinator-reconnect.js";
import { createPeerKeys } from "../../src/mesh/peer.js";

/*
 * The agent's side of a coordinator restart: only the coordinator it proved (pinned key) can make
 * it reconnect, only with a frame for this agent and still fresh; then it waits the jittered delay,
 * registers again, and only after that reopens its mesh WebSocket.
 */
const coord = createPeerKeys("coord-1");
const other = createPeerKeys("coord-1");
const NOW = 1_800_000_000_000;
const frame = (over: Partial<Parameters<typeof createCoordinatorReconnectFrame>[0]> = {}) =>
  createCoordinatorReconnectFrame({ agentId: "agent-1", coordinatorId: coord.peerId, privateKeyPem: coord.privateKeyPem, delayMs: 2_000, jitterMs: 8_000, nowMs: NOW, ...over });

describe("coordinator reconnect frame", () => {
  it("accepts a fresh frame for this agent from the proved coordinator", () => {
    const v = verifyCoordinatorReconnectFrame(frame(), { agentId: "agent-1", coordinator: coord, nowMs: NOW + 1_000 });
    expect(v).toMatchObject({ ok: true, command: { agentId: "agent-1", coordinatorId: "coord-1", delayMs: 2_000, jitterMs: 8_000, reason: "draining" } });
  });

  it("refuses anything else", () => {
    const ctx = { agentId: "agent-1", coordinator: coord, nowMs: NOW };
    expect(verifyCoordinatorReconnectFrame({ type: "coordinator_reconnect" }, ctx)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyCoordinatorReconnectFrame(frame(), { ...ctx, coordinator: null })).toEqual({ ok: false, reason: "no_verified_coordinator" });
    expect(verifyCoordinatorReconnectFrame(frame({ coordinatorId: "coord-2" }), ctx)).toEqual({ ok: false, reason: "wrong_coordinator" });
    // Same id, another key: not the coordinator the agent proved.
    expect(verifyCoordinatorReconnectFrame(frame({ privateKeyPem: other.privateKeyPem }), ctx)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyCoordinatorReconnectFrame(frame({ agentId: "agent-2" }), ctx)).toEqual({ ok: false, reason: "wrong_agent" });
    expect(verifyCoordinatorReconnectFrame(frame(), { ...ctx, nowMs: NOW + 61_000 })).toEqual({ ok: false, reason: "expired" });
    expect(verifyCoordinatorReconnectFrame(frame({ nowMs: NOW + 120_000 }), ctx)).toEqual({ ok: false, reason: "from_future" });
    // A changed delay breaks the signature.
    const f = frame();
    expect(verifyCoordinatorReconnectFrame({ ...f, command: { ...f.command, delayMs: 0 } }, ctx)).toEqual({ ok: false, reason: "invalid_signature" });
  });
});

describe("agent reconnect state: wait, re-register, then reopen", () => {
  it("holds registration for the jittered delay, keeps the socket closed until registered again", () => {
    const st = new CoordinatorReconnectState(() => 0.5);
    const cmd = (verifyCoordinatorReconnectFrame(frame(), { agentId: "agent-1", coordinator: coord, nowMs: NOW }) as { command: never }).command;
    expect(st.pending(NOW)).toBe(false);
    expect(st.accept(cmd, NOW)).toBe(6_000); // 2 s + half of 8 s
    expect(st.accept(cmd, NOW)).toBeNull(); // the same frame again changes nothing
    expect(st.holdMs(NOW + 1_000)).toBe(5_000);
    expect(st.pending(NOW + 1_000)).toBe(true);
    // A registration before the wait is up (another path) does not open the socket early.
    st.registered(NOW + 3_000);
    expect(st.pending(NOW + 3_000)).toBe(true);
    expect(st.holdMs(NOW + 6_000)).toBe(0);
    st.registered(NOW + 6_500);
    expect(st.pending(NOW + 6_500)).toBe(false);
    expect(st.holdMs(NOW + 6_500)).toBe(0);
  });

  it("never waits forever: the socket may open after the pending bound", () => {
    const st = new CoordinatorReconnectState(() => 0);
    const cmd = (verifyCoordinatorReconnectFrame(frame(), { agentId: "agent-1", coordinator: coord, nowMs: NOW }) as { command: never }).command;
    st.accept(cmd, NOW);
    expect(st.pending(NOW + RECONNECT_PENDING_MAX_MS + 1)).toBe(false);
  });
});

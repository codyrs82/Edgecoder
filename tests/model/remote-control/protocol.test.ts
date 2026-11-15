import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../../src/mesh/peer.js";
import {
  CommandReplayGuard,
  MODEL_CONTROL_MAX_LIFETIME_MS,
  canonicalJson,
  createModelControlFrame,
  modelControlRequestSchema,
  verifyModelControlFrame
} from "../../../src/model/remote-control/protocol.js";
import { signPayload } from "../../../src/mesh/peer.js";
import { modelControlSigningPayload } from "../../../src/model/remote-control/protocol.js";

/*
 * Remote model control frames: the agent acts only on a command its pinned coordinator signed, for
 * this agent, inside the command's lifetime, once.
 */
const coord = createPeerKeys("coord-test");
const other = createPeerKeys("coord-evil");
const pinned = { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem };
const NOW = 1_800_000_000_000;

function frame(overrides: Partial<Parameters<typeof createModelControlFrame>[0]> = {}) {
  return createModelControlFrame({
    request: { action: "pull", args: { model: "qwen3.5:9b" } },
    agentId: "agent-1",
    coordinatorId: coord.peerId,
    requestedBy: "acct-u1",
    privateKeyPem: coord.privateKeyPem,
    nowMs: NOW,
    ...overrides
  });
}
const verify = (f: unknown, opts: { nowMs?: number; replay?: CommandReplayGuard; agentId?: string; coordinator?: typeof pinned | null } = {}) =>
  verifyModelControlFrame(f, { agentId: opts.agentId ?? "agent-1", coordinator: opts.coordinator === undefined ? pinned : opts.coordinator, replay: opts.replay ?? new CommandReplayGuard(), nowMs: opts.nowMs ?? NOW + 1000 });

describe("model control frames", () => {
  it("accepts a fresh command signed by the pinned coordinator for this agent", () => {
    const v = verify(frame());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.request).toEqual({ action: "pull", args: { model: "qwen3.5:9b" } });
  });

  it("refuses a frame signed by another key, even under the pinned coordinator's id", () => {
    expect(verify(frame({ privateKeyPem: other.privateKeyPem }))).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verify(frame({ coordinatorId: other.peerId, privateKeyPem: other.privateKeyPem }))).toEqual({ ok: false, reason: "wrong_coordinator" });
  });

  it("refuses everything when the agent has no verified coordinator", () => {
    expect(verify(frame(), { coordinator: null })).toEqual({ ok: false, reason: "no_verified_coordinator" });
  });

  it("refuses a command for another agent", () => {
    expect(verify(frame(), { agentId: "agent-2" })).toEqual({ ok: false, reason: "wrong_agent" });
  });

  it("refuses tampered arguments and extra fields", () => {
    const f = frame();
    expect(verify({ ...f, command: { ...f.command, args: { model: "evil/model:latest" } } })).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verify({ ...f, command: { ...f.command, requestedBy: "acct-someone-else" } })).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verify({ ...f, command: { ...f.command, extra: 1 } })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ ...f, type: "work_available" })).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses an expired command, one from the future, and one with a long lifetime", () => {
    expect(verify(frame(), { nowMs: NOW + MODEL_CONTROL_MAX_LIFETIME_MS + 1 })).toEqual({ ok: false, reason: "expired" });
    expect(verify(frame(), { nowMs: NOW - 5 * 60_000 })).toEqual({ ok: false, reason: "from_future" });
    // A coordinator-signed command with a day-long lifetime is still refused.
    const f = frame();
    const command = { ...f.command, expiresAtMs: f.command.issuedAtMs + 24 * 3600_000 };
    const signed = { ...f, command, signature: signPayload(modelControlSigningPayload(command), coord.privateKeyPem) };
    expect(verify(signed)).toEqual({ ok: false, reason: "lifetime_too_long" });
  });

  it("acts on a command once (replay), and a forged copy does not burn the real id", () => {
    const replay = new CommandReplayGuard();
    const f = frame();
    const forged = { ...f, signature: frame({ privateKeyPem: other.privateKeyPem, id: f.command.id }).signature };
    expect(verify(forged, { replay }).ok).toBe(false);
    expect(verify(f, { replay }).ok).toBe(true);
    expect(verify(f, { replay })).toEqual({ ok: false, reason: "replayed" });
  });

  it("refuses new commands when the replay cache is full of live ids", () => {
    const replay = new CommandReplayGuard(2);
    expect(verify(frame(), { replay }).ok).toBe(true);
    expect(verify(frame(), { replay }).ok).toBe(true);
    expect(verify(frame(), { replay })).toEqual({ ok: false, reason: "replay_cache_full" });
  });

  it("refuses requests outside the per-action schema", () => {
    const p = (b: unknown) => modelControlRequestSchema.safeParse(b).success;
    expect(p({ action: "pull", args: { model: "qwen3.5:9b" } })).toBe(true);
    expect(p({ action: "pull", args: { model: "registry.evil.com/x:1" } })).toBe(false);
    expect(p({ action: "pull", args: { model: "x; rm -rf /" } })).toBe(false);
    expect(p({ action: "pull", args: { model: "qwen", insecure: true } })).toBe(false);
    expect(p({ action: "set_settings", args: {} })).toBe(false);
    expect(p({ action: "set_settings", args: { keepAlive: "forever" } })).toBe(false);
    expect(p({ action: "set_settings", args: { contextWindow: 8192 } })).toBe(true);
    expect(p({ action: "install_ollama", args: {} })).toBe(false);
  });

  it("signs canonical JSON (key order does not matter)", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });
});

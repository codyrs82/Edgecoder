import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BleRequestGuard, bleRequestProof } from "../../../src/mesh/ble/ble-request-guard.js";

const TOKEN = "mesh-token-1";
let seq = 0;
/** A request signed with `token` at time `at` (fresh request id each call unless given). */
function req(over: { token?: string; requesterId?: string; task?: string; at?: number; requestId?: string } = {}) {
  const r = { requestId: over.requestId ?? `r-${++seq}`, requesterId: over.requesterId ?? "phone-1", task: over.task ?? "write a function" };
  return { ownMeshToken: TOKEN, ...r, ...bleRequestProof(over.token ?? TOKEN, r, over.at ?? 0) };
}

describe("BLE request admission", () => {
  it("refuses all remote BLE work while this agent has no mesh token", () => {
    const guard = new BleRequestGuard({ now: () => 0 });
    expect(guard.admit({ ...req(), ownMeshToken: "" })).toEqual({ ok: false, reason: "mesh_token_required" });
  });

  it("is not satisfied by the publicly advertised token hash", () => {
    const guard = new BleRequestGuard({ now: () => 0 });
    const hash = createHash("sha256").update(TOKEN).digest("hex");
    // No proof at all, or a proof made with the advertised hash instead of the token.
    expect(guard.admit({ ownMeshToken: TOKEN, requestId: "a", requesterId: "x", task: "t" })).toEqual({ ok: false, reason: "mesh_token_mismatch" });
    expect(guard.admit(req({ token: hash }))).toEqual({ ok: false, reason: "mesh_token_mismatch" });
    expect(guard.admit({ ...req(), requesterProof: hash })).toEqual({ ok: false, reason: "mesh_token_mismatch" });
  });

  it("binds the proof to the task and requester", () => {
    const guard = new BleRequestGuard({ now: () => 0 });
    expect(guard.admit({ ...req(), task: "something else" })).toEqual({ ok: false, reason: "mesh_token_mismatch" });
    expect(guard.admit({ ...req(), requesterId: "phone-9" })).toEqual({ ok: false, reason: "mesh_token_mismatch" });
    expect(guard.admit(req())).toEqual({ ok: true });
  });

  it("bounds the prompt size", () => {
    const guard = new BleRequestGuard({ maxTaskBytes: 10, now: () => 0 });
    expect(guard.admit(req({ task: "x".repeat(11) }))).toEqual({ ok: false, reason: "task_too_large" });
    expect(guard.admit(req({ task: "short" }))).toEqual({ ok: true });
  });

  it("rejects stale proofs and a replayed request id", () => {
    let now = 0;
    const guard = new BleRequestGuard({ proofMaxSkewMs: 1000, now: () => now });
    const r = req({ at: 0 });
    expect(guard.admit(r)).toEqual({ ok: true });
    expect(guard.admit(r)).toEqual({ ok: false, reason: "request_replayed" });
    now = 5000;
    expect(guard.admit(req({ at: 0 }))).toEqual({ ok: false, reason: "proof_expired" });
    expect(guard.admit(r)).toEqual({ ok: false, reason: "proof_expired" });
  });

  it("rate-limits per requester and overall, per window", () => {
    let now = 0;
    const guard = new BleRequestGuard({ perRequester: 2, global: 3, windowMs: 1000, now: () => now });
    expect(guard.admit(req()).ok).toBe(true);
    expect(guard.admit(req()).ok).toBe(true);
    expect(guard.admit(req())).toEqual({ ok: false, reason: "rate_limited" });
    expect(guard.admit(req({ requesterId: "phone-2" })).ok).toBe(true);
    expect(guard.admit(req({ requesterId: "phone-3" }))).toEqual({ ok: false, reason: "rate_limited" });
    now = 1001;
    expect(guard.admit(req({ at: 1001 })).ok).toBe(true);
  });
});

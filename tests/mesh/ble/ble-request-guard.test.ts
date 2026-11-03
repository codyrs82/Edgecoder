import { describe, expect, it } from "vitest";
import { BleRequestGuard } from "../../../src/mesh/ble/ble-request-guard.js";

const base = { ownTokenHash: "h1", requesterTokenHash: "h1", requesterId: "phone-1", task: "write a function" };

describe("BLE request admission", () => {
  it("refuses all remote BLE work while this agent has no mesh token", () => {
    const guard = new BleRequestGuard();
    expect(guard.admit({ ...base, ownTokenHash: "", requesterTokenHash: "" })).toEqual({ ok: false, reason: "mesh_token_required" });
    expect(guard.admit({ ...base, ownTokenHash: "", requesterTokenHash: undefined })).toEqual({ ok: false, reason: "mesh_token_required" });
  });

  it("requires the same token hash and bounds the prompt size", () => {
    const guard = new BleRequestGuard({ maxTaskBytes: 10 });
    expect(guard.admit({ ...base, requesterTokenHash: "other" })).toEqual({ ok: false, reason: "mesh_token_mismatch" });
    expect(guard.admit({ ...base, requesterTokenHash: undefined })).toEqual({ ok: false, reason: "mesh_token_mismatch" });
    expect(guard.admit({ ...base, task: "x".repeat(11) })).toEqual({ ok: false, reason: "task_too_large" });
    expect(guard.admit({ ...base, task: "short" })).toEqual({ ok: true });
  });

  it("rate-limits per requester and overall, per window", () => {
    let now = 0;
    const guard = new BleRequestGuard({ perRequester: 2, global: 3, windowMs: 1000, now: () => now });
    expect(guard.admit(base).ok).toBe(true);
    expect(guard.admit(base).ok).toBe(true);
    expect(guard.admit(base)).toEqual({ ok: false, reason: "rate_limited" });
    expect(guard.admit({ ...base, requesterId: "phone-2" }).ok).toBe(true);
    expect(guard.admit({ ...base, requesterId: "phone-3" })).toEqual({ ok: false, reason: "rate_limited" });
    now = 1001;
    expect(guard.admit(base).ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import {
  CODE_CONTROL_MAX_LIFETIME_MS, CommandReplayGuard, codeControlRequestSchema, codeControlSigningPayload, codeRelayMode, codeRequestTargets, createCodeControlFrame, verifyCodeControlFrame,
} from "../../src/common/code-relay.js";

const coord = createPeerKeys("coord-code-1");
const other = createPeerKeys("coord-code-2");
const SESSION = "6f1c3c1e-3b7a-4d38-9a41-1f0e0b6c2d11";
const ctx = (over: Partial<Parameters<typeof verifyCodeControlFrame>[1]> = {}) => ({ agentId: "agent-1", coordinator: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }, replay: new CommandReplayGuard(), ...over });
const frame = (over: Partial<Parameters<typeof createCodeControlFrame>[0]> = {}) =>
  createCodeControlFrame({ request: { action: "cancel", args: { sessionId: SESSION } }, agentId: "agent-1", coordinatorId: coord.peerId, requestedBy: "acct-1", privateKeyPem: coord.privateKeyPem, ...over });
/** A frame our coordinator really signed, with arguments the schema would refuse (as a compromised or buggy coordinator might send). */
const signedRaw = (action: string, args: Record<string, unknown>) => frame({ request: { action, args } as never });

describe("code_control frames", () => {
  it("verify with the pinned coordinator's signature over the code-control payload", () => {
    const f = frame();
    expect(f.type).toBe("code_control");
    expect(codeControlSigningPayload(f.command).startsWith("edgecoder-code-control-v1\n")).toBe(true);
    const v = verifyCodeControlFrame(f, ctx());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.request).toEqual({ action: "cancel", args: { sessionId: SESSION } });
  });

  it("refuse another coordinator, a forged signature, another agent, and no pinned coordinator", () => {
    expect(verifyCodeControlFrame(frame(), ctx({ coordinator: { peerId: other.peerId, publicKeyPem: other.publicKeyPem } }))).toEqual({ ok: false, reason: "wrong_coordinator" });
    // Signed by another key while claiming to be our coordinator.
    expect(verifyCodeControlFrame(frame({ privateKeyPem: other.privateKeyPem }), ctx())).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyCodeControlFrame(frame(), ctx({ agentId: "agent-2" }))).toEqual({ ok: false, reason: "wrong_agent" });
    expect(verifyCodeControlFrame(frame(), ctx({ coordinator: null }))).toEqual({ ok: false, reason: "no_verified_coordinator" });
    const tampered = frame();
    tampered.command.requestedBy = "acct-2";
    expect(verifyCodeControlFrame(tampered, ctx())).toEqual({ ok: false, reason: "invalid_signature" });
    // A bot_control frame is not a code_control frame.
    expect(verifyCodeControlFrame({ ...frame(), type: "bot_control" }, ctx())).toEqual({ ok: false, reason: "malformed" });
  });

  it("expire after two minutes and refuse frames from the future", () => {
    const now = Date.now();
    expect(verifyCodeControlFrame(frame({ nowMs: now - CODE_CONTROL_MAX_LIFETIME_MS - 1000 }), ctx({ nowMs: now }))).toEqual({ ok: false, reason: "expired" });
    expect(verifyCodeControlFrame(frame({ nowMs: now + 5 * 60_000 }), ctx({ nowMs: now }))).toEqual({ ok: false, reason: "from_future" });
    expect(verifyCodeControlFrame(frame({ nowMs: now - 60_000 }), ctx({ nowMs: now })).ok).toBe(true);
  });

  it("run once (replay guard)", () => {
    const f = frame();
    const c = ctx();
    expect(verifyCodeControlFrame(f, c).ok).toBe(true);
    expect(verifyCodeControlFrame(f, c)).toEqual({ ok: false, reason: "replayed" });
  });

  it("refuse a malformed projectId", () => {
    expect(verifyCodeControlFrame(signedRaw("create", { projectId: "0123456789abcdef" }), ctx()).ok).toBe(true);
    for (const bad of ["0123456789ABCDEF", "0123456789abcde", "../../etc/passwd", "/Users/me/app", "0123456789abcdef0"]) {
      expect(verifyCodeControlFrame(signedRaw("create", { projectId: bad }), ctx()), bad).toEqual({ ok: false, reason: "invalid_request" });
      expect(codeControlRequestSchema.safeParse({ action: "create", args: { projectId: bad } }).success).toBe(false);
    }
  });

  it("refuse path-looking and other unknown fields on every action", () => {
    for (const extra of [{ path: "/etc" }, { projectRoot: "/Users/me" }, { cwd: "/" }, { folder: "~/code" }, { requestedBy: "acct-2" }]) {
      const label = JSON.stringify(extra);
      expect(codeControlRequestSchema.safeParse({ action: "create", args: { projectId: "0123456789abcdef", ...extra } }).success, label).toBe(false);
      expect(codeControlRequestSchema.safeParse({ action: "message", args: { sessionId: SESSION, text: "hi", ...extra } }).success, label).toBe(false);
      expect(codeControlRequestSchema.safeParse({ action: "projects", args: extra }).success, label).toBe(false);
      expect(verifyCodeControlFrame(signedRaw("cancel", { sessionId: SESSION, ...extra }), ctx()), label).toEqual({ ok: false, reason: "invalid_request" });
    }
    expect(codeControlRequestSchema.safeParse({ action: "snapshot", args: { sessionId: "../x" } }).success).toBe(false);
    expect(codeControlRequestSchema.safeParse({ action: "rm", args: {} }).success).toBe(false);
  });

  it("audit targets carry ids only, never the text", () => {
    const r = codeControlRequestSchema.parse({ action: "message", args: { sessionId: SESSION, text: "secret plan" } });
    expect(codeRequestTargets(r)).toEqual({ sessionId: SESSION });
    expect(codeRequestTargets(codeControlRequestSchema.parse({ action: "create", args: { projectId: "0123456789abcdef" } }))).toEqual({ projectId: "0123456789abcdef" });
  });

  it("host modes: off by default; on is capped at view by AGENT_REMOTE_CONTROL=off", () => {
    expect(codeRelayMode(undefined, true)).toBe("off");
    expect(codeRelayMode("", true)).toBe("off");
    expect(codeRelayMode("off", true)).toBe("off");
    expect(codeRelayMode("view", true)).toBe("view");
    expect(codeRelayMode("on", true)).toBe("on");
    expect(codeRelayMode("ON", false)).toBe("view");
  });
});

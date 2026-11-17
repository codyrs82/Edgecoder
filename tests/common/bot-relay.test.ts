import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { BOT_CONTROL_MAX_LIFETIME_MS, CommandReplayGuard, botControlRequestSchema, botRelayMode, createBotControlFrame, remoteBotCreateSchema, webBotId, fitSnapshot, toolCallDetail, verifyBotControlFrame, type BotsSnapshot } from "../../src/common/bot-relay.js";

const coord = createPeerKeys("coord-1");
const ctx = (over: Partial<Parameters<typeof verifyBotControlFrame>[1]> = {}) => ({ agentId: "agent-1", coordinator: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }, replay: new CommandReplayGuard(), ...over });
const frame = (over: Partial<Parameters<typeof createBotControlFrame>[0]> = {}) =>
  createBotControlFrame({ request: { action: "pause", args: {} }, botId: "bot_1", agentId: "agent-1", coordinatorId: coord.peerId, requestedBy: "acct-1", privateKeyPem: coord.privateKeyPem, ...over });

describe("bot_control frames", () => {
  it("verify only for the pinned coordinator, this agent, within the lifetime, once", () => {
    const f = frame();
    const c = ctx();
    expect(verifyBotControlFrame(f, c).ok).toBe(true);
    expect(verifyBotControlFrame(f, c)).toEqual({ ok: false, reason: "replayed" });
    expect(verifyBotControlFrame(frame(), ctx({ agentId: "agent-2" }))).toEqual({ ok: false, reason: "wrong_agent" });
    expect(verifyBotControlFrame(frame(), ctx({ coordinator: null }))).toEqual({ ok: false, reason: "no_verified_coordinator" });
    expect(verifyBotControlFrame(frame({ nowMs: Date.now() - BOT_CONTROL_MAX_LIFETIME_MS - 1000 }), ctx())).toEqual({ ok: false, reason: "expired" });
    const tampered = frame();
    tampered.command.botId = "bot_2";
    expect(verifyBotControlFrame(tampered, ctx())).toEqual({ ok: false, reason: "invalid_signature" });
    const extra = frame();
    (extra.command as any).args = { projectRoot: "/" };
    expect(verifyBotControlFrame(extra, ctx()).ok).toBe(false);
  });

  it("host modes", () => {
    expect(botRelayMode(undefined, true)).toBe("on");
    expect(botRelayMode("view", true)).toBe("view");
    expect(botRelayMode(undefined, false)).toBe("view");
    expect(botRelayMode("off", true)).toBe("off");
  });

  it("tool details never carry file contents", () => {
    expect(toolCallDetail("write_file", { path: "a.ts", content: "secret" })).toBe("a.ts");
    expect(toolCallDetail("run_shell", { command: "npm   test" })).toBe("npm test");
  });

  it("a big snapshot is shrunk to fit", () => {
    const bots = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, tail: Array.from({ length: 12 }, (_, j) => ({ id: `m${j}`, role: "assistant", content: "x".repeat(4000), atMs: j })) }));
    const s = fitSnapshot({ v: 1, machineName: "m", controls: "on", generatedAtMs: 1, bots } as unknown as BotsSnapshot, 100_000);
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(100_000);
    expect(s.bots.length).toBe(30);
  });
});

describe("create frames (#409)", () => {
  const req = (extra: Record<string, unknown> = {}) => botControlRequestSchema.parse({ action: "create", args: { requestId: "req-12345678", name: "Harry", ...extra } });
  it("verify only when the bot id is the one fixed by the account and request id", () => {
    expect(verifyBotControlFrame(frame({ request: req(), botId: webBotId("acct-1", "req-12345678") }), ctx()).ok).toBe(true);
    expect(verifyBotControlFrame(frame({ request: req(), botId: "bot_wdeadbeef0000" }), ctx())).toEqual({ ok: false, reason: "invalid_request" });
    // Another account's request id gives another id.
    expect(webBotId("acct-2", "req-12345678")).not.toBe(webBotId("acct-1", "req-12345678"));
    expect(webBotId("acct-1", "req-12345678")).toMatch(/^bot_w[0-9a-f]{12}$/);
  });
  it("the create schema: no folder or tools fields, no frontier models, Accept edits by default", () => {
    expect(remoteBotCreateSchema.parse({ requestId: "req-12345678", name: "H" }).mode).toBe("auto-edits");
    for (const bad of [{ projectRoot: "/" }, { allowedTools: ["run_shell"] }, { autoApproveEdits: true }, { compute: { policy: "model", model: "Frontier/openai/gpt" } }]) {
      expect(remoteBotCreateSchema.safeParse({ requestId: "req-12345678", name: "H", ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

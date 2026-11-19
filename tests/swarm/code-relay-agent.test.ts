import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { createCodeControlFrame, type CodeControlRequest, type CodeControlResult, type CodeRelayMode, type CodeSnapshot } from "../../src/common/code-relay.js";
import { AGENT_CODE_CHANGES_PER_WINDOW, AGENT_CODE_CREATES_PER_HOUR, AGENT_CODE_READS_PER_WINDOW, CODE_HEARTBEAT_MS, CodeRelayAgent, type CodeProviderClient } from "../../src/swarm/code-relay-agent.js";

const coord = createPeerKeys("coord-code-agent");
const pinned = { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem };
const SESSION = "6f1c3c1e-3b7a-4d38-9a41-1f0e0b6c2d11";
const PROJECT = { projectId: "0123456789abcdef", name: "app", parent: "code", branch: "main" };

function setup(mode: CodeRelayMode, over: { provider?: Partial<CodeProviderClient>; account?: string | null } = {}) {
  let now = 1_000_000;
  const reports: Array<{ snapshot?: CodeSnapshot; result?: CodeControlResult }> = [];
  const calls: Array<Record<string, unknown>> = [];
  const snapshots: string[] = [];
  let sessions: unknown[] = [];
  const provider: CodeProviderClient = {
    snapshot: async (account) => {
      snapshots.push(account);
      return { v: 1, generatedAtMs: now, projects: [PROJECT], sessions: sessions as never };
    },
    command: async (body) => {
      calls.push(body);
      return { status: "done", data: { ok: true } };
    },
    ...over.provider
  };
  const agent = new CodeRelayAgent({
    agentId: "agent-1",
    mode,
    machineName: "MAW-MB-02",
    account: () => (over.account === undefined ? "acct-owner" : over.account),
    provider,
    report: async (b) => void reports.push(b),
    now: () => now
  });
  const send = (request: CodeControlRequest, requestedBy = "acct-owner") =>
    agent.handleFrame(createCodeControlFrame({ request, agentId: "agent-1", coordinatorId: coord.peerId, requestedBy, privateKeyPem: coord.privateKeyPem, nowMs: now }), pinned);
  return {
    agent, reports, calls, snapshots, send,
    tick: (ms: number) => (now += ms),
    setSessions: (s: unknown[]) => (sessions = s)
  };
}

describe("relay modes", () => {
  it("off: publishes nothing and takes no command", async () => {
    const t = setup("off");
    await t.agent.publish(true);
    expect(t.snapshots).toEqual([]);
    const r = await t.send({ action: "cancel", args: { sessionId: SESSION } });
    expect(r).toMatchObject({ status: "refused", error: "relay_off" });
    expect(t.calls).toEqual([]);
  });

  it("view: publishes snapshots, refuses every command (reads too)", async () => {
    const t = setup("view");
    await t.agent.publish(true);
    expect(t.reports[0].snapshot).toMatchObject({ v: 1, controls: "view", account: "acct-owner", machineName: "MAW-MB-02", projects: [PROJECT] });
    expect(await t.send({ action: "message", args: { sessionId: SESSION, text: "hi" } })).toMatchObject({ status: "refused", error: "view_only" });
    expect(await t.send({ action: "projects", args: {} })).toMatchObject({ status: "refused", error: "view_only" });
    expect(t.calls).toEqual([]);
    // The refusal goes back to the coordinator (signed report).
    expect(t.reports.filter((r) => r.result).map((r) => r.result!.error)).toEqual(["view_only", "view_only"]);
  });

  it("on: hands the command to the provider flat, with requestedBy = the frame's account", async () => {
    const t = setup("on");
    const r = await t.send({ action: "message", args: { sessionId: SESSION, text: "fix the test" } }, "acct-owner");
    expect(r).toMatchObject({ status: "done", data: { ok: true } });
    expect(t.calls).toEqual([{ sessionId: SESSION, text: "fix the test", requestedBy: "acct-owner", action: "message" }]);
  });

  it("a frame that doesn't verify is ignored and nothing is reported", async () => {
    const t = setup("on");
    const f = createCodeControlFrame({ request: { action: "projects", args: {} }, agentId: "agent-2", coordinatorId: coord.peerId, requestedBy: "acct-owner", privateKeyPem: coord.privateKeyPem });
    expect(await t.agent.handleFrame(f, pinned)).toEqual({ status: "ignored", error: "wrong_agent" });
    expect(await t.agent.handleFrame({ ...f, command: { ...f.command, agentId: "agent-1" } }, pinned)).toEqual({ status: "ignored", error: "invalid_signature" });
    expect(t.reports).toEqual([]);
    expect(t.calls).toEqual([]);
  });
});

describe("publishing", () => {
  it("sends on change and on the heartbeat only", async () => {
    const t = setup("on");
    await t.agent.publish();
    await t.agent.publish();
    expect(t.reports.length).toBe(1);
    t.setSessions([{ id: SESSION, title: "Fix", projectId: PROJECT.projectId, projectName: "app" }]);
    await t.agent.publish();
    expect(t.reports.length).toBe(2);
    t.tick(CODE_HEARTBEAT_MS + 1);
    await t.agent.publish();
    expect(t.reports.length).toBe(3);
  });

  it("no owner account yet: nothing is read or sent", async () => {
    const t = setup("on", { account: null });
    await t.agent.publish(true);
    expect(t.snapshots).toEqual([]);
    expect(t.reports).toEqual([]);
  });
});

describe("local rate limits", () => {
  it("changes, reads and new sessions each have their own limit", async () => {
    const t = setup("on");
    for (let i = 0; i < AGENT_CODE_CHANGES_PER_WINDOW; i++) expect((await t.send({ action: "cancel", args: { sessionId: SESSION } })).status).toBe("done");
    expect(await t.send({ action: "cancel", args: { sessionId: SESSION } })).toMatchObject({ status: "refused", error: "agent_rate_limited" });
    // Reads are counted apart.
    expect((await t.send({ action: "sessions", args: {} })).status).toBe("done");
    t.tick(10 * 60_000 + 1);
    expect((await t.send({ action: "cancel", args: { sessionId: SESSION } })).status).toBe("done");
  });

  it("reads per window", async () => {
    const t = setup("on");
    for (let i = 0; i < AGENT_CODE_READS_PER_WINDOW; i++) await t.send({ action: "projects", args: {} });
    expect(await t.send({ action: "projects", args: {} })).toMatchObject({ status: "refused", error: "agent_rate_limited" });
  });

  it("new sessions per hour", async () => {
    const t = setup("on");
    for (let i = 0; i < AGENT_CODE_CREATES_PER_HOUR; i++) expect((await t.send({ action: "create", args: { projectId: PROJECT.projectId } })).status).toBe("done");
    expect(await t.send({ action: "create", args: { projectId: PROJECT.projectId } })).toMatchObject({ status: "refused", error: "agent_rate_limited" });
    // Still limited after the 10-minute window; free again after an hour.
    t.tick(30 * 60_000);
    expect(await t.send({ action: "create", args: { projectId: PROJECT.projectId } })).toMatchObject({ error: "agent_rate_limited" });
    t.tick(31 * 60_000);
    expect((await t.send({ action: "create", args: { projectId: PROJECT.projectId } })).status).toBe("done");
  });
});

describe("provider unreachable", () => {
  it("a command fails with provider_unreachable and is reported", async () => {
    const t = setup("on", { provider: { command: async () => { throw new Error("ECONNREFUSED 127.0.0.1:4304"); } } });
    const r = await t.send({ action: "cancel", args: { sessionId: SESSION } });
    expect(r).toMatchObject({ status: "failed", error: "provider_unreachable" });
    expect(t.reports.at(-1)?.result).toMatchObject({ status: "failed", error: "provider_unreachable" });
  });

  it("a snapshot read that fails or is refused publishes nothing", async () => {
    const down = setup("on", { provider: { snapshot: async () => { throw new Error("ECONNREFUSED"); } } });
    await down.agent.publish(true);
    expect(down.reports).toEqual([]);
    const other = setup("on", { provider: { snapshot: async () => null } });
    await other.agent.publish(true);
    expect(other.reports).toEqual([]);
  });

  it("only known result fields go back, and an oversized result is replaced", async () => {
    const t = setup("on", { provider: { command: async () => ({ status: "done", data: "x".repeat(300 * 1024), extra: 1 } as never) } });
    expect(await t.send({ action: "projects", args: {} })).toEqual({ commandId: expect.any(String), status: "failed", error: "result_too_large" });
  });
});

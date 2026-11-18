import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { CommandReplayGuard } from "../../src/model/remote-control/protocol.js";
import { AGENT_LOCAL_WEB_PER_WINDOW, cleanLocalPage, createLocalWebFrame, LocalWebAgent, localWebEnabled, verifyLocalWebFrame, type LocalWebResult } from "../../src/web-tool/local-web.js";
import { acceptLocalWebResult, LocalWebRelay, noteLocalWebReport, resetLocalWebForTests, type LocalWebDeps } from "../../src/swarm/coordinator/local-web.js";
import { PAGE_TEXT_MAX_CHARS } from "../../src/web-tool/extract.js";

/* Local web on the owner's machine: the signed frame, the agent's side, and the coordinator's relay. */

const coord = createPeerKeys("coordinator-local-web");
const other = createPeerKeys("someone-else");
const pinned = { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem };
const NOW = 1_800_000_000_000;
const search = { action: "search" as const, args: { query: "weather berlin", count: 5 } };

function frame(over: { agentId?: string; keys?: typeof coord; nowMs?: number; request?: Parameters<typeof createLocalWebFrame>[0]["request"] } = {}) {
  return createLocalWebFrame({ request: over.request ?? search, agentId: over.agentId ?? "agent-1", coordinatorId: coord.peerId, requestedBy: "acct-u1", privateKeyPem: (over.keys ?? coord).privateKeyPem, nowMs: over.nowMs ?? NOW });
}

describe("local_web frames", () => {
  it("verify only from the pinned coordinator, for this agent, in time, once", () => {
    const replay = new CommandReplayGuard();
    const ctx = { agentId: "agent-1", coordinator: pinned, replay, nowMs: NOW + 1000 };
    const f = frame();
    expect(verifyLocalWebFrame(f, ctx).ok).toBe(true);
    expect(verifyLocalWebFrame(f, ctx)).toEqual({ ok: false, reason: "replayed" });
    expect(verifyLocalWebFrame(frame({ keys: other }), ctx)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyLocalWebFrame(frame({ agentId: "agent-2" }), ctx)).toEqual({ ok: false, reason: "wrong_agent" });
    expect(verifyLocalWebFrame(frame(), { ...ctx, nowMs: NOW + 31_000 })).toEqual({ ok: false, reason: "expired" });
    expect(verifyLocalWebFrame(frame(), { ...ctx, coordinator: null })).toEqual({ ok: false, reason: "no_verified_coordinator" });
    const tampered = frame();
    tampered.command.args = { query: "something else", count: 5 };
    expect(verifyLocalWebFrame(tampered, ctx)).toEqual({ ok: false, reason: "invalid_signature" });
    const bad = createLocalWebFrame({ request: { action: "search", args: { query: "q", count: 99 } } as never, agentId: "agent-1", coordinatorId: coord.peerId, requestedBy: "acct-u1", privateKeyPem: coord.privateKeyPem, nowMs: NOW });
    expect(verifyLocalWebFrame(bad, ctx)).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("AGENT_LOCAL_WEB is on unless set off", () => {
    expect(localWebEnabled(undefined)).toBe(true);
    expect(localWebEnabled("on")).toBe(true);
    expect(localWebEnabled("off")).toBe(false);
    expect(localWebEnabled("0")).toBe(false);
  });
});

function agent(over: Partial<ConstructorParameters<typeof LocalWebAgent>[0]> = {}) {
  const reports: LocalWebResult[] = [];
  const a = new LocalWebAgent({
    agentId: "agent-1",
    searxngUrl: "http://127.0.0.1:18888",
    enabled: true,
    search: async () => [{ title: "<i>T</i>", url: "https://t.example/", snippet: "s" }, { title: "x", url: "ftp://nope/", snippet: "" }],
    read: async (url) => ({ url, title: "P", text: "page", truncated: false, contentType: "text/html" }),
    healthy: async () => true,
    report: async (r) => {
      reports.push(r);
    },
    now: () => NOW,
    ...over,
  });
  return { a, reports };
}

describe("the agent's side", () => {
  it("searches its SearXNG and reports cleaned results", async () => {
    const { a, reports } = agent();
    const r = await a.handleFrame(frame(), pinned);
    expect(r).toMatchObject({ status: "done", results: [{ title: "T", url: "https://t.example/", snippet: "s" }] });
    expect(reports).toHaveLength(1);
  });

  it("reads a page with the SSRF-checked reader", async () => {
    const read = vi.fn(async (url: string) => ({ url, title: "P", text: "page", truncated: false, contentType: "text/html" }));
    const { a } = agent({ read });
    const r = await a.handleFrame(frame({ request: { action: "read", args: { url: "https://example.com/" } } }), pinned);
    expect(r).toMatchObject({ status: "done", page: { url: "https://example.com/", text: "page" } });
    expect(read).toHaveBeenCalledWith("https://example.com/");
  });

  it("a blocked read reports the reader's code (and the coordinator falls back)", async () => {
    const { a } = agent({ read: async () => { throw Object.assign(new Error("private"), { code: "blocked_url" }); } });
    expect(await a.handleFrame(frame({ request: { action: "read", args: { url: "http://192.168.1.1/" } } }), pinned)).toMatchObject({ status: "failed", error: "blocked_url" });
  });

  it("without SearXNG it refuses searches; with AGENT_LOCAL_WEB=off it refuses everything and reports nothing in the heartbeat", async () => {
    expect(await agent({ searxngUrl: null }).a.handleFrame(frame(), pinned)).toMatchObject({ status: "refused", error: "no_local_search" });
    const off = agent({ enabled: false });
    expect(await off.a.handleFrame(frame(), pinned)).toMatchObject({ status: "refused", error: "local_web_off" });
    expect(await off.a.capability()).toBeUndefined();
  });

  it("an unverified frame is ignored and nothing is reported", async () => {
    const { a, reports } = agent();
    expect(await a.handleFrame(frame({ keys: other }), pinned)).toEqual({ status: "ignored", error: "invalid_signature" });
    expect(reports).toHaveLength(0);
  });

  it("caps its own calls per window", async () => {
    const { a } = agent();
    for (let i = 0; i < AGENT_LOCAL_WEB_PER_WINDOW; i++) await a.handleFrame(frame({ nowMs: NOW }), pinned);
    expect(await a.handleFrame(frame(), pinned)).toMatchObject({ status: "refused", error: "agent_rate_limited" });
  });

  it("reports search: true only while SearXNG is healthy", async () => {
    let up = true;
    let t = NOW;
    const { a } = agent({ healthy: async () => up, now: () => t });
    expect(await a.capability()).toEqual({ search: true, read: true });
    up = false;
    t += 61_000;
    expect(await a.capability()).toEqual({ search: false, read: true });
    expect(await agent({ searxngUrl: null }).a.capability()).toEqual({ search: false, read: true });
  });

  it("a failed search marks it down until the next check", async () => {
    const { a } = agent({ search: async () => { throw new Error("502"); }, healthy: async () => false });
    await a.capability();
    expect(await a.handleFrame(frame(), pinned)).toMatchObject({ status: "failed", error: "search_failed" });
    expect((await a.capability())?.search).toBe(false);
  });
});

describe("cleanLocalPage", () => {
  it("caps text and title, keeps http(s) only", () => {
    const p = cleanLocalPage({ url: "https://e.example/", title: " a\n b ", text: "x".repeat(PAGE_TEXT_MAX_CHARS + 10), truncated: false, contentType: "text/html; charset=utf-8" });
    expect(p).toMatchObject({ title: "a b", truncated: true, contentType: "text/html; charset=utf-8" });
    expect(p!.text).toHaveLength(PAGE_TEXT_MAX_CHARS);
    expect(cleanLocalPage({ url: "file:///etc/passwd", title: "", text: "", truncated: false, contentType: "" })).toBeNull();
  });
});

describe("the coordinator's relay", () => {
  afterEach(() => resetLocalWebForTests());

  function relay(owners: Record<string, string | null>, over: Partial<LocalWebDeps> = {}) {
    const sent: Array<{ agentId: string; frame: ReturnType<typeof frame> }> = [];
    const deps: LocalWebDeps = {
      accountsFor: async (ids) => new Map(ids.map((id) => [id, owners[id] ?? null])),
      connected: () => true,
      send: (agentId, f) => {
        sent.push({ agentId, frame: JSON.parse(f) });
        return true;
      },
      lastSeenMs: () => NOW,
      coordinatorId: () => coord.peerId,
      privateKeyPem: () => coord.privateKeyPem,
      ...over,
    };
    return { r: new LocalWebRelay(deps), sent };
  }

  it("uses only machines the account owns that reported local search (a host's claim for another account is ignored)", async () => {
    noteLocalWebReport("mine", { search: true, read: true });
    noteLocalWebReport("theirs", { search: true, read: true });
    noteLocalWebReport("unlinked", { search: true, read: true });
    const { r } = relay({ mine: "acct-u1", theirs: "acct-u2", unlinked: null });
    expect(await r.candidates("acct-u1", "search")).toEqual(["mine"]);
    expect(await r.candidates("acct-u3", "search")).toEqual([]);
  });

  it("prefers the calling agent, and skips machines without an authenticated socket", async () => {
    noteLocalWebReport("a", { search: true, read: true });
    noteLocalWebReport("b", { search: true, read: true });
    noteLocalWebReport("c", { search: true, read: true });
    const { r } = relay({ a: "acct-u1", b: "acct-u1", c: "acct-u1" }, { connected: (id) => id !== "c" });
    expect(await r.candidates("acct-u1", "search", "b")).toEqual(["b", "a"]);
  });

  it("a report without search, or none, takes the machine out", async () => {
    noteLocalWebReport("a", { search: true, read: true });
    noteLocalWebReport("a", { search: false, read: true });
    const { r } = relay({ a: "acct-u1" });
    expect(await r.available("acct-u1")).toEqual({ search: false, read: true });
    noteLocalWebReport("a", undefined);
    expect(await r.available("acct-u1")).toEqual({ search: false, read: false });
  });

  it("sends a signed frame and takes the answer from that agent only, cleaned", async () => {
    noteLocalWebReport("mine", { search: true, read: true });
    const { r, sent } = relay({ mine: "acct-u1" });
    const pending = r.search("acct-u1", "q", 3);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { frame: f } = sent[0];
    expect(verifyLocalWebFrame(f, { agentId: "mine", coordinator: pinned, replay: new CommandReplayGuard(), nowMs: f.command.issuedAtMs }).ok).toBe(true);
    expect(f.command.requestedBy).toBe("acct-u1");
    // Another agent can't answer for it.
    expect(acceptLocalWebResult("intruder", { commandId: f.command.id, status: "done", results: [] })).toEqual({ ok: false, error: "unknown_command" });
    expect(acceptLocalWebResult("mine", { commandId: f.command.id, status: "done", results: [{ title: "<b>A</b>", url: "https://a.example/", snippet: "" }, { title: "B", url: "javascript:x", snippet: "" }] })).toEqual({ ok: true });
    expect(await pending).toEqual([{ title: "A", url: "https://a.example/", snippet: "" }]);
    // Once only.
    expect(acceptLocalWebResult("mine", { commandId: f.command.id, status: "done", results: [] }).ok).toBe(false);
  });

  it("no answer in time, a failure or nothing found is null (the caller falls back)", async () => {
    vi.useFakeTimers();
    try {
      noteLocalWebReport("mine", { search: true, read: true }, Date.now());
      const { r, sent } = relay({ mine: "acct-u1" });
      const late = r.search("acct-u1", "q", 3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await late).toBeNull();
      const failed = r.search("acct-u1", "q", 3);
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      acceptLocalWebResult("mine", { commandId: sent[1].frame.command.id, status: "failed", error: "search_failed" });
      expect(await failed).toBeNull();
      const empty = r.search("acct-u1", "q", 3);
      await vi.waitFor(() => expect(sent).toHaveLength(3));
      acceptLocalWebResult("mine", { commandId: sent[2].frame.command.id, status: "done", results: [] });
      expect(await empty).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an undeliverable frame is null at once", async () => {
    noteLocalWebReport("mine", { search: true, read: true });
    const { r } = relay({ mine: "acct-u1" }, { send: () => false });
    expect(await r.search("acct-u1", "q", 3)).toBeNull();
  });
});

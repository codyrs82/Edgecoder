import { describe, expect, it, vi } from "vitest";
import { backfillCodeChats, CodeChatMirror, mergeEntries, syncMessages } from "../src/lib/code-chat-mirror";
import type { SessionEvent, SessionSnapshotView } from "../src/lib/api";
import type { Conversation } from "../src/lib/types";

const convo = (): Conversation => ({
  id: "c1",
  title: "what open PRs do we have?",
  createdAt: 0,
  updatedAt: 0,
  source: "editor",
  projectRoot: "/p/site",
  messages: [
    { id: "m1", role: "user", content: "what open PRs do we have?", timestamp: 1 },
    { id: "m2", role: "assistant", content: "Two.", timestamp: 2, turnId: "t1", changedFiles: ["a.ts"] },
    { id: "m3", role: "system", content: "note", timestamp: 3 },
  ],
});

const snap = (transcript: SessionSnapshotView["session"]["transcript"], running: SessionSnapshotView["running"] = null): SessionSnapshotView => ({
  session: { id: "s1", title: "t", projectRoot: "/p/site", branch: null, model: "auto", compute: { target: "auto" }, published: false, cSats: 0, transcript },
  seq: 3,
  controller: null,
  clients: [],
  running,
  pending: [],
});

describe("what a sync sends", () => {
  it("the chat's user and assistant messages not synced yet, with turn ids", () => {
    expect(syncMessages(convo())).toEqual([
      { id: "m1", role: "user", content: "what open PRs do we have?", at: 1 },
      { id: "m2", role: "assistant", content: "Two.", at: 2, turnId: "t1", changedFiles: ["a.ts"] },
    ]);
    expect(syncMessages(convo(), new Set(["m1", "m2"]))).toEqual([]);
  });
});

describe("merging the mirror into the chat", () => {
  it("adds the phone's messages once, never the app's own or a reply to a turn it shows", () => {
    const c = convo();
    const added = mergeEntries(c, [
      { id: "m1", role: "user", content: "what open PRs do we have?", at: 1, by: "desktop" },
      { id: "x2", role: "assistant", content: "Two.", at: 2, turnId: "t1", by: "desktop" },
      { id: "x3", role: "assistant", content: "dup of m2", at: 2, turnId: "t1" },
      { id: "p1", role: "user", content: "run the tests", at: 4, by: "remote" },
      { id: "n1", role: "note", content: "Started from iPhone", at: 4 },
      { id: "p2", role: "assistant", content: "Pass.", at: 5, turnId: "t2", events: [{ type: "tool_call", id: "c1", tool: "run_shell", args: { command: "npm test" }, requires_approval: true }, { type: "tool_result", id: "c1", result: "ok" }] },
    ]);
    expect(added).toBe(2);
    expect(c.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "p1", "p2"]);
    expect(c.messages.at(-1)).toMatchObject({ turnId: "t2", toolEvents: [{ tool: "run_shell", approval_status: "approved", result: "ok" }] });
    expect(mergeEntries(c, [{ id: "p1", role: "user", content: "run the tests", at: 4, by: "remote" }])).toBe(0);
  });
});

describe("CodeChatMirror", () => {
  function setup(snapshot: SessionSnapshotView, own = false) {
    let emit: (e: SessionEvent) => void = () => {};
    const deps = {
      sync: vi.fn(async () => ({ sessionId: "s1" })),
      snapshot: vi.fn(async () => snapshot),
      follow: vi.fn(async (_id: string, _since: number, onEvent: (e: SessionEvent) => void) => {
        emit = onEvent;
      }),
    };
    const on = { ownTurn: vi.fn(() => own), onEntries: vi.fn(), onRemoteTurn: vi.fn() };
    return { mirror: new CodeChatMirror(deps, on), deps, on, emit: (e: Omit<SessionEvent, "seq">) => emit({ seq: 9, ...e } as SessionEvent) };
  }

  it("syncs once, then only new messages or a changed mode; follows from the snapshot", async () => {
    const { mirror, deps } = setup(snap([]));
    const c = convo();
    expect(await mirror.sync(c, { mode: "auto-edits" })).toBe("s1");
    expect(deps.follow).toHaveBeenCalledWith("s1", 3, expect.any(Function), expect.any(AbortSignal));
    await mirror.sync(c, { mode: "auto-edits" });
    expect(deps.sync).toHaveBeenCalledTimes(1);
    c.messages.push({ id: "m4", role: "user", content: "more", timestamp: 4 });
    await mirror.sync(c);
    expect(deps.sync).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [expect.objectContaining({ id: "m4" })] }));
    await mirror.sync(c, { mode: "plan" });
    expect(deps.sync).toHaveBeenCalledTimes(3);
  });

  it("shows the phone's running turn and clears it at its end; ignores this app's own turn", async () => {
    const { mirror, on, emit } = setup(snap([], { turnId: "t2", text: "Running", events: [{ type: "text", content: "Running" }] }));
    await mirror.sync(convo());
    expect(on.onRemoteTurn).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Running" }), "t2");
    expect(mirror.remoteTurnId).toBe("t2");
    emit({ type: "agent", turnId: "t2", event: { type: "text", content: " tests" } });
    expect(on.onRemoteTurn).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Running tests" }), "t2");
    emit({ type: "turn_end", entry: { id: "p2", role: "assistant", content: "Done", at: 5, turnId: "t2" } });
    expect(on.onEntries).toHaveBeenLastCalledWith([expect.objectContaining({ id: "p2" })]);
    expect(on.onRemoteTurn).toHaveBeenLastCalledWith(null, null);
    expect(mirror.remoteTurnId).toBeNull();

    const own = setup(snap([]), true);
    await own.mirror.sync(convo());
    own.emit({ type: "agent", turnId: "t3", event: { type: "text", content: "mine" } });
    own.emit({ type: "turn_end", entry: { id: "x", role: "assistant", content: "mine", at: 5, turnId: "t3", by: "desktop" } });
    expect(own.on.onRemoteTurn).not.toHaveBeenCalled();
    expect(own.on.onEntries).toHaveBeenCalledTimes(1); // the snapshot only
  });

  it("an older provider without the mirror leaves the chat alone", async () => {
    const { mirror, deps, on } = setup(snap([]));
    deps.sync.mockRejectedValueOnce(new Error("404"));
    expect(await mirror.sync(convo())).toBeNull();
    expect(on.onEntries).not.toHaveBeenCalled();
    expect(mirror.sessionId).toBeNull();
  });
});

describe("backfill", () => {
  it("syncs each recent Code chat once per change, skipping plain chats and chats without a project", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const sync = vi.fn(async () => ({ sessionId: "s" }));
    const code = convo();
    const plain: Conversation = { ...convo(), id: "c2", source: "chat" };
    const noProject: Conversation = { ...convo(), id: "c3", projectRoot: undefined };
    expect(await backfillCodeChats([code, plain, noProject], sync, storage)).toBe(1);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ chatId: "c1", projectRoot: "/p/site", messages: expect.arrayContaining([expect.objectContaining({ id: "m1" })]) }));
    expect(await backfillCodeChats([code], sync, storage)).toBe(0);
    code.updatedAt = 9;
    sync.mockRejectedValueOnce(new Error("down"));
    expect(await backfillCodeChats([code], sync, storage)).toBe(0);
    expect(await backfillCodeChats([code], sync, storage)).toBe(1);
  });
});

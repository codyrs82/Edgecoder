import { describe, expect, it } from "vitest";
import { applySessionEvent, canWrite, viewFromSnapshot } from "../src/lib/live-session";
import type { SessionSnapshotView } from "../src/lib/api";

const TERM = { clientId: "term-1", kind: "terminal" as const, label: "Terminal on mbp" };
const DESK = { clientId: "desk-1", kind: "desktop" as const, label: "EdgeCoder app" };

const snap = (over: Partial<SessionSnapshotView> = {}): SessionSnapshotView => ({
  session: {
    id: "s1", title: "Add a footer", projectRoot: "/p/site", branch: "main", model: "network/qwen3-coder:30b", compute: { target: "network" }, published: true, cSats: 0.5,
    transcript: [
      { id: "u1", role: "user", content: "Add a footer", at: 1, by: "terminal" },
      {
        id: "a1", role: "assistant", content: "Done.", at: 2, turnId: "t1", changedFiles: ["index.html"],
        events: [
          { type: "turn", id: "t1" },
          { type: "tool_call", id: "c1", tool: "edit_file", args: { path: "index.html" }, requires_approval: true },
          { type: "tool_result", id: "c1", result: "ok" },
          { type: "text", content: "Done." },
        ],
      },
    ],
  },
  seq: 10, controller: TERM, clients: [TERM], running: null, pending: [], ...over,
});

describe("live session view", () => {
  it("builds the transcript with each reply's tool calls (asked and answered = approved)", () => {
    const v = viewFromSnapshot(snap());
    expect(v.messages.map((m) => [m.role, m.content, m.by])).toEqual([["user", "Add a footer", "terminal"], ["assistant", "Done.", undefined]]);
    expect(v.messages[1].toolEvents?.[0]).toMatchObject({ tool: "edit_file", approval_status: "approved", result: "ok" });
    expect(v.messages[1].changedFiles).toEqual(["index.html"]);
    expect(canWrite(v, DESK)).toBe(false);
    expect(canWrite(v, TERM)).toBe(true);
  });

  it("follows a running turn, approvals, control changes and the end of the turn", () => {
    let v = viewFromSnapshot(snap());
    v = applySessionEvent(v, { seq: 11, type: "control", controller: DESK });
    expect(canWrite(v, DESK)).toBe(true);
    v = applySessionEvent(v, { seq: 12, type: "message", entry: { id: "u2", role: "user", content: "and a header", at: 3, by: "desktop" } });
    v = applySessionEvent(v, { seq: 13, type: "agent", turnId: "t2", event: { type: "turn", id: "t2" } });
    v = applySessionEvent(v, { seq: 14, type: "agent", turnId: "t2", event: { type: "text", content: "Adding" } });
    v = applySessionEvent(v, { seq: 15, type: "agent", turnId: "t2", event: { type: "tool_call", id: "c2", tool: "write_file", args: { path: "h.html" }, requires_approval: true } });
    expect(v.streaming?.toolEvents[0].approval_status).toBe("pending");
    v = applySessionEvent(v, { seq: 16, type: "approval", id: "c2", approved: true, by: "desktop" });
    expect(v.streaming?.toolEvents[0].approval_status).toBe("approved");
    v = applySessionEvent(v, { seq: 17, type: "turn_end", entry: { id: "a2", role: "assistant", content: "Adding", at: 4, events: [] } });
    expect(v.streaming).toBeNull();
    expect(v.messages).toHaveLength(4);
    expect(v.seq).toBe(17);
    v = applySessionEvent(v, { seq: 18, type: "undo", turnId: "t1", reverted: ["index.html"] });
    expect(v.messages[1].changedFiles).toBeUndefined();
    v = applySessionEvent(v, { seq: 19, type: "presence", clients: [TERM, DESK] });
    expect(v.clients).toHaveLength(2);
    expect(applySessionEvent(v, { seq: 30, type: "resync" }).needsResync).toBe(true);
    expect(applySessionEvent(v, { seq: 31, type: "cleared" }).messages).toEqual([]);
  });

  it("a snapshot taken mid-turn shows the streaming reply and which call still waits", () => {
    const v = viewFromSnapshot(snap({
      running: { turnId: "t3", text: "Hi", events: [
        { type: "turn", id: "t3" },
        { type: "tool_call", id: "x1", tool: "write_file", args: {}, requires_approval: true },
        { type: "tool_call", id: "x2", tool: "run_shell", args: {}, requires_approval: true },
      ] },
      pending: [{ id: "x2", tool: "run_shell", args: {} }],
    }));
    expect(v.streaming?.toolEvents.map((e) => e.approval_status)).toEqual(["approved", "pending"]);
  });
});

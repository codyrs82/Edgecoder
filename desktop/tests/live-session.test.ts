import { describe, expect, it } from "vitest";
import { applySessionEvent, clientLabel, fromWhom, presenceText, viewFromSnapshot } from "../src/lib/live-session";
import { servedBreakdown, servedLine } from "../src/lib/served";
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
    // Co-editing: no controller, a light presence line instead.
    expect(v.controller).toBeNull();
    expect(presenceText(v, DESK)).toBe("Terminal and EdgeCoder app connected");
  });

  it("follows a running turn, approvals and the end of the turn", () => {
    let v = viewFromSnapshot(snap());
    v = applySessionEvent(v, { seq: 11, type: "control", controller: DESK });
    expect(v.controller).toBeNull();
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

  it("queues messages from either client in order, removes them as they start or are removed, and notes what the other client did", () => {
    let v = viewFromSnapshot(snap({ queue: [{ id: "q1", text: "from the terminal", by: "terminal", at: 1 }] }));
    expect(v.queue).toEqual([{ id: "q1", text: "from the terminal", from: "the terminal" }]);
    v = applySessionEvent(v, { seq: 11, type: "queued", entry: { id: "q2", text: "from here", by: "desktop", label: "EdgeCoder app", at: 2 } });
    expect(v.queue.map((q) => q.id)).toEqual(["q1", "q2"]);
    v = applySessionEvent(v, { seq: 12, type: "unqueued", id: "q2", queue: [{ id: "q1", text: "from the terminal", by: "terminal", at: 1 }] });
    expect(v.queue.map((q) => q.id)).toEqual(["q1"]);
    v = applySessionEvent(v, { seq: 13, type: "message", entry: { id: "q1", role: "user", content: "from the terminal", at: 3, by: "terminal" } });
    expect(v.queue).toEqual([]);
    v = applySessionEvent(v, { seq: 14, type: "agent", turnId: "t9", event: { type: "turn", id: "t9" } });
    v = applySessionEvent(v, { seq: 15, type: "agent", turnId: "t9", event: { type: "tool_call", id: "c7", tool: "edit_file", args: {}, requires_approval: true } });
    v = applySessionEvent(v, { seq: 16, type: "approval", id: "c7", approved: true, by: "terminal", label: "Terminal on mbp" });
    expect(v.streaming?.toolEvents[0].approval_status).toBe("approved");
    expect(v.notes.at(-1)).toBe("Approved in the terminal.");
    v = applySessionEvent(v, { seq: 17, type: "settings", model: "network/qwen2.5-coder:32b", mode: "auto", changed: ["model", "mode"], by: "terminal" });
    expect(v.mode).toBe("auto");
    expect(v.notes.at(-1)).toBe("The terminal changed the model to network/qwen2.5-coder:32b and mode to auto.");
  });

  it("the reply footer says where each call ran", () => {
    const served = { label: "lin-•••3f2a", own: false, computeClass: "gpu.dc", tier: "gpu.dc40", hardware: "Datacenter GPU (gpu.dc40)", gpu: "2× NVIDIA A16", region: "ord", city: "Chicago", country: "US", promptTokens: 24_800, outputTokens: 312, promptMs: 81_000, genMs: 6_500, pickupMs: 400 };
    expect(servedLine([{ cSats: 3.4, model: "qwen3-coder:30b", served }])).toBe("qwen3-coder:30b · Datacenter GPU 2×A16 · Chicago · read 24.8k tok in 81 s · wrote 312 tok in 6.5 s · 3.4 cSats");
    expect(servedLine([{ cSats: 0, model: "qwen3.5:9b", served: { label: "This computer", own: true, computeClass: "local", tier: null, hardware: "This computer (Apple M1 Max)", region: null, country: null } }])).toBe("qwen3.5:9b · This computer (Apple M1 Max) · free");
    expect(servedLine([{ cSats: 1, where: "Network" }])).toBeNull();
    expect(servedBreakdown([{ cSats: 3.4, model: "qwen3-coder:30b", served }])).toBe("1. qwen3-coder:30b · lin-•••3f2a · Datacenter GPU (gpu.dc40) · 2× NVIDIA A16 · Chicago ord (pickup 0.4 s, read 24.8k tok in 81 s, wrote 312 tok in 6.5 s) · 3.4 cSats");
  });
});

describe("Allow for this session", () => {
  it("keeps the session's allowances from the snapshot and the allowances event", () => {
    let v = viewFromSnapshot(snap());
    expect(v.allowances).toEqual([]);
    v = viewFromSnapshot(snap({ allowances: ["npm test commands"] }));
    expect(v.allowances).toEqual(["npm test commands"]);
    v = applySessionEvent(v, { seq: 11, type: "allowances", allowances: ["npm test commands", "edits inside the project"], by: "terminal" });
    expect(v.allowances).toEqual(["npm test commands", "edits inside the project"]);
    expect(applySessionEvent(v, { seq: 12, type: "allowances", by: "desktop" }).allowances).toEqual(v.allowances);
  });

  it("a pending ask in the snapshot offers what its pending item says", () => {
    const v = viewFromSnapshot(snap({
      running: { turnId: "t2", text: "", events: [{ type: "turn", id: "t2" }, { type: "tool_call", id: "c9", tool: "run_shell", args: { command: "npm test" }, requires_approval: true }] },
      pending: [{ id: "c9", tool: "run_shell", args: { command: "npm test" }, allowSession: "npm test commands" }],
    }));
    expect(v.streaming?.toolEvents[0]).toMatchObject({ approval_status: "pending", allow_session: "npm test commands" });
  });
});

describe("the phone as a client (Code from your phone)", () => {
  it("is shown as Phone in the header and \"your phone\" in notes", () => {
    const PHONE = { clientId: "remote-phone", kind: "remote" as const, label: "iPhone" };
    expect(clientLabel(PHONE)).toBe("Phone");
    expect(clientLabel(TERM)).toBe("Terminal on mbp");
    expect(fromWhom("remote", "iPhone")).toBe("your phone");
    const v = { ...viewFromSnapshot(snap()), clients: [DESK, PHONE] };
    expect(presenceText(v, DESK)).toBe("Phone and this app connected");
  });
});

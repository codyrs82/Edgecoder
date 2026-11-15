import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelIdOf, parseModelId, SessionError, shellPrefix, type ClientRef, type SessionEvent } from "../../src/apps/ide/sessions.js";
import { makeHub, until } from "../helpers/sessions.js";

const TERM: ClientRef = { clientId: "term-1", kind: "terminal", label: "Terminal" };
const DESK: ClientRef = { clientId: "desk-1", kind: "desktop", label: "EdgeCoder app" };

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sess-proj-"));
  dir = mkdtempSync(join(tmpdir(), "sess-store-"));
  writeFileSync(join(root, "a.txt"), "one\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe("model ids", () => {
  it("round-trips the placements clients show", () => {
    for (const id of ["auto", "qwen3.5:9b", "network/qwen3-coder:30b", "network/qwen3-coder:30b@gpu", "mine/qwen3-coder:30b", "reserved/r1/qwen3-coder:30b"]) {
      expect(modelIdOf(parseModelId(id))).toBe(id);
    }
    expect(parseModelId("network/m@nope")).toEqual({ model: "m@nope", compute: { target: "network", computeClass: "any" } });
  });
  it("only plain commands can be approved always, by program name", () => {
    expect(shellPrefix("npm test")).toBe("npm");
    expect(shellPrefix("npm test && rm -rf /")).toBeNull();
    expect(shellPrefix("echo $(id)")).toBeNull();
    expect(shellPrefix(42)).toBeNull();
  });
});

describe("SessionHub", () => {
  it("creates a session, runs a turn with the transcript as context, and persists it (0600)", async () => {
    const { hub, model } = makeHub([{ content: "Hello from the model.", toolCalls: [] }], { dir });
    const s = hub.create({ projectRoot: root, model: "network/qwen3-coder:30b", client: TERM });
    expect(s.branch).toBe("main");
    expect(hub.snapshot(s.id).controller).toEqual(TERM);
    hub.send(s.id, "hi there", TERM);
    await hub.idle(s.id);
    const snap = hub.snapshot(s.id);
    expect(snap.session.title).toBe("hi there");
    expect(snap.session.transcript.map((t) => [t.role, t.content])).toEqual([["user", "hi there"], ["assistant", "Hello from the model."]]);
    expect(model.requests[0].messages.at(-1)).toEqual({ role: "user", content: "hi there" });
    const file = join(dir, `${s.id}.json`);
    // POSIX permissions only (Windows has no mode bits).
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // A new hub (the provider restarted) loads it.
    const again = makeHub([], { dir }).hub;
    again.load();
    expect(again.list()[0]).toMatchObject({ id: s.id, title: "hi there", messages: 2, model: "network/qwen3-coder:30b", running: false });
  });

  it("only the controller writes; take control hands the turn over, including a waiting approval", async () => {
    const { hub } = makeHub([
      { content: "Writing.", toolCalls: [{ name: "write_file", arguments: { path: "b.txt", content: "new\n" } }] },
      { content: "Done.", toolCalls: [] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM });
    const events: SessionEvent[] = [];
    hub.subscribe(s.id, DESK, 0, (e) => events.push(e));
    expect(() => hub.send(s.id, "from the app", DESK)).toThrow(SessionError);
    hub.send(s.id, "write b", TERM);
    await until(() => hub.snapshot(s.id).pending.length === 1, 3000, "approval");
    const callId = hub.snapshot(s.id).pending[0].id;
    expect(() => hub.approve(s.id, callId, true, DESK)).toThrow(/in control/);
    expect(() => hub.send(s.id, "again", TERM)).toThrow(/still running/);
    hub.takeControl(s.id, DESK);
    hub.approve(s.id, callId, true, DESK);
    await hub.idle(s.id);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("new\n");
    const types = events.map((e) => e.type);
    expect(types).toContain("control");
    expect(events.find((e) => e.type === "approval")).toMatchObject({ id: callId, approved: true, by: "desktop" });
    const end = events.find((e) => e.type === "turn_end") as SessionEvent & { entry: { changedFiles: string[]; content: string } };
    expect(end.entry).toMatchObject({ changedFiles: ["b.txt"], content: "Writing.\n\nDone." });
    // seq numbers are strictly increasing
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it("'always' for edits applies later edits without asking; always for a command covers that program only", async () => {
    const { hub } = makeHub([
      { content: "", toolCalls: [{ name: "edit_file", arguments: { path: "a.txt", old_string: "one", new_string: "two" } }] },
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "c.txt", content: "c\n" } }] },
      { content: "ok", toolCalls: [] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM });
    const events: SessionEvent[] = [];
    hub.subscribe(s.id, TERM, 0, (e) => events.push(e));
    hub.send(s.id, "edit", TERM);
    await until(() => hub.snapshot(s.id).pending.length === 1);
    hub.approve(s.id, hub.snapshot(s.id).pending[0].id, true, TERM, true);
    await hub.idle(s.id);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(root, "c.txt"), "utf8")).toBe("c\n");
    // The second edit never asked: its tool_call came without requires_approval.
    expect(events.filter((e) => e.type === "approval").map((e) => e.by)).toEqual(["terminal"]);
    const calls = events.filter((e) => e.type === "agent" && (e.event as { type: string }).type === "tool_call").map((e) => (e.event as { requires_approval: boolean }).requires_approval);
    expect(calls).toEqual([true, false]);
    expect(hub.snapshot(s.id).session.autoApprove).toBe("edits");
  });

  it("undo reverts the last turn's files; clear empties the conversation; cancel stops a turn", async () => {
    const { hub } = makeHub([
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "a.txt", content: "changed\n" } }] },
      { content: "ok", toolCalls: [] },
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "z.txt", content: "z\n" } }] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM, autoApprove: "edits" });
    hub.send(s.id, "change a", TERM);
    await hub.idle(s.id);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("changed\n");
    expect(hub.undo(s.id, TERM).reverted).toEqual(["a.txt"]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(() => hub.undo(s.id, TERM)).toThrow(/No changes/);
    // a turn waiting on approval (edits auto-approve is off now) can be stopped
    hub.update(s.id, { autoApprove: "none" }, TERM);
    hub.send(s.id, "write z", TERM);
    await until(() => hub.snapshot(s.id).pending.length === 1);
    expect(hub.cancel(s.id, TERM)).toBe(true);
    await hub.idle(s.id);
    expect(existsSync(join(root, "z.txt"))).toBe(false);
    expect(hub.snapshot(s.id).session.transcript.at(-1)?.content).toContain("(stopped)");
    hub.clear(s.id, TERM);
    expect(hub.snapshot(s.id).session.transcript).toEqual([]);
  });

  it("replays events after `since`, says resync when the gap is gone, and tracks who is connected", async () => {
    const { hub } = makeHub([{ content: "x", toolCalls: [] }]);
    const s = hub.create({ projectRoot: root, client: TERM });
    hub.publish(s.id, true, TERM);
    hub.send(s.id, "go", TERM);
    await hub.idle(s.id);
    const all: SessionEvent[] = [];
    const stop = hub.subscribe(s.id, DESK, 0, (e) => all.push(e));
    expect(all.find((e) => e.type === "turn_end")).toBeTruthy();
    expect(hub.list({ published: true })[0]).toMatchObject({ id: s.id, live: true, clients: [DESK] });
    const later: SessionEvent[] = [];
    const cursor = all.at(-2)!.seq;
    hub.subscribe(s.id, TERM, cursor, (e) => later.push(e));
    expect(later[0].seq).toBe(cursor + 1);
    stop();
    expect(hub.list()[0].clients).toEqual([TERM]);
    // More than the buffer later, an old cursor gets a resync.
    for (let i = 0; i < 1100; i++) hub.update(s.id, { title: `t${i}` }, TERM);
    const gap: SessionEvent[] = [];
    hub.subscribe(s.id, DESK, 1, (e) => gap.push(e));
    expect(gap[0].type).toBe("resync");
  });

  it("an approval nobody answers is rejected after the timeout", async () => {
    const { hub } = makeHub([{ content: "", toolCalls: [{ name: "write_file", arguments: { path: "t.txt", content: "t" } }] }, { content: "fine", toolCalls: [] }], { approvalTimeoutMs: 50 });
    const s = hub.create({ projectRoot: root, client: TERM });
    hub.send(s.id, "go", TERM);
    await hub.idle(s.id);
    expect(existsSync(join(root, "t.txt"))).toBe(false);
    const ev = hub.snapshot(s.id).session.transcript.at(-1)!.events!;
    expect(ev.find((e) => e.type === "tool_result")).toMatchObject({ error: expect.stringContaining("rejected") });
  });
});

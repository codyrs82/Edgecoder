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
    // A tier suffix names its class (and is kept as the class id).
    expect(parseModelId("network/qwen3-coder:30b@gpu.c8")).toEqual({ model: "qwen3-coder:30b", compute: { target: "network", computeClass: "gpu" } });
    expect(modelIdOf(parseModelId("network/qwen3-coder:30b@gpu.c8"))).toBe("network/qwen3-coder:30b@gpu");
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
    expect(hub.snapshot(s.id).controller).toBeNull();
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

  it("co-editing: any client sends; messages sent during a turn queue in order, labelled, and run next together", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { hub, model } = makeHub([
      async () => {
        await gate;
        return { content: "First reply.", toolCalls: [] };
      },
      { content: "Second reply.", toolCalls: [] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM });
    const events: SessionEvent[] = [];
    hub.subscribe(s.id, DESK, 0, (e) => events.push(e));
    expect(hub.send(s.id, "from the terminal", TERM).turnId).toBeTruthy();
    // Concurrent sends from both clients while the turn runs: queued, in order.
    const a = hub.send(s.id, "from the app", DESK);
    const b = hub.send(s.id, "and the terminal again", TERM);
    expect(a.turnId).toBeNull();
    expect(a.queued).toMatchObject({ by: "desktop", label: "EdgeCoder app" });
    expect(hub.snapshot(s.id).queue.map((q) => [q.by, q.text])).toEqual([["desktop", "from the app"], ["terminal", "and the terminal again"]]);
    // One can be removed before it starts.
    const c = hub.send(s.id, "never mind", DESK);
    expect(hub.unqueue(s.id, c.queued!.id, TERM)).toBe(true);
    expect(events.filter((e) => e.type === "queued")).toHaveLength(3);
    release();
    await hub.idle(s.id);
    const t = hub.snapshot(s.id).session.transcript.map((x) => [x.role, x.by ?? "", x.content]);
    expect(t).toEqual([
      ["user", "terminal", "from the terminal"],
      ["assistant", "", "First reply."],
      ["user", "desktop", "from the app"],
      ["user", "terminal", "and the terminal again"],
      ["assistant", "", "Second reply."],
    ]);
    expect(model.requests[1].messages.slice(-2).map((m) => m.content)).toEqual(["from the app", "and the terminal again"]);
    expect(hub.snapshot(s.id).queue).toEqual([]);
    expect(b.queued?.id).toBeTruthy();
  });

  it("approvals: any client answers, the first answer wins and everyone hears who answered", async () => {
    const { hub } = makeHub([
      { content: "Writing.", toolCalls: [{ name: "write_file", arguments: { path: "b.txt", content: "new\n" } }] },
      { content: "Done.", toolCalls: [] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM, mode: "ask" });
    const events: SessionEvent[] = [];
    hub.subscribe(s.id, TERM, 0, (e) => events.push(e));
    hub.send(s.id, "write b", TERM);
    await until(() => hub.snapshot(s.id).pending.length === 1, 3000, "approval");
    const callId = hub.snapshot(s.id).pending[0].id;
    expect(hub.approve(s.id, callId, true, DESK)).toBe(true);
    // The terminal's answer arrives second: no effect, no error.
    expect(hub.approve(s.id, callId, false, TERM)).toBe(false);
    await hub.idle(s.id);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("new\n");
    const approvals = events.filter((e) => e.type === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: callId, approved: true, by: "desktop", label: "EdgeCoder app" });
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((x, y) => x - y));
  });

  it("interrupt plus queue: stopping the turn runs the queued message now", async () => {
    const { hub } = makeHub([
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "slow.txt", content: "x" } }] },
      { content: "Queued one ran.", toolCalls: [] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM, mode: "ask" });
    hub.send(s.id, "long job", TERM);
    await until(() => hub.snapshot(s.id).pending.length === 1, 3000, "approval");
    hub.send(s.id, "do this instead", DESK);
    expect(hub.cancel(s.id, DESK)).toBe(true);
    await hub.idle(s.id);
    const t = hub.snapshot(s.id).session.transcript;
    expect(t.map((x) => x.content)).toEqual(["long job", expect.stringContaining("(stopped)"), "do this instead", "Queued one ran."]);
    expect(existsSync(join(root, "slow.txt"))).toBe(false);
  });

  it("settings from either client are mirrored to the other with who changed them", () => {
    const { hub } = makeHub([]);
    const s = hub.create({ projectRoot: root, client: TERM });
    const seen: SessionEvent[] = [];
    hub.subscribe(s.id, TERM, 0, (e) => seen.push(e));
    hub.update(s.id, { model: "network/qwen3-coder:30b", mode: "auto" }, DESK);
    const ev = seen.find((e) => e.type === "settings")!;
    expect(ev).toMatchObject({ model: "network/qwen3-coder:30b", mode: "auto", autoApprove: "edits", by: "desktop", label: "EdgeCoder app", changed: ["model", "mode"] });
    expect(hub.takeControl(s.id, DESK)).toEqual(DESK); // a no-op kept for older clients
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

describe("Full access", () => {
  const OWNER = "acct_owner";
  const OWN_DESK: ClientRef = { ...DESK, accountId: OWNER };
  const GUEST: ClientRef = { clientId: "guest-1", kind: "desktop", label: "Guest", accountId: "acct_guest" };
  const PHONE: ClientRef = { clientId: "remote-phone", kind: "remote", label: "iPhone", accountId: OWNER };

  it("runs a compound command, then a commit, without a single approval card", async () => {
    const { hub } = makeHub([
      { content: "", toolCalls: [{ name: "run_shell", arguments: { command: 'X="$HOME" && echo made > made.txt && cat made.txt | tail -1' } }] },
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "b.txt", content: "b\n" } }] },
      { content: "done", toolCalls: [] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM, mode: "full" });
    expect(s).toMatchObject({ mode: "full", autoApprove: "edits" });
    const events: SessionEvent[] = [];
    hub.subscribe(s.id, TERM, 0, (e) => events.push(e));
    hub.send(s.id, "go", TERM);
    await hub.idle(s.id);
    expect(readFileSync(join(root, "made.txt"), "utf8")).toBe("made\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b\n");
    expect(events.filter((e) => e.type === "approval")).toEqual([]);
    const calls = events.filter((e) => e.type === "agent" && (e.event as { type: string }).type === "tool_call").map((e) => (e.event as { requires_approval: boolean }).requires_approval);
    expect(calls).toEqual([false, false]);
  });

  it("is turned on from this computer's own clients or the owner's account only (the owner's phone with a confirm)", () => {
    const { hub } = makeHub([]);
    const s = hub.create({ projectRoot: root, client: TERM, ownerAccount: OWNER });
    for (const who of [PHONE, GUEST, { ...PHONE, accountId: "acct_guest" }, { ...PHONE, accountId: undefined }]) {
      expect(() => hub.update(s.id, { mode: "full" }, who)).toThrow(SessionError);
      expect(hub.peek(s.id)!.mode).not.toBe("full");
    }
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as SessionError).code;
      }
      return null;
    };
    // The owner's phone: only with the confirm; another account's phone or a guest never.
    expect(code(() => hub.update(s.id, { mode: "full" }, PHONE))).toBe("invalid");
    expect(code(() => hub.update(s.id, { mode: "full" }, { ...PHONE, accountId: "acct_guest" }, { confirmFull: true }))).toBe("forbidden");
    expect(code(() => hub.update(s.id, { mode: "auto" }, { ...PHONE, accountId: "acct_guest" }))).toBe("forbidden");
    expect(code(() => hub.update(s.id, { mode: "full" }, GUEST, { confirmFull: true }))).toBe("forbidden");
    expect(hub.peek(s.id)!.mode).not.toBe("full");
    expect(hub.update(s.id, { mode: "full" }, PHONE, { confirmFull: true }).mode).toBe("full");
    hub.update(s.id, { mode: "ask" }, TERM);
    expect(() => hub.create({ projectRoot: root, client: PHONE, ownerAccount: OWNER, mode: "full" })).toThrow(/confirm/);
    expect(() => hub.create({ projectRoot: root, client: GUEST, ownerAccount: OWNER, mode: "full" })).toThrow(/owner/);
    expect(hub.update(s.id, { mode: "full" }, OWN_DESK).mode).toBe("full");
    expect(hub.update(s.id, { mode: "auto" }, DESK).mode).toBe("auto");
    expect(hub.update(s.id, { mode: "full" }, TERM).mode).toBe("full");
  });

  it("another account's message, or another account's phone, runs as Accept edits; the owner's (Mac or phone) runs in Full access", () => {
    const { hub } = makeHub([]);
    const s = hub.create({ projectRoot: root, client: TERM, ownerAccount: OWNER, mode: "full" });
    const install = { command: "npm install left-pad" };
    expect(hub.decide(s, "run_shell", install, OWN_DESK).action).toBe("run");
    expect(hub.decide(s, "run_shell", install, TERM).action).toBe("run");
    expect(hub.decide(s, "git_push", {}, OWN_DESK).action).toBe("run");
    // Another account: exactly Accept edits (edits inside apply, commands and pushes ask).
    expect(hub.modeFor(s, GUEST)).toBe("auto-edits");
    expect(hub.decide(s, "run_shell", install, GUEST).action).toBe("ask");
    expect(hub.decide(s, "git_push", {}, GUEST).action).toBe("ask");
    expect(hub.decide(s, "write_file", { path: "x.txt", content: "x" }, GUEST).action).toBe("run");
    // Another account's phone keeps the remote rules (commands ask) as Accept edits.
    const NOT_OWNER_PHONE = { ...PHONE, accountId: "acct_guest" };
    expect(hub.modeFor(s, NOT_OWNER_PHONE)).toBe("auto-edits");
    expect(hub.decide(s, "run_shell", install, NOT_OWNER_PHONE).action).toBe("ask");
    expect(hub.decide(s, "git_push", {}, NOT_OWNER_PHONE).action).toBe("ask");
    expect(hub.decide(s, "write_file", { path: "x.txt", content: "x" }, NOT_OWNER_PHONE).action).toBe("run");
    // The owner chose Full access: their phone's turn runs like the Mac's (hard refusals stay).
    expect(hub.modeFor(s, PHONE)).toBe("full");
    expect(hub.decide(s, "run_shell", install, PHONE).action).toBe("run");
    expect(hub.decide(s, "git_push", {}, PHONE).action).toBe("run");
    expect(hub.decide(s, "run_shell", { command: "sudo ls" }, PHONE).action).toBe("refuse");
    expect(hub.peek(s.id)!.mode).toBe("full");
  });

  it("a turn from another account in a Full access session asks before a command", async () => {
    const { hub } = makeHub([
      { content: "", toolCalls: [{ name: "run_shell", arguments: { command: "echo hi > hi.txt" } }] },
      { content: "ok", toolCalls: [] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM, ownerAccount: OWNER, mode: "full" });
    hub.send(s.id, "write hi", GUEST);
    await until(() => hub.snapshot(s.id).pending.length === 1, 3000, "the guest's command to ask");
    hub.approve(s.id, hub.snapshot(s.id).pending[0].id, false, TERM);
    await hub.idle(s.id);
    expect(existsSync(join(root, "hi.txt"))).toBe(false);
  });

  it("switching to Full access lets a waiting push go ahead", async () => {
    const { hub } = makeHub([
      { content: "", toolCalls: [{ name: "git_push", arguments: {} }] },
      { content: "ok", toolCalls: [] },
    ]);
    const s = hub.create({ projectRoot: root, client: TERM, mode: "auto" });
    const events: SessionEvent[] = [];
    hub.subscribe(s.id, TERM, 0, (e) => events.push(e));
    hub.send(s.id, "push", TERM);
    await until(() => hub.snapshot(s.id).pending.length === 1, 3000, "push to ask");
    hub.update(s.id, { mode: "full" }, TERM);
    await hub.idle(s.id);
    expect(events.filter((e) => e.type === "approval")).toEqual([expect.objectContaining({ approved: true, by: "always" })]);
  });
});

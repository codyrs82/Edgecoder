import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCodeRemoteRoutes, type RemoteSessionSnapshot } from "../../src/apps/ide/code-remote.js";
import { desktopTurnFor, firstAnswer, registerDesktopChatRoutes } from "../../src/apps/ide/desktop-chats.js";
import type { SessionEvent } from "../../src/apps/ide/sessions.js";
import { isProjectOpenToPhone, isProjectTrusted, listTrustedProjects, markCodeProject, projectIdOf, setProjectTrusted } from "../../src/apps/ide/workspace-trust.js";
import { makeHub, until, type Reply } from "../helpers/sessions.js";

/*
 * The desktop Code view's chats on the phone: the app syncs each chat to a mirror session, the
 * folder opens to the phone (not to its own tooling), the phone reads and continues the chat on
 * this Mac, the app's own turns show live there, and the app sees what the phone did.
 */
const ACCOUNT = "acct_owner";
const SALT = "test-salt";
let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "desktop-chats-"));
  process.env.EDGECODER_TRUST_FILE = join(tmp, "trusted.json");
  root = join(tmp, "work", "Edgecoder");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.txt"), "one\n");
});
afterEach(() => {
  delete process.env.EDGECODER_TRUST_FILE;
  rmSync(tmp, { recursive: true, force: true });
});

async function server(replies: Reply[] = [], owner = ACCOUNT) {
  const { hub, checkpoints, model } = makeHub(replies, { owner });
  const app = Fastify();
  registerDesktopChatRoutes(app, hub);
  registerCodeRemoteRoutes(app, hub, { account: async () => ACCOUNT, checkpoints, machineSalt: () => SALT, branch: () => "main" });
  await app.ready();
  const command = async (body: Record<string, unknown>) => {
    const r = await app.inject({ method: "POST", url: "/v1/ide/code/remote/command", payload: { requestedBy: ACCOUNT, ...body } });
    return { code: r.statusCode, body: r.json() as { status: string; error?: string; message?: string; data?: any } };
  };
  const sync = async (body: Record<string, unknown>) => {
    const r = await app.inject({ method: "POST", url: "/v1/ide/code-chats/sync", payload: body });
    return { code: r.statusCode, body: r.json() as { sessionId?: string; error?: string } };
  };
  const overview = async () => (await app.inject({ method: "GET", url: `/v1/ide/code/remote/snapshot?account=${ACCOUNT}` })).json() as { projects: Array<{ projectId: string; name: string }>; sessions: Array<{ id: string; title: string; projectId: string; origin: string }> };
  return { hub, app, command, sync, overview, model };
}

const chatId = () => randomUUID();
const msg = (role: "user" | "assistant", content: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), role, content, at: Date.now(), ...extra });

describe("folders used in the Code view", () => {
  it("open to the phone without trusting their tooling; untrusting closes them again", () => {
    markCodeProject(root);
    expect(isProjectOpenToPhone(root)).toBe(true);
    expect(isProjectTrusted(root)).toBe(false);
    expect(listTrustedProjects(SALT).map((p) => p.name)).toEqual(["Edgecoder"]);
    // Trusting another folder keeps this one on the phone's list.
    const other = join(tmp, "work", "other");
    mkdirSync(other);
    setProjectTrusted(other, true);
    expect(listTrustedProjects(SALT).map((p) => p.name).sort()).toEqual(["Edgecoder", "other"]);
    setProjectTrusted(root, false);
    expect(isProjectOpenToPhone(root)).toBe(false);
    expect(listTrustedProjects(SALT).map((p) => p.name)).toEqual(["other"]);
  });
});

describe("sync", () => {
  it("makes one mirror per chat, owned by the signed-in account, and adds only new messages", async () => {
    const { hub, sync, overview } = await server();
    const id = chatId();
    const first = [msg("user", "what open PRs do we have?"), msg("assistant", "Two: #485 and #489.", { turnId: randomUUID() })];
    const r = await sync({ chatId: id, projectRoot: root, title: "what open PRs do we have?", mode: "auto-edits", model: "network/qwen3-coder:30b@gpu", messages: first });
    expect(r.code).toBe(200);
    const s = hub.peek(r.body.sessionId!)!;
    expect(s).toMatchObject({ chatId: id, origin: "desktop", ownerAccount: ACCOUNT, published: false, mode: "auto-edits", title: "what open PRs do we have?", model: "qwen3-coder:30b" });
    expect(s.transcript.map((t) => [t.role, t.content, t.by])).toEqual([["user", "what open PRs do we have?", "desktop"], ["assistant", "Two: #485 and #489.", "desktop"]]);
    // Syncing again (the same messages and one more) adds only the new one, to the same session.
    const again = await sync({ chatId: id, projectRoot: root, messages: [...first, msg("user", "thanks")] });
    expect(again.body.sessionId).toBe(s.id);
    expect(hub.peek(s.id)!.transcript).toHaveLength(3);
    expect(hub.list()).toHaveLength(1);
    // Opening the chat opened its folder to the phone: the overview lists the project and the chat.
    const o = await overview();
    expect(o.projects.map((p) => p.name)).toEqual(["Edgecoder"]);
    expect(o.sessions).toEqual([expect.objectContaining({ id: s.id, projectId: projectIdOf(root, SALT), origin: "desktop" })]);
    expect(JSON.stringify(o)).not.toContain(tmp);
    expect(isProjectTrusted(root)).toBe(false);
  });

  it("refuses a missing folder, a relative path and a chat moved to another folder", async () => {
    const { sync } = await server();
    expect((await sync({ chatId: chatId(), projectRoot: join(tmp, "nope"), messages: [] })).code).toBe(400);
    expect((await sync({ chatId: chatId(), projectRoot: "work/Edgecoder", messages: [] })).code).toBe(400);
    const id = chatId();
    await sync({ chatId: id, projectRoot: root, messages: [] });
    const other = join(tmp, "work", "other");
    mkdirSync(other);
    expect((await sync({ chatId: id, projectRoot: other, messages: [] })).code).toBe(409);
    expect(isProjectOpenToPhone(other)).toBe(false);
  });

  it("a chat deleted in the app takes its mirror with it", async () => {
    const { app, hub, sync } = await server();
    const id = chatId();
    await sync({ chatId: id, projectRoot: root, messages: [msg("user", "hi")] });
    const forget = async () => (await app.inject({ method: "POST", url: "/v1/ide/code-chats/forget", payload: { chatId: id } })).json();
    expect(await forget()).toEqual({ removed: true });
    expect(hub.list()).toEqual([]);
    expect(await forget()).toEqual({ removed: false });
  });

  it("another account's chats and Full access stay on the Mac", async () => {
    const { sync, overview, command, hub } = await server([], "acct_other");
    const r = await sync({ chatId: chatId(), projectRoot: root, mode: "full", messages: [msg("user", "hi")] });
    // The Mac may set Full access on its own chat (it is this computer's client).
    expect(hub.peek(r.body.sessionId!)!.mode).toBe("full");
    expect((await overview()).sessions).toEqual([]);
    expect((await command({ action: "snapshot", sessionId: r.body.sessionId })).body).toMatchObject({ status: "refused", error: "no_such_session" });
  });
});

describe("continuing a desktop chat from the phone", () => {
  it("runs the turn on this Mac over the whole chat, under the phone's rules, and the app hears it", async () => {
    const { hub, sync, command, model } = await server([{ content: "", toolCalls: [{ name: "run_shell", arguments: { command: "npm test" } }] }, { content: "Tests pass.", toolCalls: [] }]);
    const r = await sync({ chatId: chatId(), projectRoot: root, mode: "full", messages: [msg("user", "what open PRs do we have?"), msg("assistant", "Two.")] });
    const id = r.body.sessionId!;
    // The app follows the mirror.
    const seen: SessionEvent[] = [];
    hub.subscribe(id, { clientId: "desk", kind: "desktop" }, hub.snapshot(id).seq, (e) => seen.push(e));
    // Full access is set from the Mac only.
    expect((await command({ action: "settings", sessionId: id, mode: "full" })).body).toMatchObject({ status: "refused", error: "full_on_mac" });
    expect((await command({ action: "message", sessionId: id, text: "run the tests" })).body.status).toBe("done");
    // In a Full access chat a phone turn still asks before a command that isn't read-only.
    await until(() => hub.snapshot(id).pending.length === 1, 5000, "npm test to ask");
    const snap = (await command({ action: "snapshot", sessionId: id })).body.data as RemoteSessionSnapshot;
    expect(snap.pending[0]).toMatchObject({ tool: "run_shell", command: "npm test", approvable: true });
    expect((await command({ action: "approve", sessionId: id, callId: snap.pending[0].callId, approved: true })).body.status).toBe("done");
    await hub.idle(id);
    // The model saw the desktop's earlier messages.
    expect(model.requests[0].messages.map((m) => m.content)).toEqual(expect.arrayContaining(["what open PRs do we have?", "Two.", "run the tests"]));
    const t = hub.peek(id)!.transcript;
    expect(t.slice(-2).map((e) => [e.role, e.by])).toEqual([["user", "remote"], ["assistant", undefined]]);
    expect(t.at(-1)!.content).toBe("Tests pass.");
    expect(seen.some((e) => e.type === "message" && (e.entry as { by?: string }).by === "remote")).toBe(true);
    expect(seen.some((e) => e.type === "turn_end" && (e.entry as { content: string }).content === "Tests pass.")).toBe(true);
    // The app's next sync (with the phone's messages, which it added by id) adds nothing twice.
    const before = hub.peek(id)!.transcript.length;
    await sync({ chatId: hub.peek(id)!.chatId, projectRoot: root, messages: t.filter((e) => e.role !== "note").map((e) => ({ id: e.id, role: e.role, content: e.content, at: e.at, ...(e.turnId ? { turnId: e.turnId } : {}) })) });
    expect(hub.peek(id)!.transcript).toHaveLength(before);
  });
});

describe("the app's own turn, live on the phone", () => {
  it("shows running, takes the phone's answer, ends with the app's reply and then runs a queued phone message", async () => {
    const { hub, sync, command } = await server([{ content: "Queued reply.", toolCalls: [] }]);
    const chat = chatId();
    const user = msg("user", "fix the bug");
    const id = (await sync({ chatId: chat, projectRoot: root, mode: "ask", messages: [user] })).body.sessionId!;
    const turnId = randomUUID();
    const abort = new AbortController();
    const turn = desktopTurnFor(hub, chat, turnId, abort)!;
    expect(turn).toBeTruthy();
    // Only one turn at a time: a second one isn't mirrored.
    expect(desktopTurnFor(hub, chat, randomUUID(), new AbortController())).toBeNull();
    turn.event({ type: "turn", id: turnId });
    turn.event({ type: "text", content: "Looking…" });
    turn.event({ type: "tool_call", id: "c1", tool: "run_shell", args: { command: "npm test" }, requires_approval: true } as never);
    const desk: { answer?: (ok: boolean) => void } = {};
    const answer = firstAnswer({ id: "c1", tool: "run_shell", args: { command: "npm test" } }, turn, (a) => (desk.answer = a), () => {}, 60_000);
    const snap = (await command({ action: "snapshot", sessionId: id })).body.data as RemoteSessionSnapshot;
    expect(snap.running).toMatchObject({ turnId, text: "Looking…" });
    expect(snap.pending).toEqual([expect.objectContaining({ callId: "c1", approvable: true })]);
    // The phone answers first; a later answer from the app changes nothing.
    expect((await command({ action: "approve", sessionId: id, callId: "c1", approved: true })).body.status).toBe("done");
    expect(await answer).toBe(true);
    desk.answer?.(false);
    // A phone message while the app's turn runs waits for it.
    const sent = (await command({ action: "message", sessionId: id, text: "and add a test" })).body.data;
    expect(sent.queuedId).toBeTruthy();
    turn.event({ type: "text", content: " Fixed." });
    turn.end();
    await until(() => hub.peek(id)!.transcript.at(-1)?.content === "Queued reply.", 5000, "the queued phone message to run");
    const t = hub.peek(id)!.transcript;
    expect(t.map((e) => [e.role, e.by ?? null, e.content])).toEqual([
      ["user", "desktop", "fix the bug"],
      ["assistant", "desktop", "Looking… Fixed."],
      ["user", "remote", "and add a test"],
      ["assistant", null, "Queued reply."],
    ]);
    // The app's own copy of its reply (same turn) isn't added again.
    await sync({ chatId: chat, projectRoot: root, messages: [user, msg("assistant", "Looking… Fixed.", { turnId })] });
    expect(hub.peek(id)!.transcript).toHaveLength(4);
  });

  it("an answer from the app clears the phone's card; the phone can stop the turn", async () => {
    const { hub, sync, command } = await server();
    const chat = chatId();
    const id = (await sync({ chatId: chat, projectRoot: root, messages: [msg("user", "go")] })).body.sessionId!;
    const abort = new AbortController();
    const turn = desktopTurnFor(hub, chat, randomUUID(), abort)!;
    const desk: { answer?: (ok: boolean) => void } = {};
    const answer = firstAnswer({ id: "c1", tool: "write_file", args: { path: "a.txt", content: "x" } }, turn, (a) => (desk.answer = a), () => {}, 60_000);
    expect(hub.snapshot(id).pending).toHaveLength(1);
    desk.answer!(false);
    expect(await answer).toBe(false);
    expect(hub.snapshot(id).pending).toHaveLength(0);
    expect((await command({ action: "cancel", sessionId: id })).body.data).toEqual({ cancelled: true });
    expect(abort.signal.aborted).toBe(true);
    turn.end();
    expect(hub.peek(id)!.transcript.at(-1)!.content).toContain("_(stopped)_");
  });

  it("the phone can't approve what a phone turn couldn't (outside the project)", async () => {
    const { hub, sync, command } = await server();
    const chat = chatId();
    const id = (await sync({ chatId: chat, projectRoot: root, mode: "full", messages: [msg("user", "go")] })).body.sessionId!;
    const turn = desktopTurnFor(hub, chat, randomUUID(), new AbortController())!;
    const answer = firstAnswer({ id: "c1", tool: "run_shell", args: { command: "cat ~/.ssh/config" } }, turn, () => {}, () => {}, 60_000);
    const snap = (await command({ action: "snapshot", sessionId: id })).body.data as RemoteSessionSnapshot;
    expect(snap.pending[0]).toMatchObject({ callId: "c1", approvable: false });
    expect((await command({ action: "approve", sessionId: id, callId: "c1", approved: true })).body).toMatchObject({ status: "refused", error: "approve_on_mac" });
    // Rejecting it from the phone is fine.
    expect((await command({ action: "approve", sessionId: id, callId: "c1", approved: false })).body.status).toBe("done");
    expect(await answer).toBe(false);
    turn.end();
  });
});

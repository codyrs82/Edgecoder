import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_APPROVABLE_COMMAND_BYTES, phoneClient, registerCodeRemoteRoutes, type RemoteSessionSnapshot } from "../../src/apps/ide/code-remote.js";
import { listTrustedProjects, loadOrCreateMachineSalt, projectIdOf, setProjectTrusted, trustedRootForId } from "../../src/apps/ide/workspace-trust.js";
import { makeHub, until, type Reply } from "../helpers/sessions.js";

/*
 * Coding sessions from the phone, the Mac's side: only the signed-in account, only trusted folders
 * (by an opaque id, never a path), strict commands, and remote turns that ask before anything that
 * isn't read-only and never learn an "always" answer.
 */
const ACCOUNT = "acct_owner";
const SALT = "test-salt";
let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "code-remote-"));
  process.env.EDGECODER_TRUST_FILE = join(tmp, "trusted.json");
  root = join(tmp, "work", "my-app");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.txt"), "one\n");
});
afterEach(() => {
  delete process.env.EDGECODER_TRUST_FILE;
  rmSync(tmp, { recursive: true, force: true });
});

async function server(replies: Reply[] = [], signedIn: string | null = ACCOUNT) {
  const { hub, checkpoints } = makeHub(replies);
  const app = Fastify();
  registerCodeRemoteRoutes(app, hub, { account: async () => signedIn, checkpoints, machineSalt: () => SALT, branch: () => "main" });
  await app.ready();
  const command = async (body: Record<string, unknown>) => {
    const r = await app.inject({ method: "POST", url: "/v1/ide/code/remote/command", payload: { requestedBy: ACCOUNT, ...body } });
    return { code: r.statusCode, body: r.json() as { status: string; error?: string; data?: any } };
  };
  return { hub, app, command };
}

describe("trusted projects", () => {
  it("lists only trusted folders that still exist, by a salted id and folder names", () => {
    const gone = join(tmp, "work", "gone");
    mkdirSync(gone);
    setProjectTrusted(root, true);
    setProjectTrusted(gone, true);
    rmSync(gone, { recursive: true });
    const list = listTrustedProjects(SALT, () => "main");
    expect(list).toEqual([{ projectId: projectIdOf(root, SALT), name: "my-app", parent: "work", branch: "main" }]);
    expect(list[0].projectId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(list)).not.toContain(tmp);
    // A different machine salt gives a different id; a symlink spelling gives the same one.
    expect(projectIdOf(root, "other")).not.toBe(list[0].projectId);
    const link = join(tmp, "link");
    symlinkSync(root, link);
    expect(projectIdOf(link, SALT)).toBe(list[0].projectId);
    expect(trustedRootForId(list[0].projectId, SALT)).toBeTruthy();
    expect(trustedRootForId(projectIdOf(root, "other"), SALT)).toBeNull();
  });

  it("keeps one random machine salt per computer", () => {
    const file = join(tmp, "edgecoder", "machine-salt");
    const a = loadOrCreateMachineSalt(file);
    expect(a.length).toBeGreaterThan(20);
    expect(loadOrCreateMachineSalt(file)).toBe(a);
  });
});

describe("account check", () => {
  it("refuses a command or snapshot from an account that isn't signed in on this Mac", async () => {
    const { app, command } = await server();
    expect((await command({ requestedBy: "acct_other", action: "projects" })).code).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/ide/code/remote/snapshot?account=acct_other" })).statusCode).toBe(403);
    const signedOut = await server([], null);
    expect((await signedOut.command({ action: "projects" })).code).toBe(403);
    expect((await command({ action: "projects" })).code).toBe(200);
  });
});

describe("create", () => {
  it("refuses unknown and no-longer-trusted projects, path fields and Auto", async () => {
    setProjectTrusted(root, true);
    const { command, hub } = await server();
    const projects = (await command({ action: "projects" })).body.data.projects as Array<{ projectId: string }>;
    const id = projects[0].projectId;
    expect((await command({ action: "create", projectId: "0123456789abcdef" })).body).toMatchObject({ status: "refused", error: "no_such_project" });
    // A raw path is never accepted, under any name.
    for (const extra of [{ projectRoot: root }, { path: root }]) {
      const r = await command({ action: "create", projectId: id, ...extra });
      expect(r.code).toBe(400);
      expect(r.body.error).toBe("invalid_request");
    }
    expect((await command({ action: "create", projectId: id, mode: "auto" })).body).toMatchObject({ status: "refused", error: "auto_on_mac" });
    // Untrusted after the phone listed it.
    setProjectTrusted(root, false);
    expect((await command({ action: "create", projectId: id })).body).toMatchObject({ status: "refused", error: "no_such_project" });
    expect(hub.list()).toEqual([]);
  });

  it("creates a published session owned by the account, noted as started from iPhone", async () => {
    setProjectTrusted(root, true);
    const { command, hub } = await server();
    const r = await command({ action: "create", projectId: projectIdOf(root, SALT), title: "Fix it", mode: "plan" });
    expect(r.body.status).toBe("done");
    const s = hub.peek(r.body.data.sessionId)!;
    expect(s).toMatchObject({ ownerAccount: ACCOUNT, published: true, origin: "remote", mode: "plan", title: "Fix it" });
    expect(s.transcript.map((t) => t.content)).toEqual(["Started from iPhone"]);
    expect((await command({ action: "settings", sessionId: s.id, mode: "auto" })).body).toMatchObject({ status: "refused", error: "auto_on_mac" });
    expect(hub.peek(s.id)!.mode).toBe("plan");
    // Full access is turned on from the Mac only, like Auto.
    expect((await command({ action: "settings", sessionId: s.id, mode: "full" })).body).toMatchObject({ status: "refused", error: "full_on_mac" });
    expect((await command({ action: "create", projectId: projectIdOf(root, SALT), mode: "full" })).body).toMatchObject({ status: "refused", error: "full_on_mac" });
    expect(hub.peek(s.id)!.mode).toBe("plan");
    expect(hub.list()).toHaveLength(1);
  });
});

describe("what the phone sees", () => {
  it("only the account's own phone-started or published sessions in trusted folders, with no paths", async () => {
    setProjectTrusted(root, true);
    const { app, command, hub } = await server([
      { content: "", toolCalls: [{ name: "read_file", arguments: { path: join(root, "a.txt") } }] },
      { content: `Looked at ${root}/a.txt and ${homedir()}/notes.`, toolCalls: [] },
    ]);
    const DESK = { clientId: "d1", kind: "desktop" as const };
    const mine = (await command({ action: "create", projectId: projectIdOf(root, SALT) })).body.data.sessionId as string;
    hub.create({ projectRoot: root, client: DESK, ownerAccount: ACCOUNT }); // not published: stays on the Mac
    const other = hub.create({ projectRoot: root, client: DESK, ownerAccount: "acct_other" });
    hub.publish(other.id, true, DESK);
    expect((await command({ action: "message", sessionId: mine, text: "look" })).body.status).toBe("done");
    await hub.idle(mine);
    const snap = (await app.inject({ method: "GET", url: `/v1/ide/code/remote/snapshot?account=${ACCOUNT}` })).json();
    expect(snap.sessions.map((s: { id: string }) => s.id)).toEqual([mine]);
    expect(snap.projects).toHaveLength(1);
    const one = (await command({ action: "snapshot", sessionId: mine })).body.data as RemoteSessionSnapshot;
    expect(one.tail.at(-1)?.content).toBe("Looked at <project>/a.txt and ~/notes.");
    // The step detail keeps the platform separator (Windows: <project>\a.txt).
    expect(one.tail.at(-1)?.steps?.[0]).toMatchObject({ tool: "read_file", detail: expect.stringMatching(/^<project>[\\/]a\.txt$/) });
    for (const text of [JSON.stringify(snap), JSON.stringify(one), JSON.stringify((await command({ action: "messages", sessionId: mine })).body)]) {
      expect(text).not.toContain(tmp);
      expect(text).not.toContain(homedir());
    }
    expect((await command({ action: "snapshot", sessionId: other.id })).body).toMatchObject({ status: "refused", error: "no_such_session" });
    // Untrusting the folder hides its sessions.
    setProjectTrusted(root, false);
    expect((await command({ action: "snapshot", sessionId: mine })).body).toMatchObject({ status: "refused", error: "no_such_session" });
  });
});

describe("remote turns", () => {
  it("ask for `npm test` even with an always rule, run `ls`, and ignore always on approve", async () => {
    setProjectTrusted(root, true);
    const { command, hub } = await server([
      { content: "", toolCalls: [{ name: "run_shell", arguments: { command: "npm test" } }] },
      { content: "", toolCalls: [{ name: "run_shell", arguments: { command: "ls" } }] },
      { content: "done", toolCalls: [] },
    ]);
    const id = (await command({ action: "create", projectId: projectIdOf(root, SALT), mode: "auto-edits" })).body.data.sessionId as string;
    const s = hub.peek(id)!;
    hub.permissions.addRule(s.projectRoot, "npm test:*");
    root = s.projectRoot;
    // The same call from the Mac runs on the rule; from the phone it asks.
    expect(hub.decide(s, "run_shell", { command: "npm test" }, { clientId: "d", kind: "desktop" }).action).toBe("run");
    expect(hub.decide(s, "run_shell", { command: "npm test" }, phoneClient(ACCOUNT)).action).toBe("ask");
    expect(hub.decide(s, "run_shell", { command: "ls" }, phoneClient(ACCOUNT)).action).toBe("run");
    expect(hub.decide(s, "run_shell", { command: "cat ~/.ssh/config" }, phoneClient(ACCOUNT)).action).toBe("refuse");
    expect(hub.decide(s, "write_file", { path: "../outside.txt", content: "x" }, phoneClient(ACCOUNT)).action).toBe("refuse");
    expect(hub.decide(s, "write_file", { path: "inside.txt", content: "x" }, phoneClient(ACCOUNT)).action).toBe("run");

    await command({ action: "message", sessionId: id, text: "test it" });
    await until(() => hub.snapshot(id).pending.length === 1, 5000, "npm test to ask");
    const snap = (await command({ action: "snapshot", sessionId: id })).body.data as RemoteSessionSnapshot;
    expect(snap.pending[0]).toMatchObject({ tool: "run_shell", command: "npm test", approvable: true });
    const rulesBefore = hub.permissions.get(root).rules;
    // Even if a client asks for "always", the phone's answer covers this call only.
    expect(hub.approve(id, snap.pending[0].callId, true, phoneClient(ACCOUNT), true)).toBe(true);
    await hub.idle(id);
    expect(hub.permissions.get(root).rules).toEqual(rulesBefore);
    expect(hub.peek(id)!.alwaysShell).toEqual([]);
    expect(hub.peek(id)!.mode).toBe("auto-edits");
    // `ls` ran without asking.
    const asked = hub.peek(id)!.transcript.flatMap((t) => t.events ?? []).filter((e) => e.type === "tool_call").map((e) => [(e as { args: { command: string } }).args.command, (e as { requires_approval?: boolean }).requires_approval]);
    expect(asked).toEqual([["npm test", true], ["ls", false]]);
  });

  it("a command too long to check on the phone can only be denied there", async () => {
    setProjectTrusted(root, true);
    const long = `npm run build -- ${"a".repeat(MAX_APPROVABLE_COMMAND_BYTES + 10)}`;
    const { command, hub } = await server([{ content: "", toolCalls: [{ name: "run_shell", arguments: { command: long } }] }, { content: "ok", toolCalls: [] }]);
    const id = (await command({ action: "create", projectId: projectIdOf(root, SALT) })).body.data.sessionId as string;
    await command({ action: "message", sessionId: id, text: "go" });
    await until(() => hub.snapshot(id).pending.length === 1, 5000, "the long command to ask");
    const p = ((await command({ action: "snapshot", sessionId: id })).body.data as RemoteSessionSnapshot).pending[0];
    expect(p.approvable).toBe(false);
    expect(Buffer.byteLength(p.command ?? "")).toBeLessThanOrEqual(MAX_APPROVABLE_COMMAND_BYTES);
    expect((await command({ action: "approve", sessionId: id, callId: p.callId, approved: true })).body).toMatchObject({ status: "refused", error: "approve_on_mac" });
    expect(hub.snapshot(id).pending).toHaveLength(1);
    expect((await command({ action: "approve", sessionId: id, callId: p.callId, approved: false })).body.status).toBe("done");
    await hub.idle(id);
  });
});

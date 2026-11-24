import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatFn } from "../../src/apps/ide/agent-loop.js";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { registerCodeRemoteRoutes, type RemoteSessionSnapshot } from "../../src/apps/ide/code-remote.js";
import { COST_CHECK_TOOL, firstCostAnswer } from "../../src/apps/ide/cost-guard.js";
import { desktopTurnFor, registerDesktopChatRoutes } from "../../src/apps/ide/desktop-chats.js";
import { SessionHub } from "../../src/apps/ide/sessions.js";
import { ToolExecutor } from "../../src/apps/ide/tool-executor.js";
import { makeHub, until } from "../helpers/sessions.js";

/*
 * The cost check in sessions (a phone or terminal turn) and on the phone for a desktop chat's turn:
 * an approval-style item the phone answers Keep going (approve) or Stop (deny).
 */
const ACCOUNT = "acct_owner";
let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cost-guard-"));
  process.env.EDGECODER_TRUST_FILE = join(tmp, "trusted.json");
  root = join(tmp, "proj");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
});
afterEach(() => {
  delete process.env.EDGECODER_TRUST_FILE;
  delete process.env.EDGECODER_REPLY_COST_ASK_CSATS;
  rmSync(tmp, { recursive: true, force: true });
});

/** A hub whose model spends 40 cSats a call and reads a.ts for `steps` calls. */
function spendingHub(steps: number) {
  let calls = 0;
  const hub = new SessionHub(
    {
      chat: (_s, emit): ChatFn => async (_req, onDelta) => {
        calls++;
        emit({ type: "usage", cSats: 40, where: "Network" });
        if (calls > steps) {
          onDelta?.("Done.");
          return { content: "Done.", toolCalls: [] };
        }
        return { content: "", toolCalls: [{ name: "read_file", arguments: { path: "a.ts" } }] };
      },
      systemPrompt: async () => () => "system",
      executor: (s) => {
        const ex = new ToolExecutor(s.projectRoot);
        return { execute: (tool, args, o) => ex.execute(tool, args, o) };
      },
      checkpoints: new CheckpointStore(),
      branch: () => "main",
    },
    { dir: null, permissionsFile: null },
  );
  return { hub, calls: () => calls };
}

describe("session turns", () => {
  it("a network lead pauses past the threshold; Keep going from any client carries on", async () => {
    process.env.EDGECODER_REPLY_COST_ASK_CSATS = "100";
    const { hub, calls } = spendingHub(4);
    const s = hub.create({ projectRoot: root, model: "network/glm-5.3", mode: "auto-edits", client: { clientId: "t", kind: "terminal" } });
    hub.send(s.id, "explore", { clientId: "t", kind: "terminal" });
    await until(() => hub.snapshot(s.id).pending.length === 1, 5000, "the cost check");
    // 3 calls (120 cSats) before the ask; nothing more is spent while it waits.
    expect(calls()).toBe(3);
    const p = hub.snapshot(s.id).pending[0];
    // Tokens: the backend's counts, else the loop's estimates.
    expect(p).toMatchObject({ tool: COST_CHECK_TOOL, args: { question: expect.stringMatching(/^This reply has used 120 cSats \(read [\d.]+K tokens, wrote \d+\)\.$/) } });
    // No Switch from a session turn (only the desktop chat carries it).
    expect(p.args.suggest).toBeUndefined();
    expect(hub.approve(s.id, p.id, true, { clientId: "phone", kind: "remote" })).toBe(true);
    await until(() => !hub.snapshot(s.id).running, 5000, "the turn to end");
    expect(calls()).toBe(5);
    expect(hub.peek(s.id)!.transcript.at(-1)!.content).toContain("Done.");
  });

  it("Stop ends the reply with a note; an 'always' answer never sticks to a cost check", async () => {
    process.env.EDGECODER_REPLY_COST_ASK_CSATS = "100";
    const { hub, calls } = spendingHub(10);
    const s = hub.create({ projectRoot: root, model: "network/glm-5.3", mode: "auto-edits", client: { clientId: "t", kind: "terminal" } });
    hub.send(s.id, "explore", { clientId: "t", kind: "terminal" });
    await until(() => hub.snapshot(s.id).pending.length === 1, 5000, "the cost check");
    const p = hub.snapshot(s.id).pending[0];
    expect(hub.approve(s.id, p.id, false, { clientId: "t", kind: "terminal" }, true)).toBe(true);
    await until(() => !hub.snapshot(s.id).running, 5000, "the turn to end");
    expect(calls()).toBe(3);
    expect(hub.peek(s.id)!.transcript.at(-1)!.content).toMatch(/Stopped to save cost after 120 cSats/);
    expect(hub.peek(s.id)!.alwaysShell).toEqual([]);
  });

  it("a free lead (this computer) never asks", async () => {
    process.env.EDGECODER_REPLY_COST_ASK_CSATS = "100";
    const { hub, calls } = spendingHub(4);
    const s = hub.create({ projectRoot: root, model: "qwen3:8b", mode: "auto-edits", client: { clientId: "t", kind: "terminal" } });
    hub.send(s.id, "explore", { clientId: "t", kind: "terminal" });
    await until(() => !hub.snapshot(s.id).running && hub.peek(s.id)!.transcript.length === 2, 5000, "the turn to end");
    expect(calls()).toBe(5);
    expect(hub.peek(s.id)!.transcript.at(-1)!.events?.some((e) => (e as { tool?: string }).tool === COST_CHECK_TOOL)).toBe(false);
  });
});

describe("a desktop chat's cost check on the phone (the relay)", () => {
  async function server() {
    const { hub, checkpoints } = makeHub([], { owner: ACCOUNT });
    const app = Fastify();
    registerDesktopChatRoutes(app, hub);
    registerCodeRemoteRoutes(app, hub, { account: async () => ACCOUNT, checkpoints, machineSalt: () => "salt", branch: () => "main" });
    await app.ready();
    const command = async (body: Record<string, unknown>) => {
      const r = await app.inject({ method: "POST", url: "/v1/ide/code/remote/command", payload: { requestedBy: ACCOUNT, ...body } });
      return r.json() as { status: string; error?: string; data?: unknown };
    };
    const chat = randomUUID();
    const sync = await app.inject({ method: "POST", url: "/v1/ide/code-chats/sync", payload: { chatId: chat, projectRoot: root, mode: "plan", messages: [{ id: randomUUID(), role: "user", content: "explore", at: Date.now() }] } });
    return { hub, command, chat, sessionId: (sync.json() as { sessionId: string }).sessionId };
  }

  it("shows as an approvable item with the question (even in plan mode); approve is Keep going", async () => {
    const { hub, command, chat, sessionId } = await server();
    const turn = desktopTurnFor(hub, chat, randomUUID(), new AbortController())!;
    const args = { question: "This reply has used 160 cSats (read 210K tokens, wrote 3K).", switchLabel: "Switch to DeepSeek V4.1 Flash (~5× cheaper)" };
    const answer = firstCostAnswer("cost_1", args, turn, () => {}, () => {}, 60_000);
    const snap = (await command({ action: "snapshot", sessionId })).data as RemoteSessionSnapshot;
    expect(snap.pending).toEqual([expect.objectContaining({ callId: "cost_1", tool: "cost_check", detail: args.question, approvable: true })]);
    expect((await command({ action: "approve", sessionId, callId: "cost_1", approved: true })).status).toBe("done");
    expect(await answer).toBe("continue");
    turn.end();
  });

  it("deny from the phone is Stop; the app answering first clears the phone's item", async () => {
    const { hub, command, chat, sessionId } = await server();
    const turn = desktopTurnFor(hub, chat, randomUUID(), new AbortController())!;
    const phone = firstCostAnswer("cost_2", { question: "q" }, turn, () => {}, () => {}, 60_000);
    expect((await command({ action: "approve", sessionId, callId: "cost_2", approved: false })).status).toBe("done");
    expect(await phone).toBe("stop");
    let app!: { choose: (c: "continue" | "switch" | "stop") => void };
    const desk = firstCostAnswer("cost_3", { question: "q" }, turn, (a) => (app = a), () => {}, 60_000);
    expect(hub.snapshot(sessionId).pending).toHaveLength(1);
    app.choose("switch");
    expect(await desk).toBe("switch");
    expect(hub.snapshot(sessionId).pending).toHaveLength(0);
    turn.end();
  });
});

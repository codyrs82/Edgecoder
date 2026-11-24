// "Allow for the rest of this run" through the real approval paths: a bot run (BotManager.approve)
// and a desktop chat turn mirrored to the phone (SessionHub). The phone answers one call only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatFn } from "../../src/apps/ide/agent-loop.js";
import { BotManager, agentBotRunner } from "../../src/apps/ide/bots.js";
import { phoneClient } from "../../src/apps/ide/code-remote.js";
import type { ClientRef } from "../../src/apps/ide/sessions.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";
import { WebToolSession, type WebToolCall } from "../../src/web-tool/tools.js";
import { makeHub, until } from "../helpers/sessions.js";

const DESK: ClientRef = { clientId: "desk-1", kind: "desktop", label: "EdgeCoder app" };
const WATCHLIST = 'python3 tools/watchlist.py SPY 2>&1 | head -20; echo "exit=$?"';

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Trader Boy (an Auto bot that reads market pages)", () => {
  const webCall: WebToolCall = async (_path, body) => ({ status: 200, json: { url: String(body.url), title: "Markets", text: "SPY up 1%.", cSats: 0.2 } });

  function traderBoy() {
    const root = tmp("trader-boy-");
    mkdirSync(join(root, "tools"));
    mkdirSync(join(root, "market-notes"));
    writeFileSync(join(root, "tools", "watchlist.py"), "print('ok')\n");
    writeFileSync(join(root, "market-notes", "2026-11-24.md"), "a\n");
    const call = (name: string, args: Record<string, unknown>) => ({ content: "", toolCalls: [{ name, arguments: args }] });
    const replies: Array<Awaited<ReturnType<ChatFn>>> = [
      call("read_page", { url: "https://markets.example/today" }),
      call("edit_file", { path: "market-notes/2026-11-24.md", old_string: "a", new_string: "b" }),
      call("write_file", { path: "portfolio.md", content: "# Portfolio" }),
      call("run_shell", { command: "python3 tools/watchlist.py --md" }),
      call("run_shell", { command: WATCHLIST }),
      call("run_shell", { command: "python3 tools/watchlist.py QQQ" }),
      { content: "Notes updated.", toolCalls: [] },
    ];
    const executed: string[] = [];
    const runner = agentBotRunner({
      chat: () => async () => replies.shift() ?? { content: "done", toolCalls: [] },
      execute: () => async (tool, args) => {
        executed.push(tool === "run_shell" ? String(args.command) : tool);
        return tool === "run_shell" ? { result: JSON.stringify({ stdout: "ok", stderr: "", exit_code: 0 }) } : { result: `ran ${tool}` };
      },
      systemPrompt: async () => () => "BASE",
      web: (ctx) => new WebToolSession({ call: webCall, emit: ctx.sendEvent, signal: ctx.signal }),
    });
    const m = new BotManager({ runner, file: join(tmp("bots-"), "bots.json") });
    managers.push(m);
    const bot = m.create({ name: "Trader Boy", projectRoot: root, allowedTools: ["read_file", "edit_file", "write_file", "run_shell", "web_search", "read_page"], mode: "auto" });
    return { m, bot, root, executed };
  }

  const waitPending = async (m: BotManager, id: string) => {
    await until(() => m.get(id).pending.length > 0 || m.get(id).status !== "running", 5000, "a pending call");
    return m.get(id).pending[0];
  };
  const callEvent = (m: BotManager, id: string, callId: string) =>
    (m.messages(id).at(-1)?.events ?? []).find((e) => e.type === "tool_call" && (e as { id: string }).id === callId) as Extract<IdeStreamEvent, { type: "tool_call" }>;

  it("edits apply; Always allow keeps the script's rule; one 'rest of this run' answer covers the rest", async () => {
    const { m, bot, executed } = traderBoy();
    m.runNow(bot.id);
    // 1. python3 tools/watchlist.py --md: Auto asks (an unlisted program), offering its script's rule.
    const first = await waitPending(m, bot.id);
    expect(first.args.command).toBe("python3 tools/watchlist.py --md");
    // The edit and the write after the page read already applied without asking.
    expect(executed.slice(0, 2)).toEqual(["edit_file", "write_file"]);
    expect(callEvent(m, bot.id, first.callId)).toMatchObject({ allow_rule: "python3 tools/watchlist.py:*" });
    expect(callEvent(m, bot.id, first.callId).web_guard).toBeUndefined();
    expect(m.approve(bot.id, first.callId, true, true)).toBe(true);
    expect(m.permissions.get(m.get(bot.id).projectRoot).rules).toEqual(["python3 tools/watchlist.py:*"]);
    // 2. The compound command: the rule covers it, so only the web-page guard asks.
    const second = await waitPending(m, bot.id);
    expect(second.args.command).toBe(WATCHLIST);
    expect(callEvent(m, bot.id, second.callId)).toMatchObject({ web_guard: true });
    expect(m.approve(bot.id, second.callId, true, false, true)).toBe(true);
    // 3. The next watchlist call runs without asking for the rest of this run.
    await m.idle(bot.id);
    expect(executed).toEqual(["edit_file", "write_file", "python3 tools/watchlist.py --md", WATCHLIST, "python3 tools/watchlist.py QQQ"]);
  });
});

describe("a desktop chat turn mirrored to the phone", () => {
  function mirrored() {
    const root = tmp("mirror-proj-");
    const { hub } = makeHub([], { dir: null });
    const s = hub.create({ projectRoot: root, client: DESK });
    hub.update(s.id, { mode: "auto-edits" }, DESK);
    const turn = hub.beginDesktopTurn(s.id, "turn-1", new AbortController())!;
    return { hub, s, turn };
  }

  it("the phone's answer to a guard ask is one call only; the app's can cover the run", async () => {
    const { hub, s, turn } = mirrored();
    const phone = turn.ask("tc_1", "run_shell", { command: "npm test" }, { webGuard: true });
    expect(hub.approve(s.id, "tc_1", true, phoneClient("acct_1"), true, true)).toBe(true);
    expect(await phone).toBe(true);
    const app = turn.ask("tc_2", "run_shell", { command: "npm test" }, { webGuard: true });
    expect(hub.approve(s.id, "tc_2", true, DESK, false, true)).toBe(true);
    expect(await app).toBe("run");
    turn.end();
  });

  it("a mode change releases a guard ask only into Full access", async () => {
    const { hub, s, turn } = mirrored();
    let answer: unknown = "waiting";
    void turn.ask("tc_1", "edit_file", { path: "a.md", old_string: "a", new_string: "b" }, { webGuard: true }).then((a) => (answer = a));
    hub.update(s.id, { mode: "auto" }, DESK);
    await new Promise((r) => setTimeout(r, 20));
    expect(answer).toBe("waiting");
    expect(hub.snapshot(s.id).pending.map((p) => p.id)).toEqual(["tc_1"]);
    hub.update(s.id, { mode: "full" }, DESK);
    await until(() => answer === true, 2000, "the release");
    turn.end();
  });
});

// #525: not on a terminal, an approval is printed as its own line and the session is shown live in
// the app, so the pending call reaches the desktop and web through the normal session events.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientRef } from "../../src/apps/ide/sessions.js";
import { ProviderClient } from "../../src/terminal/client.js";
import { makeStyle } from "../../src/terminal/render.js";
import { Repl, type ReplIO } from "../../src/terminal/repl.js";
import { makeHub, sessionServer, until } from "../helpers/sessions.js";

const TERM: ClientRef = { clientId: "term-headless", kind: "terminal", label: "Terminal" };
const DESK: ClientRef = { clientId: "desk-headless", kind: "desktop", label: "EdgeCoder app" };

let root: string;
let cleanup: Array<() => Promise<unknown> | void> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repl-headless-"));
  writeFileSync(join(root, "hello.txt"), "hello\nworld\n");
});
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
  rmSync(root, { recursive: true, force: true });
});

/** A piped stdin/stdout: prompts are written once, never redrawn (no setPrompt). */
function pipedIO(interactive: boolean) {
  let output = "";
  const waiters: Array<(l: string | null) => void> = [];
  const queued: Array<string | null> = [];
  const io: ReplIO = {
    interactive,
    readLine(prompt) {
      output += prompt;
      if (queued.length) return Promise.resolve(queued.shift()!);
      return new Promise((r) => waiters.push(r));
    },
    write(t) {
      output += t;
    },
  };
  const feed = (l: string | null) => {
    const w = waiters.shift();
    if (w) w(l);
    else queued.push(l);
  };
  return { io, out: () => output, feed };
}

async function start(interactive: boolean) {
  const { hub } = makeHub([
    { content: "Updating.", toolCalls: [{ name: "edit_file", arguments: { path: "hello.txt", old_string: "world", new_string: "EdgeCoder" } }] },
    { content: "Done.", toolCalls: [] },
  ]);
  const { app, url } = await sessionServer(hub);
  cleanup.push(() => app.close());
  const term = new ProviderClient(url, "unused", TERM);
  const snap = await term.createSession({ projectRoot: root, model: "network/qwen3-coder:30b" });
  const t = pipedIO(interactive);
  const repl = new Repl({ client: term, sessionId: snap.session.id, io: t.io, style: makeStyle(false), providerLabel: "test provider" });
  const done = repl.run();
  return { hub, t, done, id: snap.session.id };
}

describe("approvals off a terminal", () => {
  it("prints the approval as a line, shows the session in the app, and the app's answer goes through", async () => {
    const { hub, t, done, id } = await start(false);
    await until(() => t.out().includes("Type a request"), 5000, "header");
    t.feed("change world to EdgeCoder");
    await until(() => t.out().includes("Approval needed: allow edit_file(hello.txt)?"), 5000, "approval line");
    await until(() => t.out().includes("the session is now shown live in the EdgeCoder app"), 5000, "remote on");
    expect(hub.snapshot(id).session.published).toBe(true);
    // The desktop sees the pending call in the session and answers it.
    const pending = hub.snapshot(id).pending;
    expect(pending.map((p) => p.tool)).toEqual(["edit_file"]);
    hub.approve(id, pending[0].id, true, DESK);
    await until(() => t.out().includes("Done."), 5000, "reply");
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello\nEdgeCoder\n");
    t.feed(null);
    expect(await done).toBe(0);
  });

  it("on a terminal the prompt line asks, and nothing is published", async () => {
    const { hub, t, done, id } = await start(true);
    await until(() => t.out().includes("Type a request"), 5000, "header");
    t.feed("change world to EdgeCoder");
    await until(() => hub.snapshot(id).pending.length === 1, 5000, "pending");
    await new Promise((r) => setTimeout(r, 100));
    expect(t.out()).not.toContain("Approval needed");
    expect(hub.snapshot(id).session.published).toBe(false);
    hub.approve(id, hub.snapshot(id).pending[0].id, false, DESK);
    t.feed(null);
    expect(await done).toBe(0);
  });
});

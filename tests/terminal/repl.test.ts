import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientRef } from "../../src/apps/ide/sessions.js";
import { ProviderClient } from "../../src/terminal/client.js";
import { initialModel, parseCodeArgs } from "../../src/terminal/cli.js";
import { lineDiff, makeStyle } from "../../src/terminal/render.js";
import { placeModel, Repl, withPlacement, type ReplIO } from "../../src/terminal/repl.js";
import { makeHub, sessionServer, until, type Reply } from "../helpers/sessions.js";

const TERM: ClientRef = { clientId: "term-test", kind: "terminal", label: "Terminal" };
const DESK: ClientRef = { clientId: "desk-test", kind: "desktop", label: "EdgeCoder app" };

/** Input fed by the test; every prompt and line written is kept. */
function testIO() {
  let output = "";
  const prompts: string[] = [];
  const queued: Array<string | null> = [];
  const waiters: Array<(l: string | null) => void> = [];
  const io: ReplIO = {
    readLine(prompt) {
      prompts.push(prompt);
      if (queued.length) return Promise.resolve(queued.shift()!);
      return new Promise((r) => waiters.push(r));
    },
    write(t) {
      output += t;
    },
  };
  return {
    io,
    prompts,
    out: () => output,
    feed(line: string | null) {
      const w = waiters.shift();
      if (w) w(line);
      else queued.push(line);
    },
    waitingForInput: () => waiters.length > 0,
  };
}

let root: string;
let cleanup: Array<() => Promise<unknown> | void> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repl-proj-"));
  writeFileSync(join(root, "hello.txt"), "hello\nworld\n");
});
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
  rmSync(root, { recursive: true, force: true });
});

async function setup(replies: Reply[], opts: { model?: string } = {}) {
  const { hub, model } = makeHub(replies);
  const { app, url } = await sessionServer(hub);
  cleanup.push(() => app.close());
  const term = new ProviderClient(url, "unused", TERM);
  const snap = await term.createSession({ projectRoot: root, model: opts.model ?? "network/qwen3-coder:30b" });
  const t = testIO();
  const repl = new Repl({ client: term, sessionId: snap.session.id, io: t.io, style: makeStyle(false), providerLabel: "test provider" });
  return { hub, model, url, term, t, repl, id: snap.session.id };
}

describe("edgecoder code arguments", () => {
  it("parses the options and picks the starting model", () => {
    expect(parseCodeArgs(["--repo", "https://github.com/codyrs82/Edgecoder", "--remote", "--compute", "network"])).toMatchObject({ repo: "https://github.com/codyrs82/Edgecoder", remote: true, compute: "network" });
    expect(parseCodeArgs(["a", "b"])).toEqual({ error: expect.stringContaining("one folder") });
    expect(parseCodeArgs(["--compute", "moon"])).toEqual({ error: expect.stringContaining("--compute") });
    expect(initialModel({ compute: "network" })).toBe("network/qwen3-coder:30b");
    expect(initialModel({ compute: "local" }, { OLLAMA_MODEL: "x:1b" })).toBe("x:1b");
    expect(initialModel({ model: "mine/m" })).toBe("mine/m");
    expect(initialModel({})).toBe("auto");
    expect(withPlacement("qwen3-coder:30b", "network/other")).toBe("network/qwen3-coder:30b");
    expect(withPlacement("qwen3.5:9b", "qwen2.5-coder:7b")).toBe("qwen3.5:9b");
    expect(placeModel("network/qwen3-coder:30b@gpu", "local")).toBe("qwen3-coder:30b");
    expect(placeModel("auto", "network")).toBe("network/qwen3-coder:30b");
    expect(placeModel("qwen3.5:9b", "auto")).toBe("auto");
  });

  it("line diffs mark removed and added lines with context", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\n", 1)).toEqual(["a", "-b", "+B", "c"].map((l, i) => (i === 0 || i === 3 ? ` ${l}` : l)));
  });
});

describe("the terminal REPL (scripted model)", () => {
  it("streams the reply, shows the diff, asks inline, and applies the approved edit", async () => {
    const { t, repl, hub, id } = await setup([
      { content: "I'll update it.", toolCalls: [{ name: "edit_file", arguments: { path: "hello.txt", old_string: "world", new_string: "EdgeCoder" } }] },
      { content: "Done: hello.txt now greets EdgeCoder.", toolCalls: [] },
    ]);
    const done = repl.run();
    t.feed("change world to EdgeCoder in hello.txt");
    await until(() => t.prompts.some((p) => p.includes("Allow edit_file(hello.txt)")), 5000, "approval prompt");
    expect(t.out()).toContain("● edit_file(hello.txt)");
    expect(t.out()).toContain("-world");
    expect(t.out()).toContain("+EdgeCoder");
    t.feed("y");
    await until(() => t.out().includes("Done: hello.txt now greets EdgeCoder."), 5000, "reply");
    await until(() => t.out().includes("changed hello.txt (/undo reverts)"), 5000, "footer");
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello\nEdgeCoder\n");
    // /undo puts it back
    t.feed("/undo");
    await until(() => t.out().includes("Undid hello.txt"), 5000, "undo");
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello\nworld\n");
    t.feed(null);
    expect(await done).toBe(0);
    // leaving hands control back
    expect(hub.snapshot(id).controller).toBeNull();
  });

  it("n rejects; a (always) approves this and later edits; slash commands work", async () => {
    const { t, repl, hub, id } = await setup([
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "x.txt", content: "x\n" } }] },
      { content: "Rejected, fine.", toolCalls: [] },
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "y.txt", content: "y\n" } }] },
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "z.txt", content: "z\n" } }] },
      { content: "Wrote y and z.", toolCalls: [] },
    ]);
    const done = repl.run();
    t.feed("write x");
    await until(() => t.prompts.some((p) => p.includes("write_file(x.txt)")));
    expect(t.out()).toContain("+x");
    t.feed("maybe");
    t.feed("n");
    await until(() => t.out().includes("Rejected, fine."));
    t.feed("write y and z");
    await until(() => t.prompts.some((p) => p.includes("write_file(y.txt)")));
    t.feed("a");
    await until(() => t.out().includes("Wrote y and z."));
    expect(t.prompts.some((p) => p.includes("write_file(z.txt)"))).toBe(false);
    expect(readFileSync(join(root, "z.txt"), "utf8")).toBe("z\n");

    for (const cmd of ["/help", "/model", "/model qwen2.5-coder:latest", "/compute local", "/compute auto", "/cost", "/status", "/remote", "/nope"]) t.feed(cmd);
    await until(() => t.out().includes("Unknown command /nope"), 5000, "commands");
    const out = t.out();
    expect(out).toContain("/compute [local|network|mine|auto]");
    expect(out).toContain("model: network/qwen3-coder:30b");
    expect(out).toContain("▸ model: network/qwen2.5-coder:latest");
    expect(out).toContain("▸ compute: local · model: qwen2.5-coder:latest");
    expect(out).toContain("▸ compute: auto · model: auto");
    expect(out).toContain("This session has spent 0 cSats.");
    expect(out).toMatch(/control {2}you/);
    expect(out).toContain("Remote control on.");
    expect(hub.snapshot(id).session.published).toBe(true);
    expect(hub.snapshot(id).session.model).toBe("auto");
    t.feed("/clear");
    await until(() => t.out().includes("conversation was cleared"));
    t.feed("/exit");
    expect(await done).toBe(0);
  });
});

describe("remote control: the desktop attaches to a terminal session", () => {
  it("sees it live, takes control, sends and approves; the terminal mirrors it and can take control back", async () => {
    const { t, repl, url, id } = await setup([
      { content: "From the terminal.", toolCalls: [] },
      { content: "Writing from the app's request.", toolCalls: [{ name: "write_file", arguments: { path: "app.txt", content: "app\n" } }] },
      { content: "All done.", toolCalls: [] },
      { content: "Back in the terminal.", toolCalls: [] },
    ]);
    const done = repl.run();
    t.feed("hello");
    await until(() => t.out().includes("From the terminal."));
    t.feed("/remote");
    await until(() => t.out().includes("Remote control on."));

    // The desktop app: list live sessions, follow one, take control.
    const desk = new ProviderClient(url, "unused", DESK);
    const live = await desk.listSessions("?published=1");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id, projectRoot: root, live: true, published: true, origin: "terminal" });
    const snap = await desk.snapshot(id);
    expect(snap.session.transcript.map((e) => e.content)).toEqual(["hello", "From the terminal."]);
    const seen: Array<{ type: string; [k: string]: unknown }> = [];
    const follow = desk.follow(id, snap.seq, (e) => seen.push(e));
    cleanup.push(() => follow.close());
    await until(() => t.out().includes("EdgeCoder app is following this session."), 5000, "presence");

    // The terminal can't be overtaken silently: the app must take control first.
    await expect(desk.send(id, "nope")).rejects.toThrow(/in control/);
    await desk.takeControl(id);
    await until(() => t.out().includes("EdgeCoder app took control"), 5000, "control notice");

    await desk.send(id, "write app.txt");
    await until(() => seen.some((e) => e.type === "agent" && (e.event as { type: string; requires_approval?: boolean }).requires_approval === true), 5000, "approval event");
    // The terminal shows the request and the diff, and waits for the app.
    await until(() => t.out().includes("waiting for EdgeCoder app to approve"), 5000, "mirror");
    expect(t.out()).toContain("› [desktop] write app.txt");
    expect(t.out()).toContain("+app");
    const pending = (await desk.snapshot(id)).pending;
    await desk.approve(id, pending[0].id, true);
    await until(() => t.out().includes("All done."), 5000, "mirrored reply");
    expect(t.out()).toContain("✓ approved (desktop)");
    expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("app\n");
    const streamed = seen.filter((e) => e.type === "agent" && (e.event as { type: string }).type === "text").map((e) => (e.event as { content: string }).content).join("");
    expect(streamed).toContain("All done.");

    // Typing in the terminal while the app is in control is refused with a hint; /take takes it back.
    t.feed("are you there?");
    await until(() => t.out().includes("/take to take it back"));
    t.feed("/take");
    await until(() => seen.some((e) => e.type === "control" && (e.controller as ClientRef | null)?.clientId === TERM.clientId), 5000, "take back");
    t.feed("and now?");
    await until(() => t.out().includes("Back in the terminal."));
    expect(seen.some((e) => e.type === "message" && (e.entry as { content: string }).content === "and now?")).toBe(true);
    t.feed("/exit");
    await done;
  });
});

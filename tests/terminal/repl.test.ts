import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientRef } from "../../src/apps/ide/sessions.js";
import { ProviderClient } from "../../src/terminal/client.js";
import { initialModel, parseCodeArgs } from "../../src/terminal/cli.js";
import { clean, lineDiff, makeStyle, usageLine } from "../../src/terminal/render.js";
import { placeModel, Repl, withPlacement, type ReplIO } from "../../src/terminal/repl.js";
import { makeHub, sessionServer, until, type Reply } from "../helpers/sessions.js";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { SessionHub } from "../../src/apps/ide/sessions.js";
import { ToolExecutor } from "../../src/apps/ide/tool-executor.js";

const TERM: ClientRef = { clientId: "term-test", kind: "terminal", label: "Terminal" };
const DESK: ClientRef = { clientId: "desk-test", kind: "desktop", label: "EdgeCoder app" };

/** Input fed by the test; every prompt and line written is kept. */
function testIO() {
  let output = "";
  const prompts: string[] = [];
  const queued: Array<string | null> = [];
  const waiters: Array<(l: string | null) => void> = [];
  let key: ((k: "escape" | "shift-tab") => void) | null = null;
  let current = "";
  const io: ReplIO = {
    readLine(prompt) {
      prompts.push(prompt);
      current = prompt;
      if (queued.length) return Promise.resolve(queued.shift()!);
      return new Promise((r) => waiters.push(r));
    },
    setPrompt(prompt) {
      if (prompt !== current) prompts.push(prompt);
      current = prompt;
    },
    write(t) {
      output += t;
    },
    onKey(fn) {
      key = fn;
    },
  };
  return {
    io,
    prompts,
    /** The prompt shown right now. */
    prompt: () => current,
    press: (k: "escape" | "shift-tab") => key?.(k),
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
    expect(parseCodeArgs(["--mode", "full"])).toMatchObject({ mode: "full" });
    expect(parseCodeArgs(["--mode", "yolo"])).toEqual({ error: expect.stringContaining("plan or full") });
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
    await until(() => t.prompt().includes("Allow edit_file(hello.txt)? [Y/n/a]"), 5000, "approval prompt");
    expect(t.out()).toContain("● edit_file(hello.txt)");
    expect(t.out()).toContain("-world");
    expect(t.out()).toContain("+EdgeCoder");
    // Enter means yes.
    t.feed("");
    await until(() => t.out().includes("Done: hello.txt now greets EdgeCoder."), 5000, "reply");
    await until(() => t.out().includes("changed hello.txt (/undo reverts)"), 5000, "footer");
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello\nEdgeCoder\n");
    // /undo puts it back
    t.feed("/undo");
    await until(() => t.out().includes("Undid hello.txt"), 5000, "undo");
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello\nworld\n");
    t.feed(null);
    expect(await done).toBe(0);
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
    t.feed("perhaps");
    t.feed("n");
    await until(() => t.out().includes("Rejected, fine."));
    // The hint for an answer that isn't one is shown once.
    expect(t.out().split("Enter or y = yes, n = no, a = always.").length - 1).toBe(1);
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
    expect(out).toMatch(/mode {5}auto-edits/);
    expect(out).toContain("Remote on.");
    expect(hub.snapshot(id).session.published).toBe(true);
    expect(hub.snapshot(id).session.model).toBe("auto");
    t.feed("/clear");
    await until(() => t.out().includes("conversation was cleared"));
    t.feed("/exit");
    expect(await done).toBe(0);
  });
});

describe("slash commands at an approval prompt", () => {
  it("/remote publishes and the approval keeps waiting; then Enter approves", async () => {
    const { t, repl, hub, id } = await setup([
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "w.txt", content: "w\n" } }] },
      { content: "Wrote it.", toolCalls: [] },
    ]);
    const done = repl.run();
    t.feed("/mode ask");
    t.feed("write w");
    await until(() => t.prompt().includes("Allow write_file(w.txt)"), 5000, "approval");
    t.feed("/remote");
    await until(() => t.out().includes("Remote on."), 5000, "remote");
    expect(hub.snapshot(id).session.published).toBe(true);
    expect(hub.snapshot(id).pending).toHaveLength(1);
    expect(t.prompt()).toContain("Allow write_file(w.txt)");
    expect(t.out()).not.toContain("Enter or y = yes");
    t.feed("");
    await until(() => t.out().includes("Wrote it."), 5000, "reply");
    expect(readFileSync(join(root, "w.txt"), "utf8")).toBe("w\n");
    t.feed("/exit");
    await done;
  });

  it("Shift+Tab cycles the mode and the prompt shows it; Esc stops a running reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { t, repl, hub, id } = await setup([
      async () => {
        await gate;
        return { content: "late", toolCalls: [] };
      },
    ]);
    const done = repl.run();
    await until(() => t.prompt().includes("["), 5000, "prompt");
    const order = ["ask", "auto-edits", "auto"];
    const start = hub.snapshot(id).session.mode ?? "ask";
    const next = order[(order.indexOf(start) + 1) % order.length];
    t.press("shift-tab");
    // Wait on the terminal, not the hub: the hub applies the mode before its answer reaches the
    // REPL, and the REPL redraws the prompt only once that answer is back.
    await until(() => t.prompt().includes(`[${next}]`), 5000, "prompt shows the next mode");
    expect(hub.snapshot(id).session.mode).toBe(next);
    t.feed("something slow");
    await until(() => t.prompt().includes("running"), 5000, "running");
    t.press("escape");
    await until(() => t.out().includes("Stopping…"), 5000, "stop");
    release();
    await hub.idle(id);
    t.feed("/exit");
    await done;
  });
});

describe("co-editing: the desktop and the terminal on one session", () => {
  it("both send at once (queued, labelled), the first answer to an approval wins and the other prompt closes, settings are mirrored", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { t, repl, url, id, hub } = await setup([
      async () => {
        await gate;
        return { content: "From the terminal.", toolCalls: [] };
      },
      { content: "Writing app.txt.", toolCalls: [{ name: "write_file", arguments: { path: "app.txt", content: "app\n" } }] },
      { content: "All done.", toolCalls: [] },
    ]);
    const done = repl.run();
    t.feed("/mode ask");
    await until(() => hub.snapshot(id).session.mode === "ask", 5000, "mode");
    t.feed("hello");
    await until(() => t.prompt().includes("running"), 5000, "running");

    const desk = new ProviderClient(url, "unused", DESK);
    const snap = await desk.snapshot(id);
    const seen: Array<{ type: string; [k: string]: unknown }> = [];
    const follow = desk.follow(id, snap.seq, (e) => seen.push(e));
    cleanup.push(() => follow.close());
    await until(() => t.out().includes("Connected: this terminal and EdgeCoder app"), 5000, "presence");

    // The app sends while the terminal's turn runs: queued and labelled in the terminal; no take-control.
    const r = await desk.send(id, "write app.txt");
    expect(r.turnId).toBeNull();
    await until(() => t.out().includes("Queued from EdgeCoder app: write app.txt"), 5000, "queued notice");
    // The terminal types too: queued behind it.
    t.feed("and then this");
    await until(() => t.out().includes("Queued (#2)"), 5000, "own queue");
    // The app removes the terminal's queued message (anyone may).
    const q = (await desk.snapshot(id)).queue;
    expect(q.map((x) => x.by)).toEqual(["desktop", "terminal"]);
    await desk.unqueue(id, q[1].id);
    release();

    await until(() => t.prompt().includes("Allow write_file(app.txt)"), 5000, "terminal approval prompt");
    expect(t.out()).toContain("› [from EdgeCoder app] write app.txt");
    const pending = (await desk.snapshot(id)).pending;
    expect((await desk.approve(id, pending[0].id, true)).applied).toBe(true);
    // The terminal's prompt closes itself and says who answered.
    await until(() => !t.prompt().includes("Allow"), 5000, "prompt closes");
    await until(() => t.out().includes("✓ approved in EdgeCoder app"), 5000, "who answered");
    // A late answer from the terminal changes nothing.
    expect((await new ProviderClient(url, "unused", TERM).approve(id, pending[0].id, false)).applied).toBe(false);
    await until(() => t.out().includes("All done."), 5000, "reply");
    expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("app\n");

    // Settings from the app show up in the terminal.
    await desk.settings(id, { model: "network/qwen2.5-coder:32b", mode: "auto" });
    await until(() => t.out().includes("EdgeCoder app changed model → network/qwen2.5-coder:32b, mode → auto"), 5000, "settings note");
    expect(t.prompt()).toContain("[auto]");
    t.feed("/take");
    await until(() => t.out().includes("Nothing to take"), 5000, "take is a no-op");
    t.feed("/exit");
    await done;
    expect(seen.some((e) => e.type === "control")).toBe(false);
  });
});

describe("rendering", () => {
  it("strips escape sequences, half sequences, paste markers and carriage returns that left [ and ] at line edges", () => {
    expect(clean("\x1b[31mred\x1b[39m done")).toBe("red done");
    expect(clean("cut here \x1b[3")).toBe("cut here ");
    expect(clean("\x1b[200~pasted\x1b[201~")).toBe("pasted");
    expect(clean("[200~pasted[201~")).toBe("pasted");
    expect(clean("progress 10%\rprogress 100%\r\n")).toBe("progress 10%\nprogress 100%\n");
    expect(clean("\x1b]0;title\x07text")).toBe("text");
    expect(clean("a\u0000b\u0007c")).toBe("abc");
    // Ordinary brackets stay.
    expect(clean("arr[0] = [1, 2]")).toBe("arr[0] = [1, 2]");
  });

  it("a turn's usage line says the model, the hardware, where, tokens, time and cost", () => {
    const line = usageLine([
      { cSats: 1.4, where: "network", model: "qwen3-coder:30b", served: { label: "lin-•••3f2a", own: false, computeClass: "gpu.dc", tier: "gpu.dc40", hardware: "Datacenter GPU (gpu.dc40)", gpu: "2× NVIDIA A16", region: "ord", city: "Chicago", country: "US", promptTokens: 20_000, outputTokens: 200, promptMs: 60_000, genMs: 4_000 } },
      { cSats: 2, where: "network", model: "qwen3-coder:30b", served: { label: "lin-•••3f2a", own: false, computeClass: "gpu.dc", tier: "gpu.dc40", hardware: "Datacenter GPU (gpu.dc40)", gpu: "2× NVIDIA A16", region: "ord", city: "Chicago", country: "US", promptTokens: 4_800, outputTokens: 112, promptMs: 21_000, genMs: 2_500 } },
    ]);
    expect(line).toBe("qwen3-coder:30b · Datacenter GPU 2×A16 · Chicago · read 24.8k tok in 81 s · wrote 312 tok in 6.5 s · 2 calls · 3.4 cSats");
    expect(usageLine([{ cSats: 0, where: "x", model: "qwen3.5:9b", served: { label: "This computer", own: true, computeClass: "local", tier: null, hardware: "This computer (Apple M1 Max)", region: null, country: null, outputTokens: 50, genMs: 2_000 } }])).toBe("qwen3.5:9b · This computer (Apple M1 Max) · wrote 50 tok in 2.0 s · 0 cSats");
  });
});

describe("Full access in the terminal", () => {
  it("/mode full runs a compound command without asking; Shift+Tab never cycles into it and leaves it for ask", async () => {
    const { t, repl, hub, id } = await setup([
      { content: "", toolCalls: [{ name: "run_shell", arguments: { command: "echo one > one.txt && cat one.txt | tail -1" } }] },
      { content: "Ran it.", toolCalls: [] },
    ]);
    const done = repl.run();
    t.feed("/mode full");
    await until(() => t.prompt().includes("[full access]"), 5000, "prompt shows full access");
    expect(hub.snapshot(id).session.mode).toBe("full");
    t.feed("run it");
    await until(() => t.out().includes("Ran it."), 5000, "reply");
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("one\n");
    expect(t.out()).not.toContain("Allow run_shell");
    t.press("shift-tab");
    await until(() => t.prompt().includes("[ask]"), 5000, "back to ask");
    for (const next of ["auto-edits", "auto", "plan", "ask"]) {
      t.press("shift-tab");
      await until(() => t.prompt().includes(`[${next}]`), 5000, `cycles to ${next}`);
    }
    t.feed("/exit");
    await done;
  });
});

describe("/compact", () => {
  it("is listed, says when there is nothing to compact, and summarizes a longer conversation", async () => {
    // Each reply takes a moment, so the send's answer reaches the terminal before the turn ends.
    const replies: Reply[] = Array.from({ length: 4 }, (_, i) => async () => (await new Promise((r) => setTimeout(r, 60)), { content: `answer ${i} ${"a".repeat(800)}`, toolCalls: [] }));
    const { t, repl, hub, id } = await setup(replies);
    const done = repl.run();
    t.feed("/help");
    await until(() => t.out().includes("/compact"), 5000, "help");
    t.feed("/compact");
    await until(() => t.out().includes("Nothing to compact yet"), 5000, "short chat");
    for (let i = 0; i < 4; i++) {
      t.feed(`question ${i} ${"q".repeat(800)}`);
      // The turn's end has reached the terminal too.
      await until(() => t.out().includes(`answer ${i}`) && !hub.snapshot(id).running && !(repl as unknown as { running: boolean }).running, 5000, `turn ${i}`);
    }
    t.feed("/compact");
    await until(() => /Earlier messages summarized to save tokens · ~[\d,]+ tokens saved/.test(t.out()), 5000, "compacted");
    expect(hub.snapshot(id).session.transcript.at(-1)?.compaction?.manual).toBe(true);
    t.feed("/exit");
    expect(await done).toBe(0);
  });
});

describe("/cost during a turn", () => {
  it("counts each call's cSats as it settles, before the turn ends (B8)", async () => {
    // A model call that bills 0.25 cSats, then waits: the turn is still running when /cost is asked.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hub = new SessionHub(
      {
        chat: (_s, emit) => async (_req, onDelta) => {
          emit({ type: "usage", cSats: 0.25, where: "test host" });
          await gate;
          onDelta?.("All done.");
          return { content: "All done.", toolCalls: [] };
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
    const { app, url } = await sessionServer(hub);
    cleanup.push(() => app.close());
    const term = new ProviderClient(url, "unused", TERM);
    const snap = await term.createSession({ projectRoot: root, model: "network/qwen3-coder:30b" });
    const t = testIO();
    const repl = new Repl({ client: term, sessionId: snap.session.id, io: t.io, style: makeStyle(false), providerLabel: "test provider" });
    const done = repl.run();
    t.feed("hello");
    await until(() => hub.snapshot(snap.session.id).session.cSats > 0, 5000, "the call's charge");
    t.feed("/cost");
    await until(() => t.out().includes("This session has spent"), 5000, "/cost");
    expect(t.out()).toContain("This session has spent 0.250 cSats.");
    release();
    await until(() => t.out().includes("All done."), 5000, "turn end");
    // The turn's end gives the session's own total: the same, not counted twice.
    t.feed("/cost");
    await until(() => t.out().split("This session has spent").length - 1 === 2, 5000, "second /cost");
    expect(t.out().split("This session has spent 0.250 cSats.").length - 1).toBe(2);
    t.feed("/exit");
    expect(await done).toBe(0);
  });
});

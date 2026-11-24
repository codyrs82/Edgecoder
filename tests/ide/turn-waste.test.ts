import { describe, expect, it } from "vitest";
import { HELPERS_NUDGE, runAgentLoop, type ChatFn, type ChatMessage } from "../../src/apps/ide/agent-loop.js";
import { DEDUPE_MIN_CHARS, RATIO_MIN_CALLS, TurnWaste, readSummary } from "../../src/apps/ide/turn-waste.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";

/*
 * Waste inside a turn (turn-waste.ts): re-reads of an unchanged file get a short pointer instead of
 * the whole file again, and a turn that keeps re-reading or reads ≫ writes is acted on.
 */

const FILE = Array.from({ length: 120 }, (_, i) => `${i + 1}\texport function f${i}() { return ${i}; }`).join("\n");
const inContext = () => true;

describe("TurnWaste re-read dedupe", () => {
  it("an unchanged re-read becomes a pointer with a summary; the tokens saved are counted", () => {
    const w = new TurnWaste();
    w.onCall(1000, 50);
    const first = w.afterRead({ path: "src/a.ts" }, FILE, inContext);
    expect(first).toMatchObject({ text: FILE, deduped: false });
    w.attach(first.key!, {});
    w.onCall(2000, 50);
    const again = w.afterRead({ path: "src/a.ts" }, FILE, inContext);
    expect(again.deduped).toBe(true);
    expect(again.text).toMatch(/^\[Unchanged since step 1: src\/a\.ts is exactly what read_file returned at step 1 \(120 lines\)/);
    expect(again.text).toContain("Summary: export function f0() { return 0; }");
    expect(w.rereads).toBe(1);
    expect(w.savedTokens).toBeGreaterThan(1000);
    expect(w.savedLine()).toMatch(/^Skipped re-reading 1 unchanged file · ~\d+K tokens saved$/);
  });

  it("a changed file (content, or mtime/size) is sent whole again", () => {
    let stamp = "100:5000";
    const w = new TurnWaste({ stamp: () => stamp });
    const a = w.afterRead({ path: "a.ts" }, FILE, inContext);
    w.attach(a.key!, {});
    // Same content, but the file was touched since: sent again.
    stamp = "200:5000";
    const b = w.afterRead({ path: "a.ts" }, FILE, inContext);
    expect(b.deduped).toBe(false);
    w.attach(b.key!, {});
    // Changed content (an edit by a command, say): sent again.
    const c = w.afterRead({ path: "a.ts" }, FILE.replace("return 0", "return 9"), inContext);
    expect(c.deduped).toBe(false);
    expect(w.skipped).toBe(0);
  });

  it("not when the earlier result was compacted away, for another range, short files or errors", () => {
    const w = new TurnWaste();
    const a = w.afterRead({ path: "a.ts" }, FILE, inContext);
    w.attach(a.key!, {});
    expect(w.afterRead({ path: "a.ts" }, FILE, () => false).deduped).toBe(false);
    expect(w.afterRead({ path: "a.ts", offset: 200 }, FILE, inContext).deduped).toBe(false);
    const s = w.afterRead({ path: "b.ts" }, "short", inContext);
    w.attach(s.key!, {});
    expect(w.afterRead({ path: "b.ts" }, "short", inContext).deduped).toBe(false);
    expect("short".length).toBeLessThan(DEDUPE_MIN_CHARS);
    expect(w.afterRead({ path: "c.ts" }, "[Error]: no such file", inContext)).toMatchObject({ key: null, deduped: false });
  });

  it("an edit of the path forgets its reads (no re-read counted), Windows paths match", () => {
    const w = new TurnWaste();
    const a = w.afterRead({ path: "src\\a.ts" }, FILE, inContext);
    w.attach(a.key!, {});
    w.beforeTool("edit_file", { path: "src/a.ts", old_string: "x", new_string: "y" });
    expect(w.afterRead({ path: "src/a.ts" }, FILE, inContext).deduped).toBe(false);
    expect(w.rereads).toBe(0);
    expect(w.edits).toBe(1);
  });

  it("readSummary keeps declarations, else the first lines", () => {
    expect(readSummary("1\timport x from 'y';\n2\texport class A {}\n3\tconst b = 1;")).toBe("export class A {} | const b = 1;");
    expect(readSummary("hello\nworld")).toBe("hello | world");
  });
});

describe("TurnWaste signals", () => {
  it("re-reads: wasteful at two, acted on once, persists after two more", () => {
    const w = new TurnWaste();
    for (let i = 0; i < 2; i++) w.afterRead({ path: "a.ts" }, FILE, () => false);
    expect(w.signal()).toBeNull();
    w.afterRead({ path: "a.ts" }, FILE, () => false);
    expect(w.signal()).toBe("re-read 2 files it had already read");
    expect(w.shouldAct()).toBe(true);
    expect(w.shouldAct()).toBe(false);
    expect(w.persists()).toBeNull();
    w.afterRead({ path: "b.ts" }, FILE, () => false);
    w.afterRead({ path: "b.ts" }, FILE, () => false);
    w.afterRead({ path: "b.ts" }, FILE, () => false);
    expect(w.persists()).toMatch(/re-read 4 files/);
  });

  it("read/write ratio: input ≫ output with no edits after several calls", () => {
    const w = new TurnWaste();
    for (let i = 0; i < RATIO_MIN_CALLS - 1; i++) w.onCall(20_000, 200);
    expect(w.signal()).toBeNull();
    w.onCall(20_000, 200);
    expect(w.signal()).toMatch(/^read 160K tokens and wrote 1\.6K without changing anything$/);
    // A turn that edits is working, not wasting.
    w.beforeTool("write_file", { path: "x.ts" });
    expect(w.signal()).toBeNull();
  });
});

describe("in the agent loop", () => {
  /** A lead that reads the same file `times` times, then answers. */
  function rereader(times: number, path = "src/big.ts") {
    const seen: ChatMessage[][] = [];
    let n = 0;
    const chat: ChatFn = async (req) => {
      seen.push(structuredClone(req.messages));
      n++;
      return n <= times ? { content: "", toolCalls: [{ name: "read_file", arguments: { path } }] } : { content: "Done.", toolCalls: [] };
    };
    return { chat, seen };
  }

  it("re-reads of an unchanged file reach the model as a pointer, and the chat hears what was saved", async () => {
    const { chat, seen } = rereader(3);
    const events: IdeStreamEvent[] = [];
    await runAgentLoop({ chat, systemPrompt: () => "sys", messages: [{ role: "user", content: "explain big.ts" }], sendEvent: (e) => events.push(e), isCancelled: () => false, runTool: async () => FILE, native: true, waste: {} });
    const tools = seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools[0]).toBe(FILE);
    expect(tools[1]).toMatch(/^\[Unchanged since step 1/);
    expect(tools[2]).toMatch(/^\[Unchanged since step 1/);
    const note = events.find((e) => e.type === "cost_note");
    expect(note).toMatchObject({ kind: "saved", message: expect.stringMatching(/^Skipped re-reading 1 unchanged file · ~\d+K tokens saved$/) });
  });

  it("a file changed between reads (mtime) is sent whole", async () => {
    const { chat, seen } = rereader(2);
    let mtime = 1;
    await runAgentLoop({
      chat, systemPrompt: () => "", messages: [{ role: "user", content: "go" }], sendEvent: () => {}, isCancelled: () => false,
      runTool: async () => {
        mtime++;
        return FILE;
      },
      native: true,
      waste: { stamp: () => String(mtime) },
    });
    expect(seen.at(-1)!.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([FILE, FILE]);
  });

  it("a paid lead acts on waste once: older tool results shortened, lookups steered to helpers", async () => {
    // Different files each step, each re-read once: the re-reads count without being deduped away.
    const paths = ["a.ts", "b.ts", "a.ts", "c.ts", "b.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
    let n = 0;
    const seen: ChatMessage[][] = [];
    const chat: ChatFn = async (req) => {
      seen.push(structuredClone(req.messages));
      const p = paths[n++];
      return p ? { content: "", toolCalls: [{ name: "read_file", arguments: { path: p } }] } : { content: "Done.", toolCalls: [] };
    };
    const events: IdeStreamEvent[] = [];
    let version = 0;
    await runAgentLoop({
      chat, systemPrompt: () => "", messages: [{ role: "user", content: "go" }], sendEvent: (e) => events.push(e), isCancelled: () => false,
      // Every read differs, so nothing is deduped; only the re-read count grows.
      runTool: async (_t, args) => `${String(args.path)} v${version++}\n${FILE}`,
      native: true,
      waste: { act: true, helpers: true },
    });
    const waste = events.filter((e) => e.type === "cost_note" && e.kind === "waste");
    expect(waste).toHaveLength(1);
    expect((waste[0] as { message: string }).message).toMatch(/^This reply re-read 2 files it had already read: older tool results were shortened to one line each \(~\d+K tokens\) and lookups go to helpers\.$/);
    expect(events.some((e) => e.type === "compacted")).toBe(true);
    const later = seen.at(-1)!;
    expect(later.some((m) => m.content === HELPERS_NUDGE)).toBe(true);
    expect(later.some((m) => m.role === "tool" && m.content.startsWith("[Earlier result, compacted: read_file(a.ts)"))).toBe(true);
  });

  it("free leads only dedupe: no compaction or nudge (act off)", async () => {
    const paths = ["a.ts", "a.ts", "a.ts", "a.ts"];
    let n = 0;
    const chat: ChatFn = async () => {
      const p = paths[n++];
      return p ? { content: "", toolCalls: [{ name: "read_file", arguments: { path: p } }] } : { content: "Done.", toolCalls: [] };
    };
    const events: IdeStreamEvent[] = [];
    let v = 0;
    await runAgentLoop({ chat, systemPrompt: () => "", messages: [{ role: "user", content: "go" }], sendEvent: (e) => events.push(e), isCancelled: () => false, runTool: async () => `v${v++}\n${FILE}`, native: true, waste: {} });
    expect(events.some((e) => e.type === "cost_note" && e.kind === "waste")).toBe(false);
    expect(events.some((e) => e.type === "compacted")).toBe(false);
  });
});

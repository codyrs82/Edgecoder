// Cost-aware compaction (context-budget.ts): a lead paid per token compacts past a token budget
// (80K by default) whatever its window; free models keep the 85%-of-window rule. `/compact` and the
// pass before a paid turn keep a summary that replaces the older messages from then on.
import { describe, expect, it } from "vitest";
import { runAgentLoop, type ChatFn, type ChatMessage } from "../../src/apps/ide/agent-loop.js";
import {
  COMPACT_PAID_TOKENS,
  SUMMARY_HEAD,
  compactHistory,
  compactPaidTokens,
  compactThreshold,
  estimateTokens,
  isPaidLead,
  pathsIn,
  shouldCompact,
} from "../../src/apps/ide/context-budget.js";
import { sessionHistory, type TranscriptEntry } from "../../src/apps/ide/sessions.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";
import { makeHub } from "../helpers/sessions.js";

const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");

describe("the paid-lead budget", () => {
  it("defaults to 80,000 tokens; the setting, then EDGECODER_COMPACT_PAID_TOKENS, override it; nonsense is ignored", () => {
    expect(COMPACT_PAID_TOKENS).toBe(80_000);
    expect(compactPaidTokens(undefined, {})).toBe(80_000);
    expect(compactPaidTokens(undefined, { EDGECODER_COMPACT_PAID_TOKENS: "120000" })).toBe(120_000);
    expect(compactPaidTokens(50_000, { EDGECODER_COMPACT_PAID_TOKENS: "120000" })).toBe(50_000);
    expect(compactPaidTokens(10, { EDGECODER_COMPACT_PAID_TOKENS: "abc" })).toBe(80_000);
    expect(compactPaidTokens("nope", {})).toBe(80_000);
  });

  it("frontier and network (cloud included) leads are paid; this computer, your machines, reservations and Auto are not", () => {
    expect(isPaidLead("frontier/anthropic/claude-opus-5-5")).toBe(true);
    expect(isPaidLead("network/deepseek-v4.1-flash@cloud")).toBe(true);
    expect(isPaidLead("network/glm-5.3")).toBe(true);
    expect(isPaidLead("anything", "frontier")).toBe(true);
    expect(isPaidLead("deepseek-r1:14b")).toBe(false);
    expect(isPaidLead("mine/qwen3.5:9b")).toBe(false);
    expect(isPaidLead("reserved/r1/qwen3.5:9b")).toBe(false);
    expect(isPaidLead("auto")).toBe(false);
    expect(isPaidLead("qwen3.5:9b", "local")).toBe(false);
  });

  it("a 1M window compacts at 80K when paid and at 85% of the window when free", () => {
    expect(compactThreshold(1_000_000, 80_000)).toBe(80_000);
    expect(compactThreshold(1_000_000)).toBe(850_000);
    expect(compactThreshold(1_000_000, null)).toBe(850_000);
    // A small window still wins over the budget.
    expect(compactThreshold(32_768, 80_000)).toBeCloseTo(32_768 * 0.85);
    const msgs: ChatMessage[] = [{ role: "user", content: "x".repeat(300_000) }]; // ~100K tokens
    expect(shouldCompact(msgs, undefined, 1_000_000, undefined, 80_000)).toBe(true);
    expect(shouldCompact(msgs, undefined, 1_000_000)).toBe(false);
  });
});

function scripted(replies: Array<{ content: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> }>) {
  const seen: ChatMessage[][] = [];
  const chat: ChatFn = async (req, onDelta) => {
    seen.push(structuredClone(req.messages));
    const next = replies.shift() ?? { content: "done", toolCalls: [] };
    onDelta?.(next.content);
    return next;
  };
  return { chat, seen };
}

const read = (path: string) => ({ content: "", toolCalls: [{ name: "read_file", arguments: { path } }] });

async function loop(compactAtTokens: number | null) {
  const { chat, seen } = scripted([read("src/a.ts"), read("src/b.ts"), read("src/c.ts"), read("src/d.ts"), read("src/e.ts"), read("src/f.ts"), { content: "done", toolCalls: [] }]);
  const events: IdeStreamEvent[] = [];
  await runAgentLoop({
    chat,
    systemPrompt: () => "sys",
    messages: [{ role: "user", content: "fix it" }],
    sendEvent: (e) => events.push(e),
    isCancelled: () => false,
    runTool: async () => big(400), // ~8.5K tokens per result
    native: true,
    contextWindow: 1_000_000,
    compactAtTokens,
    summarize: async () => "Read a to f.",
  });
  return { seen, events };
}

describe("the agent loop", () => {
  it("a paid lead with a 1M window compacts once the prompt passes its budget, and says how many tokens it saved", async () => {
    const { seen, events } = await loop(20_000);
    for (const msgs of seen) expect(estimateTokens(msgs)).toBeLessThanOrEqual(20_000 + 9_000);
    const compacted = events.filter((e) => e.type === "compacted");
    expect(compacted.length).toBeGreaterThan(0);
    expect((compacted[0] as { savedTokens: number }).savedTokens).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "status" && /save tokens/.test(e.message))).toBe(true);
    // The request survives.
    expect(seen.at(-1)!.some((m) => m.content === "fix it")).toBe(true);
    // The context meter hears the size of every call.
    expect(events.filter((e) => e.type === "context").length).toBe(seen.length);
  });

  it("a free model with the same window keeps the 85% rule: nothing is compacted", async () => {
    const { seen, events } = await loop(null);
    expect(events.some((e) => e.type === "compacted")).toBe(false);
    expect(estimateTokens(seen.at(-1)!)).toBeGreaterThan(40_000);
  });
});

const turn = (i: number, size = 2_000): ChatMessage[] => [
  { role: "user", content: `request ${i}: look at src/mod${i}/file${i}.ts ${"q".repeat(size)}` },
  { role: "assistant", content: `answer ${i} ${"a".repeat(size)}` },
];

describe("compactHistory (/compact)", () => {
  it("summarizes all but the last few messages, starting the kept part at a request, with the file paths", async () => {
    const msgs = [1, 2, 3, 4, 5].flatMap((i) => turn(i));
    const asked: string[] = [];
    const r = await compactHistory(msgs, { summarize: async (t) => (asked.push(t), "Worked through modules 1 to 3.") });
    expect(r).not.toBeNull();
    expect(r!.covered).toBe(6);
    expect(msgs[r!.covered].role).toBe("user");
    expect(r!.note.startsWith(SUMMARY_HEAD)).toBe(true);
    expect(r!.note).toContain("Worked through modules 1 to 3.");
    expect(r!.note).toContain("src/mod1/file1.ts");
    expect(r!.summarized).toBe(true);
    expect(r!.after).toBeLessThan(r!.before);
    expect(asked[0]).toContain("request 1");
    expect(asked[0]).not.toContain("request 5");
  });

  it("without a summarizer (or when it fails) it keeps a shortened transcript instead", async () => {
    const msgs = [1, 2, 3, 4].flatMap((i) => turn(i));
    const r = await compactHistory(msgs, { summarize: async () => { throw new Error("offline"); } });
    expect(r!.summarized).toBe(false);
    expect(r!.note).toContain("request 1");
    expect(r!.after).toBeLessThan(r!.before);
  });

  it("never splits a tool call from its result, and leaves a short chat alone", async () => {
    const msgs: ChatMessage[] = [
      ...turn(1),
      ...turn(2),
      { role: "user", content: "run it" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "run_shell", arguments: { command: "npm test" } } }] },
      { role: "tool", content: "ok", tool_name: "run_shell" },
      { role: "assistant", content: "Tests pass." },
    ];
    const r = await compactHistory(msgs, { keep: 2 });
    expect(r).not.toBeNull();
    expect(msgs[r!.covered].content).toBe("run it");
    expect(await compactHistory(turn(1))).toBeNull();
  });

  it("finds paths in prose and code spans", () => {
    expect(pathsIn(["Edit `src/swarm/worker-runner.ts`, then ./scripts/x.sh.", "see https://x.io/a/b.html and desktop/src/App.svelte"])).toEqual(["src/swarm/worker-runner.ts", "./scripts/x.sh", "desktop/src/App.svelte"]);
  });
});

describe("sessions", () => {
  it("sessionHistory sends the newest summary in place of the messages it covers", () => {
    const t: TranscriptEntry[] = [
      { id: "u1", role: "user", content: "one", at: 1 },
      { id: "a1", role: "assistant", content: "uno", at: 2 },
      { id: "u2", role: "user", content: "two", at: 3 },
      { id: "a2", role: "assistant", content: "dos", at: 4 },
      { id: "n1", role: "note", content: "Earlier messages summarized", at: 5, compaction: { throughId: "a1", note: `${SUMMARY_HEAD}\nSaid one.`, before: 10, after: 5, savedTokens: 5, summarized: true, manual: true } },
      { id: "u3", role: "user", content: "three", at: 6 },
    ];
    const h = sessionHistory(t);
    expect(h.messages.map((m) => m.content)).toEqual([`${SUMMARY_HEAD}\nSaid one.`, "two", "dos", "three"]);
    expect(h.ids).toEqual(["a1", "u2", "a2", "u3"]);
  });

  it("hub.compact keeps a note the next turn sends instead of the older messages", async () => {
    const replies = Array.from({ length: 5 }, (_, i) => ({ content: `reply ${i} ${"r".repeat(3_000)}`, toolCalls: [] }));
    replies.push({ content: "after", toolCalls: [] });
    const { hub, model } = makeHub(replies);
    const client = { clientId: "t", kind: "terminal" as const };
    const s = hub.create({ projectRoot: process.cwd(), model: "frontier/anthropic/claude-opus-5-5", client });
    for (let i = 0; i < 5; i++) {
      hub.send(s.id, `message ${i} ${"m".repeat(3_000)}`, client);
      await hub.idle(s.id);
    }
    const entry = await hub.compact(s.id, client);
    expect(entry?.role).toBe("note");
    expect(entry?.compaction?.manual).toBe(true);
    expect(entry?.content).toMatch(/Earlier messages summarized to save tokens · ~[\d,]+ tokens saved/);
    hub.send(s.id, "next", client);
    await hub.idle(s.id);
    const sent = model.requests.at(-1)!.messages.map((m) => m.content);
    expect(sent.some((c) => c.startsWith(SUMMARY_HEAD))).toBe(true);
    expect(sent.some((c) => c.startsWith("message 0"))).toBe(false);
    expect(sent.at(-1)).toBe("next");
  });
});

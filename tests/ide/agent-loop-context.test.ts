import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentLoop, type ChatFn, type ChatMessage } from "../../src/apps/ide/agent-loop.js";
import { estimateTokens, isContextTooLong, isTransient } from "../../src/apps/ide/context-budget.js";
import { ToolExecutor } from "../../src/apps/ide/tool-executor.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";

type Reply = { content: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> } | Error;

/** A backend that answers from a script and records what each call carried. */
function backend(replies: Reply[], opts: { window?: number; streamBeforeError?: boolean } = {}) {
  const seen: ChatMessage[][] = [];
  const chat: ChatFn = async (req, onDelta) => {
    seen.push(structuredClone(req.messages));
    // Like the coordinator: a request bigger than the window is refused.
    if (opts.window && estimateTokens(req.messages, req.tools) > opts.window) throw new Error(`Network request failed: context_too_long: needs ${estimateTokens(req.messages, req.tools)} tokens, this agent serves ${opts.window}`);
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    if (next instanceof Error) {
      if (opts.streamBeforeError) onDelta?.("partial ");
      throw next;
    }
    onDelta?.(next.content);
    return next;
  };
  return { chat, seen };
}

const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");

function run(chat: ChatFn, extra: Partial<Parameters<typeof runAgentLoop>[0]> = {}, toolResult = () => big(400)) {
  const events: IdeStreamEvent[] = [];
  const done = runAgentLoop({
    chat,
    systemPrompt: () => "sys",
    messages: [{ role: "user", content: "fix the worker" }],
    sendEvent: (e) => events.push(e),
    isCancelled: () => false,
    runTool: async () => toolResult(),
    native: true,
    retryDelaysMs: [0, 0],
    ...extra,
  });
  return { events, done, text: () => events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content).join(""), statuses: () => events.filter((e) => e.type === "status").map((e) => (e as { message: string }).message) };
}

const read = (path: string): Reply => ({ content: "", toolCalls: [{ name: "read_file", arguments: { path } }] });

describe("context budget", () => {
  it("compacts older tool results before a call would pass ~85% of the window the backend reports, keeping the request and the paths", async () => {
    const { chat, seen } = backend([read("src/swarm/worker-runner.ts"), read("src/swarm/a.ts"), read("src/swarm/b.ts"), read("src/swarm/c.ts"), read("src/swarm/d.ts"), { content: "done", toolCalls: [] }], { window: 16_384 });
    const r = run(chat, { contextWindow: async () => 16_384 });
    await r.done;
    expect(r.text()).toBe("done");
    expect(r.statuses().some((s) => s.startsWith("Compacted the conversation"))).toBe(true);
    for (const msgs of seen) expect(estimateTokens(msgs)).toBeLessThanOrEqual(16_384);
    const last = seen[seen.length - 1];
    expect(last.some((m) => m.role === "user" && m.content === "fix the worker")).toBe(true);
    const flat = last.map((m) => m.content).join("\n");
    expect(flat).toContain("read_file(src/swarm/worker-runner.ts)");
  });

  it("uses a summarization call when shortening is not enough, and the summary keeps the exact paths", async () => {
    const { chat, seen } = backend([read("src/swarm/worker-runner.ts"), read("src/a.ts"), read("src/b.ts"), read("src/c.ts"), read("src/d.ts"), read("src/e.ts"), read("src/f.ts"), read("src/g.ts"), { content: "ok", toolCalls: [] }]);
    const asked: string[] = [];
    const r = run(chat, { contextWindow: 12_000, summarize: async (t) => (asked.push(t), "Read the worker and its helpers.") }, () => big(150));
    await r.done;
    expect(asked.length).toBeGreaterThan(0);
    const flat = seen[seen.length - 1].map((m) => m.content).join("\n");
    expect(flat).toContain("Read the worker and its helpers.");
    expect(flat).toContain("src/swarm/worker-runner.ts");
  });

  it("context_too_long: compacts and retries the call once instead of ending the turn", async () => {
    // The backend's real window (8k) is smaller than assumed (32k).
    const { chat } = backend([read("src/swarm/worker-runner.ts"), read("src/x.ts"), { content: "finished", toolCalls: [] }], { window: 8_000 });
    const r = run(chat, {}, () => big(60));
    await r.done;
    expect(r.text()).toBe("finished");
    expect(r.statuses().some((s) => s.startsWith("Compacted"))).toBe(true);
  });
});

describe("transient model-call failures", () => {
  it("retries not_requester, 502 pages and empty replies up to twice when nothing streamed", async () => {
    const { chat, seen } = backend([new Error("Network stream failed: not_requester"), new Error("Network request failed: coordinator_bad_response"), { content: "hello", toolCalls: [] }]);
    const r = run(chat);
    await r.done;
    expect(r.text()).toBe("hello");
    expect(seen).toHaveLength(3);
    expect(r.statuses().filter((s) => s.includes("retrying"))).toHaveLength(2);
  });

  it("gives up after two retries and names the files used", async () => {
    const { chat } = backend([read("src/swarm/worker-runner.ts"), new Error("terminated"), new Error("terminated"), new Error("terminated")]);
    const r = run(chat, {}, () => "ok");
    await r.done;
    expect(r.text()).toContain("Error contacting model: terminated");
    expect(r.text()).toContain("src/swarm/worker-runner.ts");
  });

  it("does not retry once output has streamed, or for errors a retry cannot fix", async () => {
    const a = backend([new Error("terminated")], { streamBeforeError: true });
    const ra = run(a.chat);
    await ra.done;
    expect(a.seen).toHaveLength(1);
    const b = backend([new Error("Not enough cSats for this request")]);
    const rb = run(b.chat);
    await rb.done;
    expect(b.seen).toHaveLength(1);
  });

  it("classifies errors", () => {
    expect(isTransient(new Error("<html><body>502 Bad Gateway</body></html>"))).toBe(true);
    expect(isTransient(new Error("empty_reply"))).toBe(true);
    expect(isTransient(new Error("insufficient_credits"))).toBe(false);
    expect(isContextTooLong(new Error("context_too_long: needs 40000 tokens"))).toBe(true);
  });
});

describe("read_file paging", () => {
  const root = mkdtempSync(join(tmpdir(), "readpage-"));
  writeFileSync(join(root, "big.ts"), `${Array.from({ length: 2085 }, (_, i) => `const l${i + 1} = ${i + 1};`).join("\n")}\n`);
  writeFileSync(join(root, "small.ts"), "a\nb\n");
  const ex = new ToolExecutor(root);

  it("returns at most 400 lines by default with a note on how to read on", async () => {
    const r = await ex.execute("read_file", { path: "big.ts" });
    const lines = r.result!.split("\n");
    expect(lines).toHaveLength(401);
    expect(lines[399]).toContain("const l400 = 400;");
    expect(lines[400]).toMatch(/lines 1-400 of 2085.*offset 401/);
  });

  it("offset and limit page through, capped at 800 lines", async () => {
    const r = await ex.execute("read_file", { path: "big.ts", offset: 2001, limit: 400 });
    const lines = r.result!.split("\n");
    expect(lines[0]).toContain("const l2001");
    expect(lines).toHaveLength(85);
    const capped = await ex.execute("read_file", { path: "big.ts", limit: 5000 });
    expect(capped.result!.split("\n")).toHaveLength(801);
  });

  it("a small file comes back whole with no note", async () => {
    expect((await ex.execute("read_file", { path: "small.ts" })).result).toBe("     1  a\n     2  b");
  });
});

describe("the window a network model reports", () => {
  it("is read from the coordinator's /inference/models (smallest served window), else unknown", async () => {
    const { networkContextWindow } = await import("../../src/apps/ide/network-inference.js");
    const paths: string[] = [];
    const d = {
      forwarder: "",
      token: () => "",
      agentId: "a",
      transport: async (_m: "GET" | "POST", path: string) => {
        paths.push(path);
        return { status: 200, json: { models: [{ model: "qwen3-coder:30b", agents: 2, classes: ["gpu"], contextWindow: 32_768 }, { model: "old:7b", agents: 1, classes: ["cpu"] }] } };
      },
    };
    expect(await networkContextWindow(d, "qwen3-coder:30b")).toBe(32_768);
    expect(await networkContextWindow(d, "old:7b")).toBeUndefined();
    expect(paths).toEqual(["/inference/models", "/inference/models"]);
  });
});

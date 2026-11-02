import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { makeToolRunner, ollamaChat, runAgentLoop, toolSchemas, ToolsUnsupportedError, type ChatFn, type ChatMessage } from "../../src/apps/ide/agent-loop.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";

function scripted(replies: Array<ReturnType<ChatFn> extends Promise<infer R> ? R | Error : never>) {
  const seen: Array<{ messages: ChatMessage[]; tools: boolean }> = [];
  const chat: ChatFn = async (req, onDelta) => {
    seen.push({ messages: structuredClone(req.messages), tools: Boolean(req.tools) });
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    if (next instanceof Error) throw next;
    if (onDelta) for (const piece of next.content.match(/.{1,4}/gs) ?? []) onDelta(piece);
    return next;
  };
  return { chat, seen };
}

describe("runAgentLoop", () => {
  it("native: streams text, runs tool calls, feeds results back, stops on a plain answer", async () => {
    const { chat, seen } = scripted([
      { content: "Reading it.", toolCalls: [{ name: "read_file", arguments: { path: "a.ts" } }] },
      { content: "It exports a.", toolCalls: [] },
    ]);
    const events: IdeStreamEvent[] = [];
    const ran: string[] = [];
    await runAgentLoop({
      chat,
      systemPrompt: (f) => `sys:${f}`,
      messages: [{ role: "user", content: "what is in a.ts?" }],
      sendEvent: (e) => events.push(e),
      isCancelled: () => false,
      runTool: async (tool, args) => {
        ran.push(`${tool}:${args.path}`);
        return "export const a = 1;";
      },
      native: true,
    });
    expect(ran).toEqual(["read_file:a.ts"]);
    const text = events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content).join("");
    expect(text).toBe("Reading it.\n\nIt exports a.");
    expect(seen[0].tools).toBe(true);
    expect(seen[0].messages[0]).toEqual({ role: "system", content: "sys:native" });
    expect(seen[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Reading it.", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }] },
      { role: "tool", content: "export const a = 1;", tool_name: "read_file" },
    ]);
  });

  it("falls back to text mode when the model has no tool support", async () => {
    const { chat, seen } = scripted([
      new ToolsUnsupportedError("model does not support tools"),
      { content: 'Let me look.\n```tool_call\n{"tool": "list_directory", "args": {"path": "."}}\n```', toolCalls: [] },
      { content: "Two files.", toolCalls: [] },
    ]);
    const events: IdeStreamEvent[] = [];
    await runAgentLoop({
      chat,
      systemPrompt: (f) => `sys:${f}`,
      messages: [{ role: "user", content: "list" }],
      sendEvent: (e) => events.push(e),
      isCancelled: () => false,
      runTool: async () => "a.ts\nb.ts",
      native: true,
    });
    expect(seen[1].tools).toBe(false);
    expect(seen[1].messages[0]).toEqual({ role: "system", content: "sys:text" });
    expect(seen[2].messages.at(-1)).toEqual({ role: "user", content: "[Tool list_directory result]: a.ts\nb.ts" });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content)).toEqual(["Let me look.", "\n\nTwo files."]);
  });

  it("reports unknown tools to the model instead of running anything", async () => {
    const { chat, seen } = scripted([
      { content: "", toolCalls: [{ name: "rm_rf", arguments: {} }] },
      { content: "ok", toolCalls: [] },
    ]);
    let ran = 0;
    await runAgentLoop({ chat, systemPrompt: () => "", messages: [{ role: "user", content: "x" }], sendEvent: () => {}, isCancelled: () => false, runTool: async () => { ran++; return ""; }, native: true });
    expect(ran).toBe(0);
    expect(seen[1].messages.at(-1)).toEqual({ role: "tool", content: "[Error]: unknown tool rm_rf", tool_name: "rm_rf" });
  });

  it("stops when cancelled", async () => {
    const { chat, seen } = scripted([{ content: "", toolCalls: [{ name: "read_file", arguments: { path: "a" } }] }, { content: "never", toolCalls: [] }]);
    let cancelled = false;
    await runAgentLoop({ chat, systemPrompt: () => "", messages: [{ role: "user", content: "x" }], sendEvent: () => {}, isCancelled: () => cancelled, runTool: async () => { cancelled = true; return ""; }, native: true });
    expect(seen).toHaveLength(1);
  });
});

describe("makeToolRunner", () => {
  const base = () => {
    const events: IdeStreamEvent[] = [];
    const executed: string[] = [];
    return {
      events,
      executed,
      deps: {
        execute: async (tool: string) => { executed.push(tool); return { result: tool === "run_shell" ? JSON.stringify({ stdout: "hi", stderr: "", exit_code: 0 }) : "done" }; },
        sendEvent: (e: IdeStreamEvent) => events.push(e),
        waitForApproval: async () => true,
        captureBeforeWrite: (p: string) => p,
        turnId: "t1",
      },
    };
  };

  it("runs reads without approval and reports the result", async () => {
    const b = base();
    let asked = false;
    const run = makeToolRunner({ ...b.deps, waitForApproval: async () => { asked = true; return true; } });
    expect(await run("read_file", { path: "a" })).toBe("done");
    expect(asked).toBe(false);
    expect(b.events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
  });

  it("a rejected write is not executed", async () => {
    const b = base();
    const run = makeToolRunner({ ...b.deps, waitForApproval: async () => false });
    expect(await run("write_file", { path: "a", content: "x" })).toMatch(/^\[Rejected\]/);
    expect(b.executed).toEqual([]);
  });

  it("an approved write is checkpointed and reported as a file change", async () => {
    const b = base();
    const run = makeToolRunner(b.deps);
    await run("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" });
    expect(b.events.map((e) => e.type)).toEqual(["tool_call", "file_change", "tool_result"]);
    expect(b.events[1]).toEqual({ type: "file_change", turnId: "t1", path: "src/a.ts" });
  });

  it("shell results go out as shell_output", async () => {
    const b = base();
    await makeToolRunner(b.deps)("run_shell", { command: "echo hi" });
    expect(b.events.at(-1)).toMatchObject({ type: "shell_output", stdout: "hi", exit_code: 0 });
  });
});

describe("ollamaChat", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function fakeOllama(handler: (body: Record<string, unknown>, res: import("node:http").ServerResponse) => void): Promise<string> {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => handler(JSON.parse(raw), res));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it("streams content and collects tool calls from NDJSON", async () => {
    let sent: Record<string, unknown> = {};
    const host = await fakeOllama((body, res) => {
      sent = body;
      res.write(JSON.stringify({ message: { content: "Hel" } }) + "\n");
      res.write(JSON.stringify({ message: { content: "lo" } }) + "\n");
      res.write(JSON.stringify({ message: { content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a" } } }] } }) + "\n");
      res.end(JSON.stringify({ done: true }) + "\n");
    });
    const deltas: string[] = [];
    const r = await ollamaChat(host, "m")({ messages: [{ role: "user", content: "hi" }], tools: toolSchemas() }, (d) => deltas.push(d));
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r).toEqual({ content: "Hello", toolCalls: [{ name: "read_file", arguments: { path: "a" } }] });
    expect(sent.stream).toBe(true);
    expect(sent.think).toBe(false);
    expect((sent.tools as unknown[]).length).toBeGreaterThan(5);
  });

  it("recognises a model without tool support", async () => {
    const host = await fakeOllama((_b, res) => {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "registry.ollama.ai/library/gemma:2b does not support tools" }));
    });
    await expect(ollamaChat(host, "m")({ messages: [], tools: [] })).rejects.toBeInstanceOf(ToolsUnsupportedError);
  });
});

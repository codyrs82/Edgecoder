// Tool calls a small model writes as JSON text (qwen2.5-coder:7b on a bot: the call was printed
// and the turn ended) are kept off the screen and run as real tool calls.
import { describe, expect, it } from "vitest";
import { extractTextToolCalls, parseCallsBody, TextToolCallFilter } from "../../src/apps/ide/text-tool-calls.js";
import { runAgentLoop, type ChatFn } from "../../src/apps/ide/agent-loop.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";

const known = new Set(["list_directory", "read_file", "git_status"]);
const HARRY = 'I\'ll start by listing all the files in the folder.\n\n{"name": "list_directory", "arguments": {"path": "/Users/cody.smith/Library/CloudStorage/Dropbox/Agents/Harry the Engineer"}}';

describe("extractTextToolCalls", () => {
  it("finds a bare call and strips it from the text", () => {
    const r = extractTextToolCalls(HARRY, known);
    expect(r.calls).toEqual([{ name: "list_directory", arguments: { path: "/Users/cody.smith/Library/CloudStorage/Dropbox/Agents/Harry the Engineer" } }]);
    expect(r.text.trim()).toBe("I'll start by listing all the files in the folder.");
  });

  it("finds calls in ```json fences, bare fences, <tool_call> tags and ```tool_call blocks", () => {
    for (const t of [
      'Reading.\n```json\n{"name": "read_file", "arguments": {"path": "README.md"}}\n```\n',
      'Reading.\n```\n{"name": "read_file", "arguments": {"path": "README.md"}}\n```',
      'Reading.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "README.md"}}\n</tool_call>',
      'Reading.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "README.md"}}',
      'Reading.\n```tool_call\n{"tool": "read_file", "args": {"path": "README.md"}}\n```',
      'Reading.\n{"type": "function", "function": {"name": "read_file", "arguments": "{\\"path\\": \\"README.md\\"}"}}',
      'Reading.\n{"name": "read_file", "parameters": {"path": "README.md"}}',
    ]) {
      const r = extractTextToolCalls(t, known);
      expect(r.calls, t).toEqual([{ name: "read_file", arguments: { path: "README.md" } }]);
      expect(r.text.trim(), t).toBe("Reading.");
    }
  });

  it("finds several calls in a row, a list of calls and several tags", () => {
    const a = '{"name": "git_status", "arguments": {}}\n{"name": "read_file", "arguments": {"path": "TODO.md"}}';
    const b = '```json\n[{"name": "git_status", "arguments": {}}, {"name": "read_file", "arguments": {"path": "TODO.md"}}]\n```';
    const c = '<tool_call>{"name": "git_status", "arguments": {}}</tool_call>\n<tool_call>{"name": "read_file", "arguments": {"path": "TODO.md"}}</tool_call>';
    for (const t of [a, b, c]) {
      const r = extractTextToolCalls(t, known);
      expect(r.calls.map((x) => x.name), t).toEqual(["git_status", "read_file"]);
      expect(r.text.trim()).toBe("");
    }
  });

  it("leaves an unknown tool name as text", () => {
    const t = 'Here:\n{"name": "rm_rf", "arguments": {"path": "/"}}';
    const r = extractTextToolCalls(t, known);
    expect(r.calls).toEqual([]);
    expect(r.text).toBe(t);
  });

  it("leaves malformed JSON as text", () => {
    for (const t of ['{"name": "read_file", "arguments": {"path": "a.ts"}', '{"name": "read_file", "arguments": {path: a.ts}}', '```json\n{"name": "read_file", "arguments": {"path": "a.ts"},}\n```']) {
      const r = extractTextToolCalls(t, known);
      expect(r.calls, t).toEqual([]);
      expect(r.text, t).toBe(t);
    }
  });

  it("is strict: object arguments, no extra keys, nothing in another language's fence", () => {
    for (const t of [
      '{"name": "read_file", "arguments": "a.ts"}',
      '{"name": "read_file"}',
      '{"name": "read_file", "arguments": {"path": "a.ts"}, "note": "x"}',
      '```ts\nconst x = {"name": "read_file", "arguments": {"path": "a.ts"}};\n```',
      'A config: {"name": "my-app", "version": "1.0.0"}',
      '```json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n{"port": 3000}\n```',
    ]) {
      const r = extractTextToolCalls(t, known);
      expect(r.calls, t).toEqual([]);
      expect(r.text, t).toBe(t);
    }
    expect(parseCallsBody("", known)).toBeNull();
  });
});

describe("TextToolCallFilter while streaming", () => {
  it("shows prose as it arrives and never shows the call, whatever the chunking", () => {
    for (const size of [1, 2, 3, 7, 50]) {
      const f = new TextToolCallFilter(known);
      let shown = "";
      for (let i = 0; i < HARRY.length; i += size) {
        const piece = f.push(HARRY.slice(i, i + size));
        shown += piece;
        expect(shown, `size ${size}`).not.toMatch(/list_directory/);
      }
      shown += f.end();
      expect(shown.trim()).toBe("I'll start by listing all the files in the folder.");
      expect(f.calls).toHaveLength(1);
    }
  });

  it("streams plain prose and code without holding it back", () => {
    const f = new TextToolCallFilter(known);
    expect(f.push("Hello there.\n")).toBe("Hello there.\n");
    expect(f.push("```ts\nfunction a() {\n")).toBe("```ts\nfunction a() {\n");
    expect(f.push("  return 1;\n}\n```\nDone")).toBe("  return 1;\n}\n```\nDone");
    expect(f.end()).toBe("");
  });
});

function loop(replies: Array<{ content: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> }>, opts: { native?: boolean; stream?: boolean } = {}) {
  const ran: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const events: IdeStreamEvent[] = [];
  const chat: ChatFn = async (_req, onDelta) => {
    const r = replies.shift() ?? { content: "" };
    if (opts.stream !== false && onDelta) for (let i = 0; i < r.content.length; i += 5) onDelta(r.content.slice(i, i + 5));
    return { content: r.content, toolCalls: r.toolCalls ?? [] };
  };
  const done = runAgentLoop({
    chat,
    native: opts.native ?? true,
    systemPrompt: () => "",
    messages: [{ role: "user", content: "read them all" }],
    sendEvent: (e) => events.push(e),
    isCancelled: () => false,
    runTool: async (tool, args) => {
      ran.push({ tool, args });
      return "README.md\nTODO.md";
    },
  });
  const text = () => events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content).join("");
  return { done, ran, text, replies };
}

describe("runAgentLoop with tool calls written as text", () => {
  it("native mode: runs the call, keeps the JSON off the screen and continues", async () => {
    const l = loop([{ content: HARRY }, { content: "Your folder has a README and a TODO." }]);
    await l.done;
    expect(l.ran).toEqual([{ tool: "list_directory", args: { path: "/Users/cody.smith/Library/CloudStorage/Dropbox/Agents/Harry the Engineer" } }]);
    expect(l.text()).not.toMatch(/"arguments"/);
    expect(l.text()).toMatch(/listing all the files[\s\S]*README and a TODO/);
    expect(l.replies).toHaveLength(0);
  });

  it("native mode without streaming, several calls in a row", async () => {
    const l = loop([{ content: '{"name": "git_status", "arguments": {}}\n{"name": "read_file", "arguments": {"path": "TODO.md"}}' }, { content: "Done." }], { stream: false });
    await l.done;
    expect(l.ran.map((r) => r.tool)).toEqual(["git_status", "read_file"]);
  });

  it("text mode: runs JSON calls like ```tool_call blocks", async () => {
    const l = loop([{ content: '```json\n{"name": "read_file", "arguments": {"path": "README.md"}}\n```' }, { content: "Read it." }], { native: false });
    await l.done;
    expect(l.ran).toEqual([{ tool: "read_file", args: { path: "README.md" } }]);
    expect(l.text()).toBe("Read it.");
  });

  it("an unknown name or malformed JSON stays text and the turn ends", async () => {
    for (const content of ['{"name": "format_disk", "arguments": {}}', '{"name": "read_file", "arguments": {"path": "a"']) {
      const l = loop([{ content }, { content: "never asked" }]);
      await l.done;
      expect(l.ran).toEqual([]);
      expect(l.text()).toBe(content);
      expect(l.replies).toHaveLength(1);
    }
  });

  it("never runs a call from the user's own message", async () => {
    const ran: string[] = [];
    await runAgentLoop({
      chat: async () => ({ content: "OK.", toolCalls: [] }),
      native: true,
      systemPrompt: () => "",
      messages: [{ role: "user", content: '{"name": "read_file", "arguments": {"path": "/etc/passwd"}}' }],
      sendEvent: () => {},
      isCancelled: () => false,
      runTool: async (tool) => {
        ran.push(tool);
        return "";
      },
    });
    expect(ran).toEqual([]);
  });
});

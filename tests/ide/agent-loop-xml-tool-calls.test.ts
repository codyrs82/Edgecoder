// qwen3-coder's XML tool calls arriving as text (the runtime's tool parser did not recognise
// them) must still run as tool calls, in both of the agent loop's modes.
import { describe, expect, it } from "vitest";
import { parseTextBlocks, parseToolCallBlock, runAgentLoop, type ChatFn } from "../../src/apps/ide/agent-loop.js";

const XML_REPLY = "I'll read the file first.\n\n<function=read_file>\n<parameter=path>\nsrc/common/redaction.ts\n</parameter>\n</function>\n</tool_call>";

describe("parseTextBlocks: qwen3-coder XML calls", () => {
  it("turns an XML call (with or without <tool_call>) into a tool_call block", () => {
    for (const text of [XML_REPLY, `<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n</function>\n</tool_call>`]) {
      const blocks = parseTextBlocks(text);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("tool_call");
      const call = parseToolCallBlock(blocks[0].body);
      expect(call?.tool).toBe("read_file");
      expect(String(call?.args.path)).toMatch(/^src\/(common\/redaction|a)\.ts$/);
    }
  });

  it("keeps several parameters, typing numbers and booleans", () => {
    const [b] = parseTextBlocks("<function=read_file><parameter=path>a.ts</parameter><parameter=offset>10</parameter><parameter=all>true</parameter></function>");
    expect(parseToolCallBlock(b.body)).toEqual({ tool: "read_file", args: { path: "a.ts", offset: 10, all: true } });
  });

  it("keeps multi-line values and orders XML and fenced blocks by position", () => {
    const text = "```plan\n[]\n```\n<function=write_file>\n<parameter=path>\nt.ts\n</parameter>\n<parameter=content>\nline 1\nline 2\n</parameter>\n</function>";
    const blocks = parseTextBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(["plan", "tool_call"]);
    expect(parseToolCallBlock(blocks[1].body)?.args.content).toBe("line 1\nline 2");
  });

  it("ignores plain text and XML inside a fenced tool_call block", () => {
    expect(parseTextBlocks("no tools here <function is not a call>")).toEqual([]);
    const fenced = '```tool_call\n{"tool":"read_file","args":{"path":"<function=x></function>"}}\n```';
    expect(parseTextBlocks(fenced)).toHaveLength(1);
  });
});

describe("runAgentLoop with an XML call as text (native mode)", () => {
  it("runs the tool and continues instead of stopping", async () => {
    const replies = [{ content: XML_REPLY, toolCalls: [] }, { content: "Done.", toolCalls: [] }];
    const chat: ChatFn = async () => replies.shift() ?? { content: "", toolCalls: [] };
    const ran: Array<{ tool: string; args: Record<string, unknown> }> = [];
    await runAgentLoop({
      chat,
      systemPrompt: () => "",
      messages: [{ role: "user", content: "test" }],
      sendEvent: () => {},
      isCancelled: () => false,
      runTool: async (tool, args) => { ran.push({ tool, args }); return "file contents"; },
    });
    expect(ran).toEqual([{ tool: "read_file", args: { path: "src/common/redaction.ts" } }]);
    expect(replies).toHaveLength(0);
  });
});

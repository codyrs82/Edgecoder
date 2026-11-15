import { describe, expect, it } from "vitest";
import { parseToolCallBlock, parseTextBlocks } from "../../src/apps/ide/agent-loop.js";

describe("parseToolCallBlock", () => {
  it("should parse valid JSON with tool and args", () => {
    const input = '{"tool": "write_file", "args": {"path": "test.txt", "content": "hello"}}';
    const result = parseToolCallBlock(input);
    expect(result).toEqual({
      tool: "write_file",
      args: { path: "test.txt", content: "hello" }
    });
  });

  it("should return null when tool is missing", () => {
    const input = '{"args": {"path": "test.txt"}}';
    const result = parseToolCallBlock(input);
    expect(result).toBeNull();
  });

  it("should return null when tool is empty string", () => {
    const input = '{"tool": "", "args": {"path": "test.txt"}}';
    const result = parseToolCallBlock(input);
    expect(result).toBeNull();
  });

  it("should return null when tool is not a string", () => {
    const input = '{"tool": 123, "args": {"path": "test.txt"}}';
    const result = parseToolCallBlock(input);
    expect(result).toBeNull();
  });

  it("should return {} for args when args is missing", () => {
    const input = '{"tool": "write_file"}';
    const result = parseToolCallBlock(input);
    expect(result).toEqual({
      tool: "write_file",
      args: {}
    });
  });

  it("should return {} for args when args is not an object", () => {
    const input = '{"tool": "write_file", "args": "not-an-object"}';
    const result = parseToolCallBlock(input);
    expect(result).toEqual({
      tool: "write_file",
      args: {}
    });
  });

  it("should return null for malformed JSON", () => {
    const input = '{"tool": "write_file", "args": {"path": "test.txt"}';
    const result = parseToolCallBlock(input);
    expect(result).toBeNull();
  });
});

describe("parseTextBlocks", () => {
  it("should find tool_call and plan fences in order with their bodies", () => {
    const input = `
Some text before
\`\`\`tool_call
{"tool": "write_file", "args": {"path": "test.txt"}}
\`\`\`
More text
\`\`\`plan
[{"index": 0, "description": "Create file", "status": "pending"}]
\`\`\`
Even more text
    `;
    
    const result = parseTextBlocks(input);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe("tool_call");
    expect(result[0].body).toBe('{"tool": "write_file", "args": {"path": "test.txt"}}');
    expect(result[1].kind).toBe("plan");
    expect(result[1].body).toBe('[{"index": 0, "description": "Create file", "status": "pending"}]');
  });

  it("should handle multiple tool_call blocks", () => {
    const input = `
\`\`\`tool_call
{"tool": "write_file", "args": {"path": "file1.txt"}}
\`\`\`
Some text
\`\`\`tool_call
{"tool": "edit_file", "args": {"path": "file2.txt"}}
\`\`\`
    `;
    
    const result = parseTextBlocks(input);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe("tool_call");
    expect(result[0].body).toBe('{"tool": "write_file", "args": {"path": "file1.txt"}}');
    expect(result[1].kind).toBe("tool_call");
    expect(result[1].body).toBe('{"tool": "edit_file", "args": {"path": "file2.txt"}}');
  });

  it("should return empty array when no fences are present", () => {
    const input = "Just some regular text without any fences";
    const result = parseTextBlocks(input);
    expect(result).toEqual([]);
  });

  it("should handle nested fences correctly", () => {
    const input = `
\`\`\`tool_call
{"tool": "write_file", "args": {"path": "test.txt", "content": "hello \`\`\`world\`\`\`"}}
\`\`\`
    `;
    
    const result = parseTextBlocks(input);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("tool_call");
    expect(result[0].body).toBe('{"tool": "write_file", "args": {"path": "test.txt", "content": "hello ```world```"}}');
  });

  it("should sort blocks by their position in the text", () => {
    const input = `
\`\`\`plan
[{"index": 0, "description": "Plan step 1"}]
\`\`\`
Some text
\`\`\`tool_call
{"tool": "write_file", "args": {"path": "test.txt"}}
\`\`\`
    `;
    
    const result = parseTextBlocks(input);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe("plan");
    expect(result[1].kind).toBe("tool_call");
  });
});
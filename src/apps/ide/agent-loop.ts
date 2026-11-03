// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The IDE agent's loop: ask the model, run the tools it calls (writes and commands wait for the
 * user's approval), feed the results back, repeat until it answers without calling a tool.
 *
 * Native mode (default): tools go to Ollama as function definitions and the reply streams token
 * by token. Models without tool support fall back to text mode, where the model writes fenced
 * ```tool_call blocks that are parsed out of the finished reply.
 */

import { randomUUID } from "node:crypto";
import { request } from "undici";
import type { ChatBackend, ToolSpec } from "../../inference-api/types.js";
import { READ_TOOLS, TOOL_DEFINITIONS, type IdeStreamEvent, type ToolName } from "./tool-types.js";
import { protectedToolPath } from "./tool-executor.js";

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[] } };
}

export interface ChatResult {
  content: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** One model call. `onDelta` receives reply text as it streams (native mode only). */
export type ChatFn = (req: { messages: ChatMessage[]; tools?: ToolSchema[] }, onDelta?: (text: string) => void) => Promise<ChatResult>;

export class ToolsUnsupportedError extends Error {}

/** The agent's tools as JSON-schema function definitions. */
export function toolSchemas(): ToolSchema[] {
  return TOOL_DEFINITIONS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type, description: p.description }])),
        required: Object.entries(t.parameters).filter(([, p]) => p.required).map(([k]) => k),
      },
    },
  }));
}

/**
 * A model call through any chat backend (the network, your machines, a reserved machine), in the
 * agent's ChatFn shape. `onSpent` hears what each call cost in cSats.
 */
export function backendChat(backend: ChatBackend, onSpent?: (cSats: number) => void, signal?: AbortSignal): ChatFn {
  return async ({ messages, tools }, onDelta) => {
    let content = "";
    const toolCalls: ChatResult["toolCalls"] = [];
    try {
      for await (const p of backend({ messages: messages.map((m) => ({ ...m, role: (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as "user" })), ...(tools ? { tools: tools as ToolSpec[] } : {}), temperature: 0.3 }, signal)) {
        if ("delta" in p) {
          content += p.delta;
          onDelta?.(p.delta);
        } else if ("toolCalls" in p) {
          for (const c of p.toolCalls) toolCalls.push({ name: c.function.name, arguments: c.function.arguments ?? {} });
        } else if (p.cSatsSpent !== undefined) onSpent?.(p.cSatsSpent);
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/does not support tools/i.test(msg)) throw new ToolsUnsupportedError(msg);
      throw err;
    }
    return { content, toolCalls };
  };
}

/** Ollama /api/chat, streamed. Throws ToolsUnsupportedError when the model has no tool support. */
export function ollamaChat(host: string, model: string, signal?: AbortSignal): ChatFn {
  return async ({ messages, tools }, onDelta) => {
    const res = await request(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        ...(tools ? { tools } : {}),
        stream: true,
        // Each agent step is a model call; a thinking model's reasoning pass made them ~17x slower.
        think: process.env.OLLAMA_THINK === "1",
        options: { temperature: 0.3 },
      }),
      headersTimeout: 120_000,
      bodyTimeout: 120_000,
      signal,
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      let error = text;
      try {
        error = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // plain text
      }
      if (/does not support tools/i.test(error)) throw new ToolsUnsupportedError(error);
      throw new Error(`Ollama: ${error || `HTTP ${res.statusCode}`}`);
    }
    let content = "";
    const toolCalls: ChatResult["toolCalls"] = [];
    let buffer = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      let chunk: { message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> }; error?: string };
      try {
        chunk = JSON.parse(line);
      } catch {
        return;
      }
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const delta = chunk.message?.content ?? "";
      if (delta) {
        content += delta;
        onDelta?.(delta);
      }
      for (const tc of chunk.message?.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!name) continue;
        let args = tc.function?.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        toolCalls.push({ name, arguments: (args && typeof args === "object" ? args : {}) as Record<string, unknown> });
      }
    };
    for await (const part of res.body) {
      buffer += Buffer.from(part as Uint8Array).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handle(line);
    }
    handle(buffer);
    return { content, toolCalls };
  };
}

interface Block {
  kind: "tool_call" | "plan";
  start: number;
  end: number;
  body: string;
}

/** Fenced ```tool_call and ```plan blocks in a text-mode reply, in order. */
export function parseTextBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const [kind, re] of [["tool_call", /```tool_call\s*\n([\s\S]*?)\n```/g], ["plan", /```plan\s*\n([\s\S]*?)\n```/g]] as const) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ kind, start: m.index, end: m.index + m[0].length, body: m[1] });
  }
  return out.sort((a, b) => a.start - b.start);
}

type PlanStatus = "pending" | "in_progress" | "completed" | "failed";

/** The steps of a ```plan block, or null when it isn't a JSON list of steps. */
export function parsePlan(body: string): Array<{ index: number; description: string; status: PlanStatus }> | null {
  try {
    const steps = JSON.parse(body) as Array<{ index?: number; description?: string; status?: string }>;
    if (!Array.isArray(steps)) return null;
    return steps.map((s, i) => ({ index: typeof s.index === "number" ? s.index : i, description: String(s.description ?? ""), status: (s.status as PlanStatus) || "pending" }));
  } catch {
    return null;
  }
}

/** The tool and arguments of a ```tool_call block, or null when malformed. */
export function parseToolCallBlock(body: string): { tool: string; args: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(body) as { tool?: unknown; args?: unknown };
    if (typeof parsed.tool !== "string" || !parsed.tool) return null;
    return { tool: parsed.tool, args: parsed.args && typeof parsed.args === "object" ? (parsed.args as Record<string, unknown>) : {} };
  } catch {
    return null;
  }
}

export interface AgentLoopDeps {
  chat: ChatFn;
  /** System prompt for the tool format in use. */
  systemPrompt: (format: "native" | "text") => string;
  /** The conversation so far (user and assistant turns). */
  messages: Array<{ role: string; content: string }>;
  sendEvent: (event: IdeStreamEvent) => void;
  isCancelled: () => boolean;
  /** Run one tool call (approval, checkpoint, events) and return the text the model sees. */
  runTool: (tool: ToolName, args: Record<string, unknown>) => Promise<string>;
  /** Start in native mode (default true; IDE_NATIVE_TOOLS=0 turns it off). */
  native?: boolean;
  maxIterations?: number;
  /** The tools offered to the model (default: every IDE tool). Calls to others are refused. */
  tools?: ToolSchema[];
}

const KNOWN_TOOLS = new Set<string>(TOOL_DEFINITIONS.map((t) => t.name));

export async function runAgentLoop(d: AgentLoopDeps): Promise<void> {
  let native = d.native ?? process.env.IDE_NATIVE_TOOLS !== "0";
  const tools = d.tools ?? toolSchemas();
  const known = d.tools ? new Set(d.tools.map((t) => t.function.name)) : KNOWN_TOOLS;
  const history = (format: "native" | "text"): ChatMessage[] => {
    const sys = d.systemPrompt(format);
    return [...(sys ? [{ role: "system", content: sys }] : []), ...d.messages];
  };
  let messages = history(native ? "native" : "text");
  const maxIterations = d.maxIterations ?? 20;
  // Separate replies (and text-mode segments) with a blank line instead of running them together.
  let emitted = false;
  let needBreak = false;
  let nudged = false;
  const say = (text: string) => {
    if (!text) return;
    d.sendEvent({ type: "text", content: needBreak && emitted ? `\n\n${text}` : text });
    emitted = true;
    needBreak = false;
  };

  for (let i = 0; i < maxIterations && !d.isCancelled(); i++) {
    needBreak = true;
    if (native) {
      let reply: ChatResult;
      try {
        reply = await d.chat({ messages, tools }, say);
      } catch (err) {
        if (err instanceof ToolsUnsupportedError) {
          // This model can't take tool definitions: continue in text mode from the same point.
          native = false;
          messages = [...history("text"), ...messages.filter((m) => m.role !== "system").slice(d.messages.length)];
          i--;
          continue;
        }
        say(`Error contacting model: ${(err as Error).message}`);
        return;
      }
      if (reply.toolCalls.length === 0) {
        // Small models sometimes write ```plan / ```tool_call blocks as text instead of calling tools.
        // The text is already on screen; act on the blocks so the turn doesn't just stop.
        const blocks = parseTextBlocks(reply.content);
        if (blocks.length === 0) return;
        const results: string[] = [];
        for (const b of blocks) {
          if (d.isCancelled()) return;
          if (b.kind === "plan") {
            const steps = parsePlan(b.body);
            if (steps) d.sendEvent({ type: "plan", steps, status: "proposed" });
            continue;
          }
          const call = parseToolCallBlock(b.body);
          if (!call) continue;
          const result = known.has(call.tool) ? await d.runTool(call.tool as ToolName, call.args) : `[Error]: unknown tool ${call.tool}`;
          results.push(`[Tool ${call.tool} result]: ${result}`);
        }
        messages.push({ role: "assistant", content: reply.content });
        if (results.length > 0) {
          messages.push({ role: "user", content: results.join("\n\n") });
        } else {
          // Only a plan: ask once for the first step as a real tool call.
          if (nudged) return;
          nudged = true;
          messages.push({ role: "user", content: "Carry out the plan now: call the tools for the first step (don't describe it, call it)." });
        }
        continue;
      }
      messages.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) });
      for (const call of reply.toolCalls) {
        if (d.isCancelled()) return;
        const result = known.has(call.name)
          ? await d.runTool(call.name as ToolName, call.arguments)
          : `[Error]: unknown tool ${call.name}`;
        messages.push({ role: "tool", content: result, tool_name: call.name });
      }
      continue;
    }

    // Text mode: the whole reply, then its fenced blocks.
    let content: string;
    try {
      content = (await d.chat({ messages })).content;
    } catch (err) {
      say(`Error contacting model: ${(err as Error).message}`);
      return;
    }
    if (!content.trim()) return;
    const blocks = parseTextBlocks(content);
    if (blocks.length === 0) {
      say(content);
      return;
    }
    let cursor = 0;
    let hadToolCall = false;
    const results: string[] = [];
    for (const b of blocks) {
      const before = content.slice(cursor, b.start).trim();
      if (before) {
        needBreak = true;
        say(before);
      }
      cursor = b.end;
      if (b.kind === "plan") {
        const steps = parsePlan(b.body);
        if (steps) d.sendEvent({ type: "plan", steps, status: "proposed" });
        else say(b.body);
        continue;
      }
      const call = parseToolCallBlock(b.body);
      if (!call) {
        say(`(malformed tool call: ${b.body})`);
        continue;
      }
      hadToolCall = true;
      if (d.isCancelled()) return;
      const name = call.tool;
      const result = known.has(name) ? await d.runTool(name as ToolName, call.args) : `[Error]: unknown tool ${name}`;
      results.push(`[Tool ${name} result]: ${result}`);
    }
    const trailing = content.slice(cursor).trim();
    if (trailing) {
      needBreak = true;
      say(trailing);
    }
    messages.push({ role: "assistant", content });
    if (results.length > 0) messages.push({ role: "user", content: results.join("\n\n") });
    if (!hadToolCall) return;
  }
}

export interface ToolRunnerDeps {
  execute: (tool: ToolName, args: Record<string, unknown>, opts: { approved: boolean }) => Promise<{ result?: string; error?: string }>;
  sendEvent: (event: IdeStreamEvent) => void;
  /** Resolves true when the user approves the call (false on reject, timeout or disconnect). */
  waitForApproval: (callId: string, tool: ToolName, args: Record<string, unknown>) => Promise<boolean>;
  /** Keep a file's original before the turn first writes it; returns the tracked path or null. */
  captureBeforeWrite: (path: string) => string | null;
  turnId: string;
  /** Apply write_file / edit_file without asking (the turn's checkpoint keeps them undoable). */
  autoApproveEdits?: boolean;
  /** Honour IDE_SHELL_AUTO_APPROVE=1 (default true; bots pass false so their commands always ask). */
  allowShellAutoApprove?: boolean;
}

/** One tool call: announce it, wait for approval when needed, checkpoint writes, run, report. */
export function makeToolRunner(d: ToolRunnerDeps): AgentLoopDeps["runTool"] {
  return async (tool, args) => {
    const callId = `tc_${randomUUID().slice(0, 8)}`;
    // #4: run_shell always needs approval unless the local user opted in with IDE_SHELL_AUTO_APPROVE=1
    // (the executor's allowlist/metacharacter policy still applies to auto-approved commands).
    const shellAutoApprove = d.allowShellAutoApprove !== false && tool === "run_shell" && process.env.IDE_SHELL_AUTO_APPROVE === "1";
    // Edits to the git directory or to files tooling executes (.gitmodules, .husky/, ...) are never
    // auto-approved; the executor refuses .git outright and the rest without an explicit approval.
    const editAutoApprove =
      d.autoApproveEdits === true && (tool === "write_file" || tool === "edit_file") && protectedToolPath(args.path) === null;
    const requiresApproval = !READ_TOOLS.has(tool) && !shellAutoApprove && !editAutoApprove;
    d.sendEvent({ type: "tool_call", id: callId, tool, args, requires_approval: requiresApproval });
    if (requiresApproval && !(await d.waitForApproval(callId, tool, args))) {
      const msg = `Tool call ${tool} was rejected by the user.`;
      d.sendEvent({ type: "tool_result", id: callId, error: msg });
      return `[Rejected]: ${msg}`;
    }
    const writesFile = tool === "write_file" || tool === "edit_file";
    const tracked = writesFile ? d.captureBeforeWrite(String(args.path ?? "")) : null;
    // `approved` means the user approved this call; auto-approved edits don't count.
    const result = await d.execute(tool, args, { approved: requiresApproval });
    if (tracked && !result.error) d.sendEvent({ type: "file_change", turnId: d.turnId, path: tracked });
    if (tool === "run_shell" && result.result) {
      try {
        const shell = JSON.parse(result.result) as { stdout: string; stderr: string; exit_code: number };
        d.sendEvent({ type: "shell_output", id: callId, stdout: shell.stdout, stderr: shell.stderr, exit_code: shell.exit_code });
      } catch {
        d.sendEvent({ type: "tool_result", id: callId, result: result.result, error: result.error });
      }
    } else {
      d.sendEvent({ type: "tool_result", id: callId, result: result.result, error: result.error });
    }
    return result.error ? `[Error]: ${result.error}` : result.result ?? "(no output)";
  };
}

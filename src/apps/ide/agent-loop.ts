// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The IDE agent's loop: ask the model, run the tools it calls (writes and commands wait for the
 * user's approval), feed the results back, repeat until it answers without calling a tool.
 *
 * Native mode (default): tools go to Ollama as function definitions and the reply streams token
 * by token. Models without tool support fall back to text mode, where the model writes fenced
 * ```tool_call blocks that are parsed out of the finished reply.
 *
 * Either way, a tool call the model wrote as JSON text instead of calling the tool
 * (text-tool-calls.ts: `{"name": …, "arguments": …}`, fenced, in <tool_call> tags, several in a
 * row) is kept off the screen and run as a real call, with the same permission checks.
 */

import { randomUUID } from "node:crypto";
import { request } from "undici";
import type { ChatBackend, ChatMedia, ToolSpec } from "../../inference-api/types.js";
import { thisComputer } from "../../inference-api/backends.js";
import { READ_TOOLS, TOOL_DEFINITIONS, type IdeStreamEvent, type ToolName } from "./tool-types.js";
import { protectedToolPath } from "./tool-executor.js";
import { extractTextToolCalls, TextToolCallFilter } from "./text-tool-calls.js";
import { COMPACT_AT, compactMessages, DEFAULT_CONTEXT_WINDOW, isContextTooLong, isTransient, pathsLine, shouldCompact } from "./context-budget.js";

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
  /** Images / PDFs on a user message: set only when the model takes them (attachments.ts). */
  media?: ChatMedia[];
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[] } };
}

export interface ChatResult {
  content: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Where the call ran, when the backend said (tool-types.ts usage.served). */
  served?: Extract<IdeStreamEvent, { type: "usage" }>["served"];
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
 * agent's ChatFn shape. `onSpent` hears what each call cost in cSats and where it ran.
 */
export function backendChat(backend: ChatBackend, onSpent?: (cSats: number, served?: ChatResult["served"]) => void, signal?: AbortSignal): ChatFn {
  return async ({ messages, tools }, onDelta) => {
    let content = "";
    const toolCalls: ChatResult["toolCalls"] = [];
    let served: ChatResult["served"];
    try {
      for await (const p of backend({ messages: messages.map((m) => ({ ...m, role: (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as "user" })), ...(tools ? { tools: tools as ToolSpec[] } : {}), temperature: 0.3 }, signal)) {
        if ("delta" in p) {
          content += p.delta;
          onDelta?.(p.delta);
        } else if ("toolCalls" in p) {
          for (const c of p.toolCalls) toolCalls.push({ name: c.function.name, arguments: c.function.arguments ?? {} });
        } else if ("done" in p) {
          served = p.served;
          if (p.cSatsSpent !== undefined || p.served) onSpent?.(p.cSatsSpent ?? 0, p.served);
        }
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/does not support tools/i.test(msg)) throw new ToolsUnsupportedError(msg);
      throw err;
    }
    return { content, toolCalls, ...(served ? { served } : {}) };
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
    let stats: { promptTokens?: number; outputTokens?: number; promptMs?: number; genMs?: number } = {};
    const handle = (line: string) => {
      if (!line.trim()) return;
      let chunk: { message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> }; error?: string; done?: boolean; prompt_eval_count?: number; eval_count?: number; prompt_eval_duration?: number; eval_duration?: number };
      try {
        chunk = JSON.parse(line);
      } catch {
        return;
      }
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      if (chunk.done) {
        const ms = (ns: unknown) => (typeof ns === "number" && ns > 0 ? Math.round(ns / 1e6) : undefined);
        stats = { promptTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count, promptMs: ms(chunk.prompt_eval_duration), genMs: ms(chunk.eval_duration) };
      }
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
    return { content, toolCalls, served: thisComputer(stats) };
  };
}

interface Block {
  kind: "tool_call" | "plan";
  start: number;
  end: number;
  body: string;
}

/** A parameter value from a qwen3-coder XML call: numbers and booleans typed, the rest text. */
function xmlParamValue(raw: string): unknown {
  const v = raw.replace(/^\n/, "").replace(/\n$/, "");
  if (/^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
  if (v.trim() === "true" || v.trim() === "false") return v.trim() === "true";
  return v;
}

/**
 * Fenced ```tool_call and ```plan blocks in a text-mode reply, in order.
 *
 * Also qwen3-coder's own XML calls (`<function=read_file><parameter=path>a.ts</parameter></function>`,
 * optionally inside `<tool_call>`): a runtime whose tool parser does not know that format passes
 * them through as text (seen from qwen3-coder:30b on the network), and the turn would stop at
 * the first step. They become tool_call blocks with a JSON body ({ tool, args }).
 */
export function parseTextBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const [kind, re] of [["tool_call", /```tool_call\s*\n([\s\S]*?)\n```/g], ["plan", /```plan\s*\n([\s\S]*?)\n```/g]] as const) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ kind, start: m.index, end: m.index + m[0].length, body: m[1] });
  }
  const xml = /(?:<tool_call>\s*)?<function=([\w.-]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
  let m: RegExpExecArray | null;
  while ((m = xml.exec(text)) !== null) {
    if (out.some((b) => m!.index >= b.start && m!.index < b.end)) continue; // inside a fenced block
    const args: Record<string, unknown> = {};
    const param = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g;
    let p: RegExpExecArray | null;
    while ((p = param.exec(m[2])) !== null) args[p[1]] = xmlParamValue(p[2]);
    out.push({ kind: "tool_call", start: m.index, end: m.index + m[0].length, body: JSON.stringify({ tool: m[1], args }) });
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
  messages: Array<{ role: string; content: string; media?: ChatMedia[] }>;
  sendEvent: (event: IdeStreamEvent) => void;
  isCancelled: () => boolean;
  /** Run one tool call (approval, checkpoint, events) and return the text the model sees. */
  runTool: (tool: ToolName, args: Record<string, unknown>) => Promise<string>;
  /** Start in native mode (default true; IDE_NATIVE_TOOLS=0 turns it off). */
  native?: boolean;
  maxIterations?: number;
  /** The tools offered to the model (default: every IDE tool). Calls to others are refused. */
  tools?: ToolSchema[];
  /**
   * The target model's context window in tokens (the coordinator's /inference/models, the network
   * world, or the local runtime), asked once per turn; unknown: DEFAULT_CONTEXT_WINDOW.
   */
  contextWindow?: number | (() => Promise<number | undefined> | number | undefined);
  /** A cheap model call (a small or auto model) that summarizes older messages when compacting. */
  summarize?: (text: string) => Promise<string | null>;
  /** Waits before retrying a transient model-call failure (default 1.5 s, then 4 s). */
  retryDelaysMs?: number[];
  /**
   * A reply that only announces work ("I'll start by checking the project…") with no tool call gets
   * one "go ahead" instead of ending the turn. Bots set this: nobody is watching to say "go on".
   */
  continueOnIntent?: boolean;
  /**
   * With continueOnIntent: the go-ahead got another plan and still no tool call. Switch the model
   * calls to the next model in the ranking and return true to retry that step once there (a bot on
   * a model that only describes work); false when there's nowhere else to go, and the turn ends.
   */
  escalate?: () => boolean;
}

/** What the model hears when it announced work and stopped. */
export const GO_AHEAD = "Go ahead: do that now by calling the tools (don't describe it, call them). When you're done, reply with a short summary.";

/**
 * True when a reply's last paragraph only says what it's about to do ("I'll start by checking…",
 * "Let me look at…", "Next, I'll…") rather than reporting or asking: the work hasn't happened yet.
 */
export function announcesWork(text: string): boolean {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = (paras[paras.length - 1] ?? "").replace(/^[*_>#\s-]+/, "");
  if (!last || last.length > 600 || /\?\s*$/.test(last)) return false;
  return (
    /^(?:(?:ok(?:ay)?|sure|great|alright|got it|understood)[,.!]?\s+)?(?:(?:first|next|now|then)[,]?\s+)?(?:i'?ll|i will|i'm going to|i am going to|let me|let's|i need to|i'm about to|i am about to)\b/i.test(last) ||
    /^next steps?\s*:/im.test(last)
  );
}

/**
 * True when a reply lays out steps it hasn't taken: a numbered or bulleted list of at least two
 * steps ("1. **Identify Relevant Files**: …", "- Read and summarize …"), or a "Plan:"/"Steps:"
 * heading, and no question for the user at the end. With asksToAct, the go-ahead fires on it.
 */
export function listsSteps(text: string): boolean {
  const t = text.trim();
  if (!t || /\?\s*$/.test(t)) return false;
  const steps = t.split("\n").filter((l) => /^\s*(?:\d+[.)]|[-*•]|step \d+[:.])\s+\S/i.test(l)).length;
  return steps >= 2 || /^\s*(?:#+\s*)?(?:\*\*)?(?:plan|steps|approach|here'?s (?:my|the) plan)\b[^\n]{0,40}:?\s*$/im.test(t);
}

/**
 * True when the user's message asks for something to be done ("do it", "read all of the files in
 * those folders", "go ahead", "fix the tests"), not only explained.
 */
export function asksToAct(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(?:do (?:it|that|this|so)|go ahead|go on|proceed|continue|start|begin|read|look (?:at|through|in)|check|open|list|fix|run|write|create|update|review|find|search|summari[sz]e|implement|make|add|edit|change|delete|remove|install|clone|commit|push|test)\b/i.test(text);
}

/** Sleeps that stop early when the turn is cancelled. */
function pause(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => (cancelled() || Date.now() >= end ? resolve() : setTimeout(tick, Math.min(100, end - Date.now())));
    tick();
  });
}

/** "read_file(src/a.ts)": a tool call in a few words, for summaries of compacted results. */
function callLabel(tool: string, args: Record<string, unknown>, result: string): string {
  const main = args.path ?? args.command ?? args.pattern ?? args.query ?? "";
  const lines = result ? result.split("\n").length : 0;
  const what = result.startsWith("[Error]") || result.startsWith("[Rejected]") ? result.split("\n")[0].slice(0, 120) : `${lines} line${lines === 1 ? "" : "s"}`;
  return `${tool}(${String(main).slice(0, 120)}): ${what}`;
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
  // Context: the request being worked on stays whole; tool results get a label for summaries.
  const pinned = (msgs: ChatMessage[]) => [...msgs].reverse().find((m) => m.role === "user" && !m.content.startsWith("[Tool "));
  let request = pinned(messages);
  const labels = new WeakMap<ChatMessage, string>();
  const paths: string[] = [];
  let window = DEFAULT_CONTEXT_WINDOW;
  try {
    const w = typeof d.contextWindow === "function" ? await d.contextWindow() : d.contextWindow;
    if (typeof w === "number" && Number.isFinite(w) && w >= 2048) window = w;
  } catch {
    // keep the default
  }
  const runTool = async (tool: ToolName, args: Record<string, unknown>): Promise<{ result: string; label: string }> => {
    for (const k of ["path", "file"]) {
      const p = args[k];
      if (typeof p === "string" && p.trim()) {
        const i = paths.indexOf(p.trim());
        if (i >= 0) paths.splice(i, 1);
        paths.push(p.trim());
        if (paths.length > 30) paths.shift();
      }
    }
    const result = await d.runTool(tool, args);
    return { result, label: callLabel(tool, args, result) };
  };
  const compact = async (share: number) => {
    const before = messages.length;
    const r = await compactMessages(messages, { budget: window * share, tools: native ? tools : undefined, pinned: request, labels, paths, summarize: d.summarize });
    messages.splice(0, messages.length, ...r.messages);
    d.sendEvent({ type: "status", message: `Compacted the conversation to fit the model's ${Math.round(window / 1024)}k context (${r.summarized ? "summarized" : "shortened"} ${Math.max(r.dropped, before - messages.length) || "older"} messages; recent ones and file paths kept).` });
  };
  /** One model call: compacts first when needed, compacts and retries once on context_too_long, retries transient failures. */
  const callModel = async (withTools: boolean, onDelta?: (t: string) => void): Promise<ChatResult> => {
    let compactedForError = false;
    let transient = 0;
    const delays = d.retryDelaysMs ?? [1_500, 4_000];
    for (;;) {
      if (shouldCompact(messages, withTools ? tools : undefined, window)) await compact(COMPACT_AT - 0.15);
      let streamed = false;
      try {
        return await d.chat(withTools ? { messages, tools } : { messages }, onDelta ? (t) => {
          if (t) streamed = true;
          onDelta(t);
        } : undefined);
      } catch (err) {
        if (err instanceof ToolsUnsupportedError || d.isCancelled()) throw err;
        if (isContextTooLong(err) && !compactedForError) {
          compactedForError = true;
          // The model's window is smaller than assumed: take the coordinator's figure when it gave one.
          const m = /serves (\d+)|largestContextWindow\D+(\d+)/.exec((err as Error).message ?? "");
          const reported = m ? Number(m[1] ?? m[2]) : NaN;
          if (Number.isFinite(reported) && reported >= 2048 && reported < window) window = reported;
          await compact(0.6);
          continue;
        }
        if (isTransient(err) && !streamed && transient < 2) {
          transient++;
          const wait = delays[Math.min(transient - 1, delays.length - 1)] ?? 0;
          d.sendEvent({ type: "status", message: `The model call failed (${((err as Error).message ?? String(err)).split("\n")[0].slice(0, 120)}); retrying (${transient}/2)…` });
          await pause(wait, d.isCancelled);
          if (d.isCancelled()) throw err;
          continue;
        }
        throw err;
      }
    }
  };
  const failed = (err: unknown) => {
    const where = pathsLine(paths);
    say(`Error contacting model: ${(err as Error).message}${where ? `\n\n(${where}.)` : ""}`);
  };
  // Separate replies (and text-mode segments) with a blank line instead of running them together.
  let emitted = false;
  let needBreak = false;
  let nudged = false;
  let intentNudged = false;
  let escalated = false;
  /** The reply describes work instead of doing it: it announces the work, or lists steps the user asked to have done. */
  const describesWork = (content: string) => announcesWork(content) || (listsSteps(content) && asksToAct(request?.content));
  /**
   * One "go ahead" when a reply only announced or planned work (continueOnIntent). When the reply to
   * the go-ahead is again only a plan, the step is retried once on the next model (escalate).
   */
  const goAhead = (content: string): boolean => {
    if (!d.continueOnIntent || !describesWork(content)) return false;
    if (!intentNudged) {
      intentNudged = true;
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: GO_AHEAD });
      return true;
    }
    if (escalated || !d.escalate?.()) return false;
    escalated = true;
    // Same conversation (ending with the go-ahead), next model; this reply is left out.
    d.sendEvent({ type: "status", message: "The model described the work but didn't use any tools; trying the next model." });
    return true;
  };
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
      // Tool calls written as text are held back from the screen while they stream, then run.
      const filter = new TextToolCallFilter(known);
      try {
        reply = await callModel(true, (t) => say(filter.push(t)));
        say(filter.end());
      } catch (err) {
        say(filter.end());
        if (err instanceof ToolsUnsupportedError) {
          // This model can't take tool definitions: continue in text mode from the same point.
          native = false;
          const sys = history("text").filter((m) => m.role === "system");
          messages = [...sys, ...messages.filter((m) => m.role !== "system")];
          request = pinned(messages);
          i--;
          continue;
        }
        if (d.isCancelled()) return;
        failed(err);
        return;
      }
      if (reply.toolCalls.length === 0) {
        // A backend that didn't stream gives the whole reply at the end.
        const written = filter.streamed ? { text: filter.text, calls: filter.calls } : extractTextToolCalls(reply.content, known);
        if (written.calls.length > 0) reply = { ...reply, content: written.text.trim(), toolCalls: written.calls };
      }
      if (reply.toolCalls.length === 0) {
        // Small models sometimes write ```plan / ```tool_call blocks as text instead of calling tools.
        // The text is already on screen; act on the blocks so the turn doesn't just stop.
        const blocks = parseTextBlocks(reply.content);
        if (blocks.length === 0) {
          if (goAhead(reply.content)) continue;
          return;
        }
        const results: string[] = [];
        const resultLabels: string[] = [];
        for (const b of blocks) {
          if (d.isCancelled()) return;
          if (b.kind === "plan") {
            const steps = parsePlan(b.body);
            if (steps) d.sendEvent({ type: "plan", steps, status: "proposed" });
            continue;
          }
          const call = parseToolCallBlock(b.body);
          if (!call) continue;
          const r = known.has(call.tool) ? await runTool(call.tool as ToolName, call.args) : { result: `[Error]: unknown tool ${call.tool}`, label: `${call.tool}: unknown tool` };
          results.push(`[Tool ${call.tool} result]: ${r.result}`);
          resultLabels.push(r.label);
        }
        messages.push({ role: "assistant", content: reply.content });
        if (results.length > 0) {
          const m: ChatMessage = { role: "user", content: results.join("\n\n") };
          labels.set(m, resultLabels.join("; "));
          messages.push(m);
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
        const r = known.has(call.name)
          ? await runTool(call.name as ToolName, call.arguments)
          : { result: `[Error]: unknown tool ${call.name}`, label: `${call.name}: unknown tool` };
        const m: ChatMessage = { role: "tool", content: r.result, tool_name: call.name };
        labels.set(m, r.label);
        messages.push(m);
      }
      continue;
    }

    // Text mode: the whole reply, then its fenced blocks.
    let content: string;
    try {
      content = (await callModel(false)).content;
    } catch (err) {
      if (d.isCancelled()) return;
      failed(err);
      return;
    }
    if (!content.trim()) return;
    const blocks = parseTextBlocks(content);
    if (blocks.length === 0) {
      // JSON tool calls instead of ```tool_call blocks: run them the same way.
      const written = extractTextToolCalls(content, known);
      if (written.calls.length > 0) {
        say(written.text.trim());
        const results: string[] = [];
        const resultLabels: string[] = [];
        for (const call of written.calls) {
          if (d.isCancelled()) return;
          const r = await runTool(call.name as ToolName, call.arguments);
          results.push(`[Tool ${call.name} result]: ${r.result}`);
          resultLabels.push(r.label);
        }
        messages.push({ role: "assistant", content });
        const m: ChatMessage = { role: "user", content: results.join("\n\n") };
        labels.set(m, resultLabels.join("; "));
        messages.push(m);
        continue;
      }
      say(content);
      if (goAhead(content)) continue;
      return;
    }
    let cursor = 0;
    let hadToolCall = false;
    const results: string[] = [];
    const resultLabels: string[] = [];
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
      const r = known.has(name) ? await runTool(name as ToolName, call.args) : { result: `[Error]: unknown tool ${name}`, label: `${name}: unknown tool` };
      results.push(`[Tool ${name} result]: ${r.result}`);
      resultLabels.push(r.label);
    }
    const trailing = content.slice(cursor).trim();
    if (trailing) {
      needBreak = true;
      say(trailing);
    }
    messages.push({ role: "assistant", content });
    if (results.length > 0) {
      const m: ChatMessage = { role: "user", content: results.join("\n\n") };
      labels.set(m, resultLabels.join("; "));
      messages.push(m);
    }
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
  /** Apply write_file / edit_file without asking (the turn's checkpoint keeps them undoable). A function is asked per call. */
  autoApproveEdits?: boolean | (() => boolean);
  /**
   * Calls the user already approved "always" (a shared session: a command name). They run without
   * asking and count as approved; never consulted for ALWAYS_ASK_TOOLS.
   */
  alwaysAllowed?: (tool: ToolName, args: Record<string, unknown>) => boolean;
  /** Honour IDE_SHELL_AUTO_APPROVE=1 (default true; bots pass false so their commands always ask). */
  allowShellAutoApprove?: boolean;
  /**
   * Resolve a call's arguments before asking (open_pull_request: the branch, base and diffstat the
   * approval card shows). What the user approves is exactly what runs. A throw refuses the call.
   */
  prepare?: (tool: ToolName, args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/** Tools that ask every time, whatever auto-approve settings say. */
export const ALWAYS_ASK_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["open_pull_request", "git_push", "git_commit"]);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** One tool call: announce it, wait for approval when needed, checkpoint writes, run, report. */
export function makeToolRunner(d: ToolRunnerDeps): AgentLoopDeps["runTool"] {
  return async (tool, rawArgs) => {
    const callId = `tc_${randomUUID().slice(0, 8)}`;
    let args = rawArgs;
    if (d.prepare) {
      try {
        args = await d.prepare(tool, rawArgs);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        d.sendEvent({ type: "tool_call", id: callId, tool, args: rawArgs, requires_approval: false });
        d.sendEvent({ type: "tool_result", id: callId, error: msg });
        return `[Error]: ${msg}`;
      }
    }
    // One immutable copy is shown, approved and executed, so nothing can change it in between.
    args = deepFreeze(structuredClone(args));
    // #4: run_shell always needs approval unless the local user opted in with IDE_SHELL_AUTO_APPROVE=1
    // (the executor's allowlist/metacharacter policy still applies to auto-approved commands).
    const shellAutoApprove = d.allowShellAutoApprove !== false && tool === "run_shell" && process.env.IDE_SHELL_AUTO_APPROVE === "1";
    // Edits to the git directory or to files tooling executes (.gitmodules, .husky/, ...) are never
    // auto-approved; the executor refuses .git outright and the rest without an explicit approval.
    const autoEdits = typeof d.autoApproveEdits === "function" ? d.autoApproveEdits() : d.autoApproveEdits === true;
    const editAutoApprove = autoEdits && (tool === "write_file" || tool === "edit_file") && protectedToolPath(args.path) === null;
    const always = !ALWAYS_ASK_TOOLS.has(tool) && !READ_TOOLS.has(tool) && d.alwaysAllowed?.(tool, args) === true;
    const requiresApproval = ALWAYS_ASK_TOOLS.has(tool) || (!READ_TOOLS.has(tool) && !shellAutoApprove && !editAutoApprove && !always);
    d.sendEvent({ type: "tool_call", id: callId, tool, args, requires_approval: requiresApproval });
    if (requiresApproval && !(await d.waitForApproval(callId, tool, args))) {
      const msg = `Tool call ${tool} was rejected by the user.`;
      d.sendEvent({ type: "tool_result", id: callId, error: msg });
      return `[Rejected]: ${msg}`;
    }
    const writesFile = tool === "write_file" || tool === "edit_file";
    const tracked = writesFile ? d.captureBeforeWrite(String(args.path ?? "")) : null;
    // `approved` means the user approved this call; auto-approved edits don't count.
    const result = await d.execute(tool, args, { approved: requiresApproval || always });
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

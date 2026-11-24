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
import { READ_TOOLS, TENTACLE_TOOLS, TOOL_DEFINITIONS, WEB_TOOLS, type IdeStreamEvent, type ToolName } from "./tool-types.js";
import { PLAN_REFUSAL, type Decision } from "./permission-policy.js";
import { protectedToolPath } from "./tool-executor.js";
import { editKey, runsEditedFile } from "./edited-runs.js";
import { SANDBOX_UNAVAILABLE } from "./sandbox.js";
import { reportToolResult } from "./tool-report.js";
import { extractTextToolCalls, TextToolCallFilter } from "./text-tool-calls.js";
import { COMPACT_AT, compactMessages, compactThreshold, DEFAULT_CONTEXT_WINDOW, estimateTokens, isContextTooLong, isTransient, pathsLine, REPLY_RESERVE_TOKENS } from "./context-budget.js";
import type { CostCheckContext, CostVerdict } from "./cost-guard.js";
import { TurnWaste } from "./turn-waste.js";

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
/** `onSpent`'s third argument: the backend's own `where` for the call (Auto's "routed to <model> on <class> …"). */
export function backendChat(backend: ChatBackend, onSpent?: (cSats: number, served?: ChatResult["served"], where?: string) => void, signal?: AbortSignal): ChatFn {
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
          if (p.cSatsSpent !== undefined || p.served) onSpent?.(p.cSatsSpent ?? 0, p.served, p.where);
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
  /**
   * A lead paid per token (frontier key, network or cloud model): compact once a call's prompt
   * passes this many tokens even when the window is far bigger (context-budget.ts compactThreshold).
   * Unset: 85% of the window only.
   */
  compactAtTokens?: number | null;
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
  /**
   * Plan mode: only read-only tools are offered (and other calls are refused here and by the tool
   * runner's decide), the system prompt asks for a plan, and no "go ahead" nudges fire: the turn
   * ends with the plan for the user to approve.
   */
  plan?: boolean;
  /**
   * Tool calls the server makes before the model's first turn (web grounding: one web_search for a
   * question that needs fresh facts, src/web-tool/tools.ts groundingSearch). Each runs through
   * runTool like a model's call (permission, events, billing), and goes into the conversation as the
   * assistant's own tool call and its result, so the model answers from it (and may search more).
   */
  prefetch?: Array<{ tool: ToolName; args: Record<string, unknown> }>;
  /**
   * Rewrites the answer's text as it streams (web: drops "I have no real-time access" sentences once
   * results were given, DisclaimerFilter). end() is called when the loop finishes.
   */
  textFilter?: { push(text: string): string; end(): string };
  /**
   * The per-reply cost check of a paid lead (cost-guard.ts makeCostCheck), asked before each model
   * call after the first: go on, stop the turn with a note, or go on with a cheaper model's calls.
   */
  costCheck?: (ctx: CostCheckContext) => Promise<CostVerdict>;
  /**
   * Waste tracking (turn-waste.ts): re-reads of an unchanged file get a short pointer instead of the
   * content (always, when set). With `act` (a paid lead), the first sign of waste compacts older tool
   * results and, with `helpers`, steers lookups to helpers; `stamp` gives a file's mtime/size.
   */
  waste?: { stamp?: (path: string) => string | null; act?: boolean; helpers?: boolean };
}

/** What the lead hears when the turn looks wasteful and helpers are on. */
export const HELPERS_NUDGE =
  "[EdgeCoder: this reply is reading a lot and re-reading files. Hand broad lookups (finding where something is, reading many files, summarizing a folder) to helpers with the delegate tool and work from their short reports; keep your own reads to the exact lines you need.]";

/** Added to the system prompt in plan mode. */
export const PLAN_PROMPT = [
  "PLAN MODE: the user wants a plan before any change is made.",
  "Investigate with read-only tools only (read_file, list_directory, search_files, search_codebase, git_status, git_diff, git_log, and read-only shell commands such as ls, cat, grep, git status).",
  "Do not write or edit files, run tests, install anything, commit or push: those calls are refused until the user approves the plan.",
  "When you understand the task, reply with the plan: a short summary, then numbered steps naming the files you'll change and how you'll verify the work. End there; the user will approve it or ask for changes.",
].join(" ");

/** Tools plan mode offers: the read-only ones and run_shell (read-only commands only). */
export function planTools(tools: ToolSchema[]): ToolSchema[] {
  // The web tool (when offered) changes nothing, so a plan may use it.
  return tools.filter((t) => READ_TOOLS.has(t.function.name as ToolName) && !TENTACLE_TOOLS.has(t.function.name as ToolName) || t.function.name === "run_shell" || WEB_TOOLS.has(t.function.name as ToolName));
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

/** A native tool call or result as the text format writes it (```tool_call block, "[Tool x result]: …"). */
function asTextFormat(m: ChatMessage): ChatMessage {
  if (m.role === "tool") return { role: "user", content: `[Tool ${m.tool_name ?? "tool"} result]: ${m.content}` };
  if (m.role === "assistant" && m.tool_calls?.length) {
    const blocks = m.tool_calls.map((c) => "```tool_call\n" + JSON.stringify({ tool: c.function.name, args: c.function.arguments }) + "\n```");
    return { role: "assistant", content: [m.content, ...blocks].filter(Boolean).join("\n\n") };
  }
  return m;
}

export async function runAgentLoop(d: AgentLoopDeps): Promise<void> {
  let native = d.native ?? process.env.IDE_NATIVE_TOOLS !== "0";
  const allTools = d.tools ?? toolSchemas();
  const tools = d.plan ? planTools(allTools) : allTools;
  // Calls to tools plan mode doesn't offer still reach runTool, which refuses them with a reason.
  const known = d.tools ? new Set(d.tools.map((t) => t.function.name)) : KNOWN_TOOLS;
  const history = (format: "native" | "text"): ChatMessage[] => {
    const base = d.systemPrompt(format);
    const sys = d.plan ? [base, PLAN_PROMPT].filter(Boolean).join("\n\n") : base;
    return [...(sys ? [{ role: "system", content: sys }] : []), ...d.messages];
  };
  let messages = history(native ? "native" : "text");
  // The model calls go here; a cost check's "Switch" replaces it for the rest of the turn.
  let chat = d.chat;
  const waste = d.waste ? new TurnWaste({ stamp: d.waste.stamp }) : null;
  /** Read results the waste tracker is waiting to attach to their conversation message. */
  let pendingReadKeys: string[] = [];
  // Long enough for real repo work (a lead reading a dozen files, editing and testing); a turn that
  // still runs out says so instead of ending silently (see the end of loop()).
  const maxIterations = d.maxIterations ?? 40;
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
    // Plan mode, first gate: nothing but read tools and (read-only, checked by the runner) commands.
    if (d.plan && !(READ_TOOLS.has(tool) && !TENTACLE_TOOLS.has(tool)) && tool !== "run_shell" && !WEB_TOOLS.has(tool)) {
      const callId = `tc_${randomUUID().slice(0, 8)}`;
      d.sendEvent({ type: "tool_call", id: callId, tool, args, requires_approval: false });
      d.sendEvent({ type: "tool_result", id: callId, error: PLAN_REFUSAL });
      return { result: `[Refused]: ${PLAN_REFUSAL}`, label: `${tool}: refused (plan mode)` };
    }
    waste?.beforeTool(tool, args);
    const result = await d.runTool(tool, args);
    const label = callLabel(tool, args, result);
    if (waste && tool === "read_file") {
      const r = waste.afterRead(args, result, (ref) => messages.includes(ref as ChatMessage));
      if (r.key) pendingReadKeys.push(r.key);
      return { result: r.text, label };
    }
    return { result, label };
  };
  /** The message now holding the latest reads' full results (the re-read pointer refers to it). */
  const attachReads = (m: ChatMessage) => {
    if (!waste) return;
    for (const k of pendingReadKeys) waste.attach(k, m);
    pendingReadKeys = [];
  };
  /** Compact to fit `budget` tokens; says so in a status line and a `compacted` event (tokens saved). */
  const compact = async (budget: number, tools?: ToolSchema[], paid = false) => {
    const before = messages.length;
    const beforeTokens = estimateTokens(messages, tools);
    const r = await compactMessages(messages, { budget, tools: native ? tools : undefined, pinned: request, labels, paths, summarize: d.summarize });
    messages.splice(0, messages.length, ...r.messages);
    const afterTokens = estimateTokens(messages, tools);
    const why = paid ? `to save tokens (paid models compact past ${Math.round(budget / 1000 / ((COMPACT_AT - 0.15) / COMPACT_AT))}K tokens)` : `to fit the model's ${Math.round(window / 1024)}k context`;
    d.sendEvent({ type: "status", message: `Compacted the conversation ${why} (${r.summarized ? "summarized" : "shortened"} ${Math.max(r.dropped, before - messages.length) || "older"} messages; recent ones and file paths kept).` });
    d.sendEvent({ type: "compacted", before: beforeTokens, after: afterTokens, savedTokens: Math.max(0, beforeTokens - afterTokens), summarized: r.summarized });
  };
  /** One model call: compacts first when needed, compacts and retries once on context_too_long, retries transient failures. */
  const callModel = async (withTools: boolean, onDelta?: (t: string) => void): Promise<ChatResult> => {
    let compactedForError = false;
    let transient = 0;
    const delays = d.retryDelaysMs ?? [1_500, 4_000];
    for (;;) {
      const offered = withTools ? tools : undefined;
      // Free models: 85% of the window. Paid leads: also at most compactAtTokens (80K by default).
      const at = compactThreshold(window, d.compactAtTokens);
      if (estimateTokens(messages, offered) > at) await compact(at * ((COMPACT_AT - 0.15) / COMPACT_AT), offered, at < window * COMPACT_AT);
      // The prompt this call sends, for the chat's context meter.
      d.sendEvent({ type: "context", tokens: estimateTokens(messages, offered), window });
      let streamed = false;
      try {
        const sent = waste ? estimateTokens(messages, offered) - REPLY_RESERVE_TOKENS : 0;
        const r = await chat(withTools ? { messages, tools } : { messages }, onDelta ? (t) => {
          if (t) streamed = true;
          onDelta(t);
        } : undefined);
        waste?.onCall(sent, Math.ceil((r.content.length + (r.toolCalls.length ? JSON.stringify(r.toolCalls).length : 0)) / 3));
        return r;
      } catch (err) {
        if (err instanceof ToolsUnsupportedError || d.isCancelled()) throw err;
        if (isContextTooLong(err) && !compactedForError) {
          compactedForError = true;
          // The model's window is smaller than assumed: take the coordinator's figure when it gave one.
          const m = /serves (\d+)|largestContextWindow\D+(\d+)/.exec((err as Error).message ?? "");
          const reported = m ? Number(m[1] ?? m[2]) : NaN;
          if (Number.isFinite(reported) && reported >= 2048 && reported < window) window = reported;
          await compact(window * 0.6, withTools ? tools : undefined);
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
    // Straight to the stream (not through textFilter): callers recognise the error by its first event.
    flushText();
    const text = `Error contacting model: ${(err as Error).message}${where ? `\n\n(${where}.)` : ""}`;
    d.sendEvent({ type: "text", content: needBreak && emitted ? `\n\n${text}` : text });
    emitted = true;
    needBreak = false;
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
    if (d.plan || !d.continueOnIntent || !describesWork(content)) return false;
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
    const piece = needBreak && emitted ? `\n\n${text}` : text;
    emitted = true;
    needBreak = false;
    const out = d.textFilter ? d.textFilter.push(piece) : piece;
    if (out) d.sendEvent({ type: "text", content: out });
  };
  const flushText = () => {
    const rest = d.textFilter?.end();
    if (rest) d.sendEvent({ type: "text", content: rest });
  };

  // Grounding: the server's own calls before the first turn, in the conversation as the model's.
  for (const p of d.prefetch ?? []) {
    if (d.isCancelled()) return;
    const r = await runTool(p.tool, p.args);
    if (native) {
      messages.push({ role: "assistant", content: "", tool_calls: [{ function: { name: p.tool, arguments: p.args } }] });
      const m: ChatMessage = { role: "tool", content: r.result, tool_name: p.tool };
      labels.set(m, r.label);
      messages.push(m);
      attachReads(m);
    } else {
      messages.push(asTextFormat({ role: "assistant", content: "", tool_calls: [{ function: { name: p.tool, arguments: p.args } }] }));
      const m = asTextFormat({ role: "tool", content: r.result, tool_name: p.tool });
      labels.set(m, r.label);
      messages.push(m);
      attachReads(m);
    }
  }

  try {
    await loop();
  } finally {
    flushText();
    const saved = waste?.savedLine();
    if (saved) d.sendEvent({ type: "cost_note", kind: "saved", message: saved, savedTokens: waste!.savedTokens });
  }

  /**
   * Before a model call after the first: act on waste once (compact older tool results, steer to
   * helpers), then the cost check. False: the turn ends here (the owner said Stop).
   */
  async function beforeCall(): Promise<boolean> {
    if (waste && d.waste?.act && waste.shouldAct()) {
      const why = waste.signal() ?? "kept re-reading";
      const before = estimateTokens(messages, native ? tools : undefined);
      // Only the first pass of compaction (older tool results become their one-line labels): a
      // budget of the current size is always met by it, so nothing is summarized or dropped.
      const r = await compactMessages(messages, { budget: before, tools: native ? tools : undefined, pinned: request, labels, paths });
      messages.splice(0, messages.length, ...r.messages);
      const after = estimateTokens(messages, native ? tools : undefined);
      if (before - after > 0) d.sendEvent({ type: "compacted", before, after, savedTokens: before - after, summarized: false });
      if (d.waste.helpers) messages.push({ role: "user", content: HELPERS_NUDGE });
      d.sendEvent({
        type: "cost_note",
        kind: "waste",
        message: `This reply ${why}: older tool results were shortened to one line each${before - after > 0 ? ` (~${Math.round((before - after) / 1000)}K tokens)` : ""}${d.waste.helpers ? " and lookups go to helpers" : ""}.`,
      });
    }
    if (!d.costCheck) return true;
    const v = await d.costCheck({ inputTokens: waste?.inputTokens ?? 0, outputTokens: waste?.outputTokens ?? 0, waste: waste?.persists() ?? null });
    if (v.action === "stop") {
      flushText();
      needBreak = true;
      say(v.note);
      return false;
    }
    if (v.action === "switch") chat = v.chat;
    return true;
  }

  async function loop(): Promise<void> {
  for (let i = 0; i < maxIterations && !d.isCancelled(); i++) {
    needBreak = true;
    if (i > 0 && (d.costCheck || d.waste?.act) && !(await beforeCall())) return;
    if (d.isCancelled()) return;
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
          // Native tool calls so far (the grounding search) in the text format's shape.
          messages = [...sys, ...messages.filter((m) => m.role !== "system").map(asTextFormat)];
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
          attachReads(m);
        } else {
          // Only a plan: ask once for the first step as a real tool call (not in plan mode: the plan is the answer).
          if (nudged || d.plan) return;
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
        attachReads(m);
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
        attachReads(m);
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
      attachReads(m);
    }
    if (!hadToolCall) return;
  }
  if (!d.isCancelled()) {
    flushText();
    d.sendEvent({ type: "text", content: `\n\n_Stopped after ${maxIterations} steps without finishing. Reply "continue" to pick up where it left off._` });
  }
  }
}

/**
 * An answer to an approval: true (allow this call), false (deny, timeout, disconnect) or "run":
 * allow it and, when the web-page guard asked, let the rest of this run's guard asks go ahead
 * (only calls the mode or a rule would run anyway; nothing is kept after the run).
 */
export type ApprovalAnswer = boolean | "run";

/** Why a call asks, for waitForApproval: `webGuard` when only the web-page guard asked (the mode would run it). */
export interface ApprovalAsk {
  webGuard: boolean;
}

export interface ToolRunnerDeps {
  /** `sandbox`: run a command in the OS sandbox (Auto, sandbox.ts). */
  execute: (tool: ToolName, args: Record<string, unknown>, opts: { approved: boolean; sandbox?: boolean }) => Promise<{ result?: string; error?: string }>;
  sendEvent: (event: IdeStreamEvent) => void;
  /** Resolves true (or "run") when the user approves the call (false on reject, timeout or disconnect). */
  waitForApproval: (callId: string, tool: ToolName, args: Record<string, unknown>, ask: ApprovalAsk) => Promise<ApprovalAnswer>;
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
  /**
   * The permission mode's verdict per call (permission-policy.ts decideToolCall): run, ask or
   * refuse. When set it replaces autoApproveEdits and alwaysAllowed. An "ask" may carry the
   * "Always allow" rule the approval card offers.
   */
  decide?: (tool: ToolName, args: Record<string, unknown>) => Decision;
  /**
   * Extra text for the model after a run_shell result, from the command and its output (stdout and
   * stderr): toolchain.ts names a Node version mismatch and the command that retries under the
   * right version. Only a hint: nothing runs because of it.
   */
  shellHint?: (command: string, output: string) => string | null;
}

/** Tools that ask every time, whatever auto-approve settings say (except a Full access verdict from decide). */
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
  // Prompt-injection guard (docs/web-tool.md): once read_page has put a web page's text into the
  // context, commands and other calls that act beyond the project's files don't happen on their own
  // for the rest of the turn or run: a call the mode (or an "always allow" rule) would have run asks
  // first, so page text alone can never make the agent act. Unattended bots queue it as "Needs
  // approval". Not guarded: edits inside the project that the mode applies anyway (each is in the
  // turn's checkpoint, undoable; protected paths, secrets and files outside the project still ask
  // or are refused by the mode), and Full access (the user chose to approve everything). Answering
  // a guard ask with "Allow for the rest of this run" (ApprovalAnswer "run") lifts the guard until
  // the run ends; it never makes a call run that the mode itself asks about or refuses, nor one that
  // runs a file this run wrote or edited (edited-runs.ts): such a call keeps the guard's ask.
  let webPageRead = false;
  let guardLifted = false;
  /** Files this run wrote or edited (editKey form). */
  const edited = new Set<string>();
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
    let requiresApproval: boolean;
    let always: boolean;
    let rules: string[] = [];
    /** Calls the web-page guard leaves alone: Full access, and edits the mode applies inside the project. */
    let guardExempt = false;
    /** Auto runs it in the OS sandbox (sandbox.ts); the rules are offered if the sandbox blocks it. */
    let sandboxed = false;
    let offer: string[] = [];
    if (d.decide) {
      const verdict = d.decide(tool, args);
      if (verdict.action === "refuse") {
        d.sendEvent({ type: "tool_call", id: callId, tool, args, requires_approval: false });
        d.sendEvent({ type: "tool_result", id: callId, error: verdict.reason });
        return `[Refused]: ${verdict.reason}`;
      }
      requiresApproval = verdict.action === "ask" && !(shellAutoApprove && !ALWAYS_ASK_TOOLS.has(tool));
      // A command the mode lets run counts as approved for the executor's shell policy; edits never
      // do (the executor still guards protected paths for them), except in Full access, where the
      // verdict itself says the user approved every call (the executor's hard refusals still apply).
      always = !requiresApproval && (tool === "run_shell" || verdict.approved === true);
      offer = verdict.rules ?? (verdict.rule ? [verdict.rule] : []);
      if (requiresApproval) rules = offer;
      sandboxed = tool === "run_shell" && verdict.sandbox === true;
      // decideToolCall runs an edit only inside the project, off protected paths and secrets.
      guardExempt = verdict.approved === true || (verdict.action === "run" && (tool === "write_file" || tool === "edit_file"));
    } else {
      const autoEdits = typeof d.autoApproveEdits === "function" ? d.autoApproveEdits() : d.autoApproveEdits === true;
      const editAutoApprove = autoEdits && (tool === "write_file" || tool === "edit_file") && protectedToolPath(args.path) === null;
      always = !ALWAYS_ASK_TOOLS.has(tool) && !READ_TOOLS.has(tool) && d.alwaysAllowed?.(tool, args) === true;
      requiresApproval = ALWAYS_ASK_TOOLS.has(tool) || (!READ_TOOLS.has(tool) && !shellAutoApprove && !editAutoApprove && !always);
    }
    const guarded = webPageRead && !guardExempt && !requiresApproval && !READ_TOOLS.has(tool) && !WEB_TOOLS.has(tool);
    // A call that runs a file this run changed is never covered by the run-wide allowance.
    const runsEdited = guarded ? runsEditedFile(tool, args, edited) : null;
    const webGuard = guarded && (!guardLifted || runsEdited !== null);
    if (webGuard) {
      requiresApproval = true;
      always = false;
    }
    d.sendEvent({
      type: "tool_call",
      id: callId,
      tool,
      args,
      requires_approval: requiresApproval,
      ...(rules.length ? { allow_rule: rules[0], ...(rules.length > 1 ? { allow_rules: rules } : {}) } : {}),
      ...(webGuard ? { web_guard: true as const, ...(runsEdited ? { runs_edited: runsEdited } : {}) } : {}),
      ...(sandboxed ? { sandboxed: true as const } : {}),
    });
    if (requiresApproval) {
      const answer = await d.waitForApproval(callId, tool, args, { webGuard });
      if (answer === false) {
        const msg = `Tool call ${tool} was rejected by the user.`;
        d.sendEvent({ type: "tool_result", id: callId, error: msg });
        return `[Rejected]: ${msg}`;
      }
      if (answer === "run" && webGuard && !runsEdited) guardLifted = true;
    }
    const writesFile = tool === "write_file" || tool === "edit_file";
    const tracked = writesFile ? d.captureBeforeWrite(String(args.path ?? "")) : null;
    // `approved` means the user approved this call; auto-approved edits don't count.
    const result = await d.execute(tool, args, { approved: requiresApproval || always, ...(sandboxed ? { sandbox: true } : {}) });
    if (tool === "read_page" && !result.error) webPageRead = true;
    if (tracked && !result.error) d.sendEvent({ type: "file_change", turnId: d.turnId, path: tracked });
    if (writesFile && !result.error) {
      const k = editKey(args.path);
      if (k) edited.add(k);
    }
    const first = reportToolResult(d, callId, tool, args, result);
    // The sandbox blocked it (a write outside the project, the network): never re-run outside on
    // its own; ask, as the mode would without the sandbox, and run it outside only on a yes.
    const blocked = sandboxed ? (first.denied ?? (result.error?.startsWith(SANDBOX_UNAVAILABLE) ? "the sandbox couldn't start" : null)) : null;
    if (!blocked) return first.text;
    const retryId = `tc_${randomUUID().slice(0, 8)}`;
    d.sendEvent({ type: "tool_call", id: retryId, tool, args, requires_approval: true, sandbox_retry: blocked, ...(offer.length ? { allow_rule: offer[0], ...(offer.length > 1 ? { allow_rules: offer } : {}) } : {}) });
    const note = `[Sandbox]: the sandbox blocked ${blocked}.`;
    if ((await d.waitForApproval(retryId, tool, args, { webGuard: false })) === false) {
      d.sendEvent({ type: "tool_result", id: retryId, error: "Not run outside the sandbox: the user didn't approve it." });
      return `${first.text}\n\n${note} The user didn't approve running it outside the sandbox.`;
    }
    const again = reportToolResult(d, retryId, tool, args, await d.execute(tool, args, { approved: true }));
    return `${first.text}\n\n${note} The user approved running it outside the sandbox:\n${again.text}`;
  };
}

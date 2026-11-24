// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Keeping an agent turn inside the model's context window.
 *
 * The loop keeps a running estimate of what the next model call needs (the same estimate the
 * coordinator uses: characters / 3, plus room for the reply) against the target model's window.
 * Before a call would pass about 85% of it, older tool results are replaced by one-line summaries;
 * when that is not enough, the older part of the conversation becomes one summary (a cheap model
 * call when one is offered, else plain truncation). The system prompt, the request being worked on
 * and the most recent messages are kept, and so are the exact paths of the files the turn used (a
 * model that lost them guessed `src/worker-runner.ts` for `src/swarm/worker-runner.ts`).
 *
 * A lead paid per token (your frontier key, a network or cloud model) also compacts once the prompt
 * passes a token budget, however big its window: COMPACT_PAID_TOKENS (80K by default; Settings →
 * General → "Compact long chats at … tokens", EDGECODER_COMPACT_PAID_TOKENS). Without it a 1M-token
 * window resent the whole history every turn and a long chat's cost grew with every message.
 * Models on this computer or your own machines are free and keep the 85%-of-window rule.
 *
 * compactHistory is the persistent form (`/compact`, the chat's "Compact conversation", and the
 * automatic pass before a paid turn): everything but the last few messages becomes one summary that
 * the chat keeps and sends instead of those messages from then on.
 */

import type { ChatMessage, ToolSchema } from "./agent-loop.js";

/** A window to assume when neither the model nor its class reports one (the coordinator's own fallback). */
export const DEFAULT_CONTEXT_WINDOW = 32_768;
/** Compact before a call would use more than this share of the window. */
export const COMPACT_AT = 0.85;
/** Room kept for the reply: the coordinator's default output cap plus its margin. */
export const REPLY_RESERVE_TOKENS = 4_096 + 256;
/** Messages at the end of the conversation that are never compacted. */
const KEEP_RECENT = 6;
/** Paid leads: compact once a call's prompt passes this many tokens (default; see compactPaidTokens). */
export const COMPACT_PAID_TOKENS = 80_000;
/** The smallest and largest budget a setting may ask for. */
export const COMPACT_PAID_MIN = 8_000;
export const COMPACT_PAID_MAX = 2_000_000;
/** Messages a persistent compaction (`/compact`) keeps as they are. */
export const KEEP_ON_COMPACT = 4;

/**
 * The paid-lead budget in tokens: the client's setting when it is a sane number, else
 * EDGECODER_COMPACT_PAID_TOKENS, else 80,000. Values outside 8K–2M are ignored.
 */
export function compactPaidTokens(setting?: unknown, env: NodeJS.ProcessEnv = process.env): number {
  const ok = (v: unknown): number | null => {
    const n = typeof v === "string" && v.trim() ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= COMPACT_PAID_MIN && n <= COMPACT_PAID_MAX ? Math.round(n) : null;
  };
  return ok(setting) ?? ok(env.EDGECODER_COMPACT_PAID_TOKENS) ?? COMPACT_PAID_TOKENS;
}

/**
 * Whether the lead is paid per token: a frontier model on your own key, or a network model
 * (cloud models included). This computer, your machines, a reservation (prepaid) and Auto are not.
 */
export function isPaidLead(modelId: string | undefined, target?: string): boolean {
  if (target === "frontier" || target === "network") return true;
  if (target) return false;
  return typeof modelId === "string" && (modelId.startsWith("frontier/") || modelId.startsWith("network/"));
}

/** Tokens a call may reach before it compacts: 85% of the window, and for a paid lead at most `paidTokens`. */
export function compactThreshold(window: number, paidTokens?: number | null): number {
  const share = window * COMPACT_AT;
  return paidTokens && paidTokens > 0 ? Math.min(share, paidTokens) : share;
}

/** Tokens a call with these messages and tools needs, reply included (coordinator's contextNeeded). */
export function estimateTokens(messages: ChatMessage[], tools?: ToolSchema[]): number {
  const chars =
    messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (tools ? JSON.stringify(tools).length : 0);
  return Math.ceil(chars / 3) + REPLY_RESERVE_TOKENS;
}

export function shouldCompact(messages: ChatMessage[], tools: ToolSchema[] | undefined, window: number, share = COMPACT_AT, paidTokens?: number | null): boolean {
  const at = share === COMPACT_AT ? compactThreshold(window, paidTokens) : window * share;
  return estimateTokens(messages, tools) > at;
}

/** Whether a model call failed because the request did not fit the model's context. */
export function isContextTooLong(err: unknown): boolean {
  const m = (err as Error)?.message ?? String(err);
  return /context_too_long|context length|context window|maximum context|too many tokens|prompt is too long/i.test(m);
}

/**
 * Whether a model call failed for a reason that a second try may not have: a lost or refused
 * stream, a proxy's error page, a bad or empty reply from the coordinator, a timeout.
 */
export function isTransient(err: unknown): boolean {
  const m = (err as Error)?.message ?? String(err);
  if (/insufficient|not enough csats|no machine|none of your own|reservation|does not support tools|aborted|cancel/i.test(m)) return false;
  return /not_requester|unknown_stream|coordinator_bad_response|coordinator_unreachable|empty_reply|terminated|other side closed|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|UND_ERR|timed? ?out|timeout|<html|bad gateway|gateway|\b50[234]\b|Network stream failed|stream ended|premature/i.test(m);
}

export interface CompactOptions {
  /** Tokens to fit the call into (a share of the window). */
  budget: number;
  tools?: ToolSchema[];
  /** The message holding the request being worked on; kept as it is. */
  pinned?: ChatMessage;
  /** One-line descriptions of tool results ("read_file(src/a.ts): 2085 lines"). */
  labels: WeakMap<ChatMessage, string>;
  /** Exact paths the turn used, most recent last. */
  paths: string[];
  /** A cheap model call that summarizes text; null or a throw falls back to truncation. */
  summarize?: (text: string) => Promise<string | null>;
}

const NOTE_HEAD = "[Older messages of this conversation were compacted to fit the model's context window.]";
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters compacted)` : s);

function isToolResult(m: ChatMessage): boolean {
  return m.role === "tool" || (m.role === "user" && m.content.startsWith("[Tool "));
}

/** The paths the turn used, as the line every summary carries. */
export function pathsLine(paths: string[]): string {
  return paths.length ? `Files used so far (exact paths, use these): ${paths.slice(-20).join(", ")}` : "";
}

/** A compacted copy of `messages` that fits `budget` when it can (the original is not changed). */
export async function compactMessages(messages: ChatMessage[], o: CompactOptions): Promise<{ messages: ChatMessage[]; summarized: boolean; dropped: number }> {
  const sys = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = messages.slice(sys.length);
  let tailStart = Math.max(0, rest.length - KEEP_RECENT);
  // A tool result keeps the assistant message that called it.
  while (tailStart > 0 && rest[tailStart].role === "tool") tailStart--;
  const middle = rest.slice(0, tailStart);
  const tail = rest.slice(tailStart);
  const fits = (ms: ChatMessage[]) => estimateTokens(ms, o.tools) <= o.budget;
  // A shortened copy keeps the original's label, for a later compaction's summary.
  const copy = (m: ChatMessage, content: string): ChatMessage => {
    const c = { ...m, content };
    const label = o.labels.get(m);
    if (label) o.labels.set(c, label);
    return c;
  };

  // 1. Older tool results become their one-line label; long older messages are shortened.
  const shortened = middle.map((m): ChatMessage => {
    if (m === o.pinned) return m;
    if (isToolResult(m)) {
      const label = o.labels.get(m) ?? `${m.tool_name ?? "tool"} result`;
      return copy(m, `[Earlier result, compacted: ${label}. Call the tool again if you need it.]`);
    }
    if (m.role === "assistant") return copy(m, cut(m.content, 600));
    return copy(m, cut(m.content, 1500));
  });
  let out = [...sys, ...shortened, ...tail];
  if (fits(out)) return { messages: out, summarized: false, dropped: 0 };

  // 2. The older part becomes one summary (kept: the request and the recent messages).
  const older = middle.filter((m) => m !== o.pinned);
  let summary: string | null = null;
  let summarized = false;
  if (o.summarize && older.length) {
    const transcript = shortened
      .filter((m) => m !== o.pinned)
      .map((m) => `${m.role}${m.tool_name ? ` (${m.tool_name})` : ""}: ${m.content}`)
      .join("\n\n");
    try {
      summary = await o.summarize(cut(transcript, Math.max(4_000, o.budget)));
      summarized = !!summary?.trim();
    } catch {
      summary = null;
    }
  }
  if (!summarized) {
    // An earlier compaction's list carries on into this one.
    const prior = older
      .filter((m) => m.content.startsWith(NOTE_HEAD))
      .flatMap((m) => /^Tool calls made earlier: (.*)\.$/m.exec(m.content)?.[1].split("; ") ?? []);
    const labels = [...prior, ...older.filter(isToolResult).map((m) => o.labels.get(m)).filter((l): l is string => !!l)];
    summary = labels.length ? `Tool calls made earlier: ${labels.slice(-15).join("; ")}.` : "";
  }
  const note: ChatMessage = {
    role: "user",
    content: [
      NOTE_HEAD,
      summary?.trim() ?? "",
      pathsLine(o.paths),
      "Continue the request from where the recent messages leave off.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
  const pinned = o.pinned && middle.includes(o.pinned) ? [o.pinned] : [];
  out = [...sys, ...pinned, ...(older.length ? [note] : []), ...tail];
  if (fits(out)) return { messages: out, summarized, dropped: older.length };

  // 3. Still too big (a huge recent result): shorten the recent tool results (then any long
  // recent message) until the call fits, down to a few hundred characters each.
  const head = [...sys, ...pinned, ...(older.length ? [note] : [])];
  for (let share = 16_000; share >= 400; share = Math.floor(share / 2)) {
    const tail2 = tail.map((m) => (isToolResult(m) || m.content.length > share * 2 ? copy(m, cut(m.content, share)) : m));
    out = [...head, ...tail2];
    if (fits(out)) break;
  }
  return { messages: out, summarized, dropped: older.length };
}

/** The first line of a persistent summary (the message a chat sends in place of what it covers). */
export const SUMMARY_HEAD = "[Earlier messages of this conversation were summarized to save tokens.]";

/** File paths mentioned in some text ("src/swarm/worker-runner.ts"), first seen first, at most `max`. */
export function pathsIn(texts: string[], max = 20): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s`'"(\[])((?:\.{1,2}\/|~\/|\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),:;\].!?])/g;
  for (const t of texts) {
    for (const m of t.matchAll(re)) {
      const p = m[1];
      if (/^https?:/.test(p) || out.includes(p)) continue;
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export interface HistoryCompaction {
  /** The message to send in place of the covered ones (SUMMARY_HEAD, the summary, the file paths). */
  note: string;
  /** How many leading messages it replaces. */
  covered: number;
  /** Estimated prompt tokens of the history before and after. */
  before: number;
  after: number;
  /** A model wrote the summary (false: a plain shortened transcript). */
  summarized: boolean;
}

/**
 * Persistent compaction of a chat's history (user and assistant messages, oldest first): all but
 * the last `keep` messages become one summary note. The kept part starts at a user message when it
 * can (a reply keeps the request it answers), never on a tool result, and never leaves a tool call
 * without its result. Null when there is nothing worth compacting (too few messages).
 */
export async function compactHistory(
  messages: ChatMessage[],
  o: { keep?: number; summarize?: (text: string) => Promise<string | null>; maxTranscriptChars?: number } = {},
): Promise<HistoryCompaction | null> {
  const keep = Math.max(1, o.keep ?? KEEP_ON_COMPACT);
  let start = Math.max(0, messages.length - keep);
  // The kept part starts at a request, so a reply never loses the question it answers.
  while (start > 0 && messages[start].role !== "user") start--;
  // A tool result (or a "[Tool …" message) stays with the call before it.
  while (start > 0 && (messages[start].role === "tool" || messages[start].content.startsWith("[Tool "))) start--;
  // A call whose results come after it stays with them.
  while (start > 0 && messages[start - 1].role === "assistant" && messages[start - 1].tool_calls?.length) start--;
  if (start < 2) return null;
  const older = messages.slice(0, start);
  // An earlier summary is folded into the new one.
  const transcript = older.map((m) => `${m.role}${m.tool_name ? ` (${m.tool_name})` : ""}: ${m.role === "assistant" ? cut(m.content, 4_000) : cut(m.content, 6_000)}`).join("\n\n");
  let summary: string | null = null;
  if (o.summarize) {
    try {
      summary = (await o.summarize(cut(transcript, o.maxTranscriptChars ?? 120_000)))?.trim() || null;
    } catch {
      summary = null;
    }
  }
  const summarized = !!summary;
  if (!summary) {
    // No model to summarize: each older message shortened, the newest kept longest.
    summary = older.map((m) => `${m.role}: ${cut(m.content.replace(/\s+/g, " "), m.content.startsWith(SUMMARY_HEAD) ? 2_000 : 240)}`).join("\n").slice(-6_000);
  }
  const paths = pathsIn(older.map((m) => m.content));
  const note = [SUMMARY_HEAD, summary, pathsLine(paths)].filter(Boolean).join("\n");
  const before = estimateTokens(messages);
  const after = estimateTokens([{ role: "user", content: note }, ...messages.slice(start)]);
  if (after >= before) return null;
  return { note, covered: start, before, after, summarized };
}

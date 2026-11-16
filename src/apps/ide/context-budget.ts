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

/** Tokens a call with these messages and tools needs, reply included (coordinator's contextNeeded). */
export function estimateTokens(messages: ChatMessage[], tools?: ToolSchema[]): number {
  const chars =
    messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (tools ? JSON.stringify(tools).length : 0);
  return Math.ceil(chars / 3) + REPLY_RESERVE_TOKENS;
}

export function shouldCompact(messages: ChatMessage[], tools: ToolSchema[] | undefined, window: number, share = COMPACT_AT): boolean {
  return estimateTokens(messages, tools) > window * share;
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

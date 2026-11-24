// Keeping long chats cheap (src/apps/ide/context-budget.ts on the provider). A chat whose model is
// paid per token (your frontier key, a network or cloud model) summarizes its older messages once
// the history passes a token budget (Settings → General → "Compact long chats at … tokens", 80K by
// default); `/compact` or "Compact conversation" does it now. The summary is kept with the chat and
// sent in place of the messages it covers, so later turns stop resending them. Models on this
// computer or your own machines are free and compact only to fit their window, inside the turn.
import type { Conversation } from "./types";

export const COMPACT_SETTING_KEY = "edgecoder-compact-paid-tokens";
export const DEFAULT_COMPACT_PAID_TOKENS = 80_000;
export const COMPACT_MIN = 8_000;
export const COMPACT_MAX = 2_000_000;
/** The context meter shows from this size on. */
export const METER_MIN = 10_000;
/** A paid chat asks the provider to compact before a send once its history passes this share of the budget. */
export const PRE_SEND_SHARE = 0.75;

export function compactPaidTokensSetting(): number {
  try {
    const n = Number(localStorage.getItem(COMPACT_SETTING_KEY));
    if (Number.isFinite(n) && n >= COMPACT_MIN && n <= COMPACT_MAX) return Math.round(n);
  } catch {
    // private mode: the default
  }
  return DEFAULT_COMPACT_PAID_TOKENS;
}

/** Save the budget (clamped to 8K–2M); returns what was kept. */
export function setCompactPaidTokens(n: number): number {
  const v = Math.round(Math.min(COMPACT_MAX, Math.max(COMPACT_MIN, n)));
  try {
    if (v === DEFAULT_COMPACT_PAID_TOKENS) localStorage.removeItem(COMPACT_SETTING_KEY);
    else localStorage.setItem(COMPACT_SETTING_KEY, String(v));
  } catch {
    // private mode: this session only
  }
  return v;
}

/** Whether replies on this compute choice are paid per token (frontier key, network, cloud). */
export function isPaidChoice(id: string | undefined): boolean {
  return typeof id === "string" && (id.startsWith("frontier/") || id.startsWith("network/"));
}

export interface ModelHistory {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** The id of the chat message each entry stands for (the summary: the last message it covers). */
  ids: string[];
}

/** What the model gets: the kept summary in place of the messages it covers, then the rest. */
export function historyForModel(c: Pick<Conversation, "messages" | "summary">): ModelHistory {
  const messages: ModelHistory["messages"] = [];
  const ids: string[] = [];
  let from = 0;
  const s = c.summary;
  if (s) {
    const at = c.messages.findIndex((m) => m.id === s.throughId);
    if (at >= 0) {
      messages.push({ role: "user", content: s.note });
      ids.push(s.throughId);
      from = at + 1;
    }
  }
  for (const m of c.messages.slice(from)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    messages.push({ role: m.role, content: m.content });
    ids.push(m.id);
  }
  return { messages, ids };
}

/** The provider's estimate (characters / 3), without the reply reserve. */
export function estimateTokens(messages: Array<{ content: string }>): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3);
}

/** The chat's context size: what its last model call sent, else an estimate of its history. */
export function contextTokens(c: Pick<Conversation, "messages" | "summary" | "contextTokens">): number {
  return c.contextTokens ?? estimateTokens(historyForModel(c).messages);
}

/** "context ~42K tokens". */
export function contextLabel(tokens: number): string {
  const k = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
  return `context ~${k} tokens`;
}

/** The inline note where older messages were summarized. */
export function compactionNoteText(savedTokens: number): string {
  return `Earlier messages summarized to save tokens · ~${Math.max(0, Math.round(savedTokens)).toLocaleString("en-US")} tokens saved`;
}

/** `/compact` typed in the composer. */
export const isCompactCommand = (text: string) => /^\/compact\s*$/i.test(text.trim());

export interface CompactResult {
  compacted: boolean;
  note?: string;
  covered?: number;
  savedTokens?: number;
  tokens?: number;
  summarized?: boolean;
}

/**
 * Keep a compaction with the chat: the summary replaces the first `covered` entries of the
 * history that was sent (`sent.ids`). False when the result doesn't line up.
 */
export function applyCompaction(c: Conversation, r: CompactResult, sent: ModelHistory, manual: boolean): boolean {
  if (!r.compacted || !r.note || !r.covered || r.covered < 1 || r.covered > sent.ids.length) return false;
  c.summary = { note: r.note, throughId: sent.ids[r.covered - 1], savedTokens: r.savedTokens ?? 0, manual, at: Date.now() };
  // The next call's size is the compacted history; the meter re-estimates until it reports.
  delete c.contextTokens;
  return true;
}

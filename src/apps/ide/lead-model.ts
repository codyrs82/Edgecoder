// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Context graduation (docs/tentacles.md): as the lead's conversation grows, move the lead to a
 * model with a larger window instead of letting it lose the start of the conversation. With the
 * user's own frontier key (BYOK) the frontier lead is the next step; otherwise the
 * smallest-window candidate that fits, cheapest first.
 *
 * Called per turn where the lead's model is chosen (provider-server.ts, the sessions' `chat`),
 * behind EDGECODER_CONTEXT_GRADUATION=1. Pure: no I/O.
 */

export interface LeadCandidate {
  /** A model id as sessions keep them (network/<m>[@class], mine/<m>, a local tag, a frontier id). */
  id: string;
  /** The model's context window, tokens. */
  contextTokens: number;
  /** Lower is cheaper (ties between windows that fit). */
  costRank?: number;
}

export interface GraduationInput {
  /** The session's model id now. */
  current: string;
  /** Tokens the next call carries (conversation + system prompt + tools), estimated. */
  promptTokens: number;
  candidates: LeadCandidate[];
  /** The session's frontier lead (BYOK), when it has one. */
  frontierLead?: { id: string; contextTokens: number } | null;
  /** Use at most this share of a window before moving up (default 0.75: room for the reply and tool results). */
  headroom?: number;
}

export interface GraduationChoice {
  model: string;
  changed: boolean;
  reason: string;
}

/** Tokens in a conversation, roughly (3.5 characters a token, plus per-message overhead). */
export function estimateTokens(messages: Array<{ content: string }>, extraChars = 0): number {
  const chars = messages.reduce((n, m) => n + m.content.length + 16, extraChars);
  return Math.ceil(chars / 3.5);
}

/** "network/qwen3-coder:30b=32768,network/big:70b@gpu=131072" → candidates (EDGECODER_LEAD_CANDIDATES). */
export function parseLeadCandidates(raw: string | undefined): LeadCandidate[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((part, i): LeadCandidate | null => {
      const eq = part.lastIndexOf("=");
      const id = (eq > 0 ? part.slice(0, eq) : "").trim();
      const tokens = Number(part.slice(eq + 1));
      return id && Number.isFinite(tokens) && tokens > 0 ? { id, contextTokens: Math.floor(tokens), costRank: i } : null;
    })
    .filter((c): c is LeadCandidate => c !== null);
}

export function chooseLeadModel(input: GraduationInput): GraduationChoice {
  const headroom = input.headroom ?? 0.75;
  const fits = (window: number) => input.promptTokens <= window * headroom;
  const current = input.candidates.find((c) => c.id === input.current);
  // A model we don't know the window of ("auto" sizes each call itself) is left alone, unless the
  // frontier lead is available and the conversation is past what network models typically hold.
  if (input.frontierLead && input.current === input.frontierLead.id) return { model: input.current, changed: false, reason: "already on the frontier lead" };
  if (current && fits(current.contextTokens)) return { model: input.current, changed: false, reason: "fits the current window" };
  if (!current && input.current === "auto" && !input.frontierLead) return { model: input.current, changed: false, reason: "auto sizes each call" };
  if (input.frontierLead && fits(input.frontierLead.contextTokens)) {
    return { model: input.frontierLead.id, changed: true, reason: `the conversation (~${input.promptTokens} tokens) outgrew ${input.current}; moved to the frontier lead` };
  }
  const larger = input.candidates
    .filter((c) => c.id !== input.current && fits(c.contextTokens) && (!current || c.contextTokens > current.contextTokens))
    .sort((a, b) => a.contextTokens - b.contextTokens || (a.costRank ?? 0) - (b.costRank ?? 0));
  if (larger.length) {
    return { model: larger[0].id, changed: true, reason: `the conversation (~${input.promptTokens} tokens) outgrew ${input.current}; moved to ${larger[0].id} (${larger[0].contextTokens} tokens)` };
  }
  if (!current) return { model: input.current, changed: false, reason: "no candidate fits; staying" };
  const biggest = [...input.candidates, ...(input.frontierLead ? [{ ...input.frontierLead, costRank: 0 }] : [])].sort((a, b) => b.contextTokens - a.contextTokens)[0];
  if (biggest && biggest.contextTokens > current.contextTokens) {
    return { model: biggest.id, changed: true, reason: `nothing holds ~${input.promptTokens} tokens; moved to the largest window (${biggest.id})` };
  }
  return { model: input.current, changed: false, reason: "already the largest window" };
}

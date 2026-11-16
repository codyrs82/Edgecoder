// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Frontier model ids (`frontier/<provider>/<model>`), the built-in Anthropic catalog and the price
 * table for "bring your own frontier key" (docs/frontier-keys.md).
 *
 * Pure data and parsing only, no keys and no network: the coordinator, the agent and the
 * inference runner import `isFrontierModelId` from here to refuse these ids, and must never
 * import the backend (frontier.ts) or the key store (frontier-keys.ts).
 */

export const FRONTIER_PREFIX = "frontier/";

/** A provider id: `anthropic`, `openai`, or a short slug the user chose for an OpenAI-compatible endpoint. */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type FrontierKind = "anthropic" | "openai-compatible";

/** True for any id naming a frontier model (case- and space-insensitive, so `Frontier/...` can't slip past a guard). */
export function isFrontierModelId(id: unknown): boolean {
  return typeof id === "string" && id.trim().toLowerCase().startsWith(FRONTIER_PREFIX);
}

/** `frontier/anthropic/claude-opus-5-5` -> { provider: "anthropic", model: "claude-opus-5-5" }; the model may contain slashes. */
export function parseFrontierModelId(id: string): { provider: string; model: string } | null {
  if (!isFrontierModelId(id)) return null;
  const rest = id.trim().slice(FRONTIER_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const provider = rest.slice(0, slash);
  const model = rest.slice(slash + 1);
  if (!PROVIDER_ID_RE.test(provider) || !model || model.length > 200 || /\s/.test(model)) return null;
  return { provider, model };
}

export const frontierModelId = (provider: string, model: string) => `${FRONTIER_PREFIX}${provider}/${model}`;

/** USD per million tokens. Cache rates default to 1.25x (write) and 0.1x (read) of input. */
export interface Price {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  price: Price;
}

/** Anthropic's current models, most capable first (prices: Anthropic first-party API, cached 2026-10). */
export const ANTHROPIC_MODELS: CatalogModel[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", price: { input: 4, output: 20, cacheRead: 0.2 } },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", price: { input: 10, output: 50, cacheRead: 0.25 } },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", price: { input: 2, output: 10, cacheRead: 0.2 } },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", price: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
];

/** The default lead: the most capable sensible model for leading coding work. */
export const DEFAULT_LEAD_MODEL = frontierModelId("anthropic", "claude-opus-5-5");

/** A few well-known OpenAI-compatible prices; anything else uses UNKNOWN_PRICE until the user sets one. */
const KNOWN_PRICES: Record<string, Price> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Used when no price is known: deliberately high, so caps stop early rather than late. Set the
 * real price in the frontier settings (`prices`) to get accurate estimates.
 */
export const UNKNOWN_PRICE: Price = { input: 10, output: 50 };

/** The price for a model: the user's table first (`<provider>/<model>` or `<model>`), then the built-in one. */
export function priceFor(provider: string, model: string, overrides: Record<string, Price> = {}): { price: Price; known: boolean } {
  const own = overrides[`${provider}/${model}`] ?? overrides[model];
  if (own) return { price: own, known: true };
  const builtIn = ANTHROPIC_MODELS.find((m) => m.id === model)?.price ?? KNOWN_PRICES[model];
  return builtIn ? { price: builtIn, known: true } : { price: UNKNOWN_PRICE, known: false };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/** Estimated USD for one call. */
export function estimateCostUsd(u: TokenUsage, p: Price): number {
  const per = (tokens: number | undefined, rate: number) => ((tokens ?? 0) / 1_000_000) * rate;
  const usd = per(u.inputTokens, p.input) + per(u.outputTokens, p.output) + per(u.cacheWriteTokens, p.cacheWrite ?? p.input * 1.25) + per(u.cacheReadTokens, p.cacheRead ?? p.input * 0.1);
  return Math.round(usd * 1e6) / 1e6;
}

/** A frontier model's context window in tokens (Anthropic's current models: 1M); undefined when unknown. */
export function frontierContextWindow(provider: string, model: string): number | undefined {
  return provider === "anthropic" && ANTHROPIC_MODELS.some((m) => m.id === model) ? 1_000_000 : undefined;
}

/** "Claude Opus 5.5" for a catalog model, else the model id. */
export function frontierDisplayName(provider: string, model: string): string {
  if (provider === "anthropic") return ANTHROPIC_MODELS.find((m) => m.id === model)?.name ?? model;
  return model;
}

/** What a picker shows for a frontier id: "Claude Opus 5.5 · your key". */
export function frontierLabel(id: string): string {
  const p = parseFrontierModelId(id);
  return p ? `${frontierDisplayName(p.provider, p.model)} · your key` : id;
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

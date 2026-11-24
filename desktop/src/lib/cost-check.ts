// The per-reply cost check and cost hints in the app (src/apps/ide/cost-guard.ts on the provider).
//
// - Settings → General → "Ask before a reply spends more than …": cSats on a network or cloud model
//   (default 150), USD on your own frontier key (default $0.50). Sent with each chat turn.
// - The compute picker's "~140 cSats per long reply" for paid models (reply-cost.ts: the model's
//   price times a reference long exploring reply).
// - A one-line hint under the composer when a premium paid model is picked for a chat in a project
//   ("GLM-5.3 costs ~5× Flash for exploring; …"), dismissible and shown once per chat.
import {
  DEFAULT_REPLY_ASK_CSATS, DEFAULT_REPLY_ASK_USD, clampReplyAskCSats, clampReplyAskUsd, cheaperFactor, costHintLine, premiumHint, referenceReplyCost, replyModelName,
  REPLY_ASK_CSATS_MAX, REPLY_ASK_CSATS_MIN, REPLY_ASK_USD_MAX, REPLY_ASK_USD_MIN, type ReplyPrice,
} from "./reply-cost";

export const ASK_CSATS_KEY = "edgecoder-reply-ask-csats";
export const ASK_USD_KEY = "edgecoder-reply-ask-usd";
const HINT_SEEN_KEY = "edgecoder-premium-hint-seen";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode: this session only
  }
}

/** The cSats threshold (Settings → General), default 150. */
export function replyAskCSatsSetting(): number {
  return clampReplyAskCSats(read(ASK_CSATS_KEY)) ?? DEFAULT_REPLY_ASK_CSATS;
}
/** The USD threshold for a frontier key (Settings → General), default $0.50. */
export function replyAskUsdSetting(): number {
  return clampReplyAskUsd(read(ASK_USD_KEY)) ?? DEFAULT_REPLY_ASK_USD;
}
/** Save the cSats threshold (clamped); returns what was kept. */
export function setReplyAskCSats(n: number): number {
  const v = Math.round(Math.min(REPLY_ASK_CSATS_MAX, Math.max(REPLY_ASK_CSATS_MIN, n)));
  write(ASK_CSATS_KEY, v === DEFAULT_REPLY_ASK_CSATS ? null : String(v));
  return v;
}
/** Save the USD threshold (clamped, cents); returns what was kept. */
export function setReplyAskUsd(n: number): number {
  const v = Math.round(Math.min(REPLY_ASK_USD_MAX, Math.max(REPLY_ASK_USD_MIN, n)) * 100) / 100;
  write(ASK_USD_KEY, v === DEFAULT_REPLY_ASK_USD ? null : String(v));
  return v;
}

/** USD per million tokens of the Anthropic models on your own key (src/inference-api/frontier-models.ts ANTHROPIC_MODELS). */
export const FRONTIER_PRICES: Record<string, ReplyPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cachedInput: 0.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
};

/** A network model's price as /inference/models lists it. */
export interface PricedModel {
  model: string;
  cSatsPerMTokens?: { input: number; output: number; cachedInput?: number };
  cloudHint?: string;
  classes?: string[];
}

/** The picker's cost line for a network model: "~140 cSats per long reply"; null without a price. */
export function networkCostHint(m: PricedModel): string | null {
  const p = m.cSatsPerMTokens;
  return p && p.input > 0 ? costHintLine(p, "cSats") : null;
}

/** The picker's cost line for a frontier choice ("frontier/anthropic/claude-opus-5-5"): "~$0.52 per long reply"; null when unknown. */
export function frontierCostHint(id: string): string | null {
  const m = /^frontier\/anthropic\/(.+)$/.exec(id);
  const p = m ? FRONTIER_PRICES[m[1]] : undefined;
  return p ? costHintLine(p, "usd") : null;
}

/** The cheap model the hint compares with (the cost check's suggestion too). */
export const CHEAP_MODEL = "deepseek-v4.1-flash";
/** A premium model costs at least this many times the cheap one on the reference reply. */
export const PREMIUM_FACTOR = 4;

/**
 * The composer hint for a chat on `choice` ("network/glm-5.3"), or null: only for a network model
 * that the network lists as premium or that costs PREMIUM_FACTOR× the cheap model or more.
 */
export function premiumModelHint(choice: string | undefined, models: PricedModel[] | null | undefined, frontierModels: string[] = []): string | null {
  if (!choice?.startsWith("network/")) return null;
  const rest = choice.slice(8);
  const at = rest.lastIndexOf("@");
  const name = at > 0 ? rest.slice(0, at) : rest;
  if (name === CHEAP_MODEL) return null;
  const list = models ?? [];
  const me = list.find((m) => m.model === name)?.cSatsPerMTokens;
  const cheap = list.find((m) => m.model === CHEAP_MODEL)?.cSatsPerMTokens;
  if (!me || !cheap) return null;
  const factor = cheaperFactor(referenceReplyCost(me), referenceReplyCost(cheap));
  const premium = list.find((m) => m.model === name)?.cloudHint === "premium";
  if (!factor || (factor < PREMIUM_FACTOR && !premium)) return null;
  const claude = frontierModels.some((id) => id.startsWith("frontier/anthropic/")) ? "Claude" : null;
  return premiumHint({ name: replyModelName(name), factor, cheaperName: "Flash", frontierName: claude });
}

/** Whether the premium hint was already shown (or dismissed) in this chat. */
export function premiumHintSeen(chatId: string): boolean {
  try {
    const seen = JSON.parse(read(HINT_SEEN_KEY) ?? "[]") as unknown;
    return Array.isArray(seen) && seen.includes(chatId);
  } catch {
    return false;
  }
}

/** Remember that this chat had its hint (the newest 200 chats are kept). */
export function markPremiumHintSeen(chatId: string): void {
  let seen: string[] = [];
  try {
    const v = JSON.parse(read(HINT_SEEN_KEY) ?? "[]") as unknown;
    if (Array.isArray(v)) seen = v.filter((x): x is string => typeof x === "string");
  } catch {
    seen = [];
  }
  if (seen.includes(chatId)) return;
  write(HINT_SEEN_KEY, JSON.stringify([...seen, chatId].slice(-200)));
}

/** A cost check's arguments as the card shows them (src/apps/ide/cost-guard.ts makeCostCheck). */
export interface CostCheckArgs {
  question: string;
  waste?: string;
  suggest?: { id: string; name: string; factor?: number };
  switchLabel?: string;
}

export function costCheckArgs(args: Record<string, unknown> | undefined): CostCheckArgs {
  const a = args ?? {};
  const s = a.suggest as { id?: unknown; name?: unknown; factor?: unknown } | undefined;
  const suggest = s && typeof s.id === "string" && typeof s.name === "string" ? { id: s.id, name: s.name, ...(typeof s.factor === "number" ? { factor: s.factor } : {}) } : undefined;
  return {
    question: typeof a.question === "string" ? a.question : "This reply has spent more than your limit.",
    ...(typeof a.waste === "string" ? { waste: a.waste } : {}),
    ...(suggest ? { suggest, switchLabel: typeof a.switchLabel === "string" ? a.switchLabel : `Switch to ${suggest.name}` } : {}),
  };
}

export const COST_CHECK_TOOL = "cost_check";

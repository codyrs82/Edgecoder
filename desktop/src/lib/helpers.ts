// The Code view's Helpers switch (docs/tentacles.md): the lead hands well-specified pieces to
// helper agents ("tentacles"), easy ones on this computer's model first, the rest on the network.
// Each chat keeps its own setting; new chats follow Settings → General. By default helpers are on
// when the lead is your own frontier key (Claude and the like) and off otherwise, unless you changed it.
import { isFrontierChoice } from "./compute-choice";

/** A chat's own Helpers setting (kept with the chat). `enabled` unset: the default rule decides. */
export interface ChatHelpers {
  enabled?: boolean;
  maxParallel?: number;
  budgetCSats?: number;
}

/** Settings → General: when new chats turn helpers on, how many run at once, and their budget. */
export interface HelpersDefaults {
  /** "frontier": on when the lead is a frontier model (your own key), off otherwise. */
  when: "frontier" | "always" | "never";
  maxParallel: number;
  budgetCSats: number;
}

export const HELPERS_MAX_PARALLEL = 4;
export const HELPERS_BUDGET_CSATS = 100;
export const DEFAULT_HELPERS: HelpersDefaults = { when: "frontier", maxParallel: HELPERS_MAX_PARALLEL, budgetCSats: HELPERS_BUDGET_CSATS };

const KEY = "edgecoder-default-helpers";

const clampParallel = (n: unknown) => (Number.isFinite(Number(n)) ? Math.min(16, Math.max(1, Math.floor(Number(n)))) : HELPERS_MAX_PARALLEL);
const clampBudget = (n: unknown) => (Number.isFinite(Number(n)) ? Math.min(1e7, Math.max(0, Number(n))) : HELPERS_BUDGET_CSATS);

export function helpersDefaults(): HelpersDefaults {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<HelpersDefaults> | null;
    if (!raw || typeof raw !== "object") return { ...DEFAULT_HELPERS };
    return {
      when: raw.when === "always" || raw.when === "never" ? raw.when : "frontier",
      maxParallel: raw.maxParallel === undefined ? HELPERS_MAX_PARALLEL : clampParallel(raw.maxParallel),
      budgetCSats: raw.budgetCSats === undefined ? HELPERS_BUDGET_CSATS : clampBudget(raw.budgetCSats),
    };
  } catch {
    return { ...DEFAULT_HELPERS };
  }
}

export function setHelpersDefaults(d: Partial<HelpersDefaults>): HelpersDefaults {
  const next = { ...helpersDefaults(), ...d };
  const clean: HelpersDefaults = { when: next.when, maxParallel: clampParallel(next.maxParallel), budgetCSats: clampBudget(next.budgetCSats) };
  try {
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    // storage unavailable: lasts for this session only
  }
  return clean;
}

/**
 * Whether a chat's helpers are on: the chat's own choice when the user made one; else Settings'
 * default, whose "frontier" rule is on for a frontier lead (your own key) and off otherwise.
 */
export function helpersOn(chat: ChatHelpers | undefined, leadId: string | undefined, defaults: HelpersDefaults = helpersDefaults()): boolean {
  if (typeof chat?.enabled === "boolean") return chat.enabled;
  if (defaults.when === "always") return true;
  if (defaults.when === "never") return false;
  return isFrontierChoice(leadId);
}

/** What a chat sends with each message: on or off, how many at once, and the session budget. */
export function effectiveHelpers(chat: ChatHelpers | undefined, leadId: string | undefined, defaults: HelpersDefaults = helpersDefaults()): { enabled: boolean; maxParallel: number; budgetCSats: number } {
  return {
    enabled: helpersOn(chat, leadId, defaults),
    maxParallel: chat?.maxParallel === undefined ? defaults.maxParallel : clampParallel(chat.maxParallel),
    budgetCSats: chat?.budgetCSats === undefined ? defaults.budgetCSats : clampBudget(chat.budgetCSats),
  };
}

/** The button's label: "Helpers off", or "Helpers · 4 · 100 cSats". */
export function helpersLabel(h: { enabled: boolean; maxParallel: number; budgetCSats: number }): string {
  return h.enabled ? `Helpers · ${h.maxParallel} · ${h.budgetCSats} cSats` : "Helpers off";
}

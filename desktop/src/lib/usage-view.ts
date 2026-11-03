// Pure helpers for the Usage page: budget state, CSV, and per-token prices.
import type { UsageRecord, UsageSlice } from "./api";

const BUDGET_KEY = "edgecoder-monthly-budget-csats";

export function loadBudget(store: Pick<Storage, "getItem"> | null = safe()): number | null {
  try {
    const v = Number(store?.getItem(BUDGET_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function saveBudget(v: number | null, store: Pick<Storage, "setItem" | "removeItem"> | null = safe()): void {
  try {
    if (v && v > 0) store?.setItem(BUDGET_KEY, String(v));
    else store?.removeItem(BUDGET_KEY);
  } catch {
    // storage unavailable
  }
}

function safe(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Spend this calendar month against the budget: ok, near (80%+) or over. */
export function budgetState(monthSpent: number, budget: number | null): { level: "none" | "ok" | "near" | "over"; percent: number } {
  if (!budget) return { level: "none", percent: 0 };
  const percent = Math.round((monthSpent / budget) * 100);
  return { level: percent >= 100 ? "over" : percent >= 80 ? "near" : "ok", percent };
}

/** cSats spent this calendar month (local time) from daily totals. */
export function monthToDate(byDay: Array<{ day: string; cSats: number }>, now = new Date()): number {
  const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return Number(byDay.filter((d) => d.day.startsWith(prefix)).reduce((n, d) => n + d.cSats, 0).toFixed(3));
}

/** What a million output tokens cost at this slice's real rate, or null without token counts. */
export function cSatsPerMillionTokens(s: Pick<UsageSlice, "cSats" | "promptTokens" | "outputTokens">): number | null {
  const tokens = s.promptTokens + s.outputTokens;
  return tokens > 0 && s.cSats > 0 ? Math.round((s.cSats / tokens) * 1_000_000) : null;
}

const esc = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function usageCsv(records: UsageRecord[]): string {
  const head = ["time", "kind", "where", "class", "model", "tool", "machine", "ok", "seconds", "prompt_tokens", "output_tokens", "csats"];
  const rows = records.map((r) => [new Date(r.atMs).toISOString(), r.kind, r.placement, r.computeClass, r.model, r.source, r.agentId, r.ok, (r.durationMs / 1000).toFixed(1), r.promptTokens, r.outputTokens, (r.costMsat / 1000).toFixed(3)]);
  return [head, ...rows].map((row) => row.map(esc).join(",")).join("\n") + "\n";
}

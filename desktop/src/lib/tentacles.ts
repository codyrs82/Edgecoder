// A session's tentacles (helper agents the lead delegates to; docs/tentacles.md) as the Live
// session panel shows them: built from GET /v1/ide/sessions/:id/tentacles, then kept up to date
// by the session's tentacle_* events. Pure, so it is tested without the app.
import type { SessionEvent } from "./api";
import { servedLine, type CallUsage } from "./served";

/** A helper call, with where it ran: this computer's own model (local first) or the network. */
export type HelperCall = CallUsage & { place?: "local" | "network" };

export interface TentacleItem {
  id: string;
  task: string;
  kind: string;
  readOnly: boolean;
  status: "queued" | "running" | "verifying" | "passed" | "failed" | "error" | "cancelled";
  progress: string;
  createdAt: number;
  cSats: number;
  model?: string;
  /** Each model call (where it ran: the coordinator's served-by), as tentacle_usage reports it. */
  calls?: HelperCall[];
  result?: { model: string; class: string; summary: string; filesTouched: string[]; patch: string; error?: string; attempts: number; calls?: HelperCall[]; unverified?: string; place?: "local" | "network" };
  merge?: { state: "applied" | "awaiting_approval" | "rejected" | "conflict" | "not_applied" | "no_changes"; error?: string };
}

export interface TentacleState {
  items: TentacleItem[];
  spentCSats: number;
  enabled: boolean;
  /** The last merged batch's totals line and the session's (tentacle_totals), for the footer. */
  totals?: { batch: string; session: string };
}

export const emptyTentacles = (): TentacleState => ({ items: [], spentCSats: 0, enabled: false });

/** A helper's calls (live, or from its result). */
export const callsOf = (t: TentacleItem): HelperCall[] => t.result?.calls ?? t.calls ?? [];

/**
 * One served line per helper call, in the desktop footer's format (served.ts), led by where it ran:
 * "this computer · qwen3.5:9b · …" or "network · qwen3-coder:30b · GPU · Chicago · …".
 */
export function callLines(t: TentacleItem): string[] {
  return callsOf(t)
    .map((c) => {
      const line = servedLine([c]) ?? `${c.model ?? "auto"} · ${c.where ?? "unknown"} · ${c.cSats} cSats`;
      return c.place ? `${c.place === "local" ? "this computer" : "network"} · ${line}` : line;
    })
    .filter(Boolean);
}

export const isActive = (t: TentacleItem) => t.status === "queued" || t.status === "running" || t.status === "verifying";

function upsert(items: TentacleItem[], t: TentacleItem): TentacleItem[] {
  const i = items.findIndex((x) => x.id === t.id);
  if (i < 0) return [...items, t];
  const next = items.slice();
  next[i] = t;
  return next;
}

export function applyTentacleEvent(s: TentacleState, e: SessionEvent): TentacleState {
  switch (e.type) {
    case "tentacle_started":
    case "tentacle_finished":
    case "tentacle_merge": {
      const t = e.tentacle as TentacleItem | undefined;
      if (!t) return s;
      const items = upsert(s.items, t);
      return { ...s, items, spentCSats: Math.max(s.spentCSats, items.reduce((n, x) => n + (x.cSats || 0), 0)) };
    }
    case "tentacle_progress": {
      const t = s.items.find((x) => x.id === e.id);
      if (!t) return s;
      const next: TentacleItem = { ...t, status: e.status as TentacleItem["status"], progress: String(e.progress ?? ""), cSats: Number(e.cSats ?? t.cSats), ...(typeof e.model === "string" ? { model: e.model } : {}) };
      return { ...s, items: upsert(s.items, next) };
    }
    case "tentacle_usage": {
      const t = s.items.find((x) => x.id === e.id);
      const call = e.call as HelperCall | undefined;
      if (!t || !call) return s;
      const next: TentacleItem = { ...t, calls: [...(t.calls ?? []), call], cSats: Number(e.cSats ?? t.cSats) };
      return { ...s, items: upsert(s.items, next), spentCSats: Number(e.spentCSats ?? s.spentCSats) };
    }
    case "tentacle_totals": {
      const batch = (e.totals as { line?: string } | undefined)?.line;
      const session = (e.session as { line?: string } | undefined)?.line;
      return batch ? { ...s, totals: { batch, session: session ?? batch } } : s;
    }
    case "tentacle_config": {
      const c = e.config as { enabled?: boolean } | undefined;
      return { ...s, enabled: c?.enabled ?? s.enabled, spentCSats: Number(e.spentCSats ?? s.spentCSats) };
    }
    default:
      return s;
  }
}

/** "qwen3-coder:30b on gpu", or the worker model while it runs. */
export function whereOf(t: TentacleItem): string {
  return t.result ? `${t.result.model} on ${t.result.class}` : t.model ?? "auto";
}

export function statusLabel(t: TentacleItem): string {
  if (t.merge?.state === "awaiting_approval") return t.result?.unverified ? "passed · unverified · waiting for approval" : "passed · waiting for approval";
  if (t.merge?.state === "applied") return "passed · merged";
  if (t.merge?.state === "conflict") return `${t.status} · conflict`;
  if (t.merge?.state === "rejected") return "passed · dropped";
  return t.status;
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * How a tentacle's model calls read (tentacles.ts): each call's served line and the totals the
 * lead's results and the clients show. No Node imports, so the terminal can use it as is.
 */

import type { TentacleCall, TentacleView } from "./tentacles.js";

const round = (n: number) => Number(n.toFixed(6));

/** Where a model call ran, from a backend's `where` ("routed to <model> on <class> because …", a route label). */
export function parseWhere(where: string | undefined, fallbackModel: string): { model: string; class: string; agentLabel: string } {
  const w = (where ?? "").trim();
  const routed = /routed to (\S+) on (\S+)/.exec(w);
  if (routed) return { model: routed[1], class: routed[2].replace(/[,.;]$/, ""), agentLabel: w };
  const cls = /@(gpu\.dc|gpu|apple|cpu)\b/.exec(w) ?? /\b(gpu\.dc|gpu|apple|cpu)\b/.exec(w);
  const model = /(?:network|mine)\/([^\s@]+)/.exec(w)?.[1] ?? (fallbackModel === "auto" ? (w.split(/\s/)[0] || "auto") : fallbackModel);
  return { model, class: cls?.[1] ?? (w ? "any" : "unknown"), agentLabel: w || fallbackModel };
}

export const formatCSatsShort = (c: number) => `${c < 10 ? c.toFixed(1) : Math.round(c)} cSats`;
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/**
 * A helper call's served line: `model · class · host region · tokens · cSats`. With where it ran
 * (local first): `model · this computer · tokens · cSats`, or `model · network <class> · host region · …`.
 */
export function tentacleCallLine(c: TentacleCall): string {
  const s = c.served;
  const cls = s?.computeClass ?? parseWhere(c.where, c.model).class;
  const place = s ? s.city ?? s.region ?? s.country ?? "" : "";
  const pin = c.promptTokens ?? s?.promptTokens ?? 0;
  const pout = c.outputTokens ?? s?.outputTokens ?? 0;
  const tokens = pin || pout ? `${tok(pin)} in / ${tok(pout)} out tok` : "";
  const model = c.model.replace(/^network\//, "");
  if (c.place === "local") return [model, "this computer", tokens, formatCSatsShort(c.cSats)].filter(Boolean).join(" · ");
  const host = place ? `${s?.label ? `${s.label} ` : ""}${place}` : s?.label ?? "";
  return [model, c.place === "network" ? `network ${cls}` : cls, host, tokens, formatCSatsShort(c.cSats)].filter(Boolean).join(" · ");
}

/** Totals over helper calls (the lead's summary): calls, models, tokens, cSats, and one line. */
export function tentacleTotals(views: Array<Pick<TentacleView, "calls" | "cSats">>): { helpers: number; calls: number; models: string[]; promptTokens: number; outputTokens: number; cSats: number; line: string } {
  const calls = views.flatMap((v) => v.calls ?? []);
  const models = [...new Set(calls.map((c) => c.model.replace(/^network\//, "")))];
  const promptTokens = calls.reduce((n, c) => n + (c.promptTokens ?? c.served?.promptTokens ?? 0), 0);
  const outputTokens = calls.reduce((n, c) => n + (c.outputTokens ?? c.served?.outputTokens ?? 0), 0);
  const cSats = round(views.reduce((n, v) => n + (Number.isFinite(v.cSats) ? v.cSats : 0), 0));
  const line = `${views.length} helper${views.length === 1 ? "" : "s"} · ${calls.length} call${calls.length === 1 ? "" : "s"}${models.length ? ` · ${models.join(", ")}` : ""} · ${tok(promptTokens)} in / ${tok(outputTokens)} out tok · ${formatCSatsShort(cSats)}`;
  return { helpers: views.length, calls: calls.length, models, promptTokens, outputTokens, cSats, line };
}

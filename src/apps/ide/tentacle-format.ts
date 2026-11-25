// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * How a tentacle's model calls read (tentacles.ts): each call's served line and the totals the
 * lead's results and the clients show. No Node imports, so the terminal can use it as is.
 */

import type { ServedBy } from "../../swarm/served-by.js";
import type { TentacleCall, TentacleResult, TentacleView } from "./tentacles.js";

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

/** The host that served a call, as its served line shows it: `mac-•••30e5 Frankfurt`, or just the label. */
function hostOf(s: ServedBy | undefined): string {
  if (!s) return "";
  const place = s.city ?? s.region ?? s.country ?? "";
  return place ? `${s.label ? `${s.label} ` : ""}${place}` : s.label ?? "";
}

/**
 * Where a helper ran, from its backend's `where` and the latest call's served-by: the network's
 * answer names the class and the host even when the backend gave no `where` (a named network
 * model), which parseWhere alone read as "unknown".
 */
export function whereServed(where: string | undefined, fallbackModel: string, served: ServedBy | undefined): { model: string; class: string; agentLabel: string } {
  const w = parseWhere(where, fallbackModel);
  if (!served) return w;
  const host = hostOf(served);
  return {
    model: w.model,
    class: served.computeClass || w.class,
    agentLabel: where?.trim() ? w.agentLabel : host ? `${served.computeClass ? `${served.computeClass} · ` : ""}${host}` : w.agentLabel,
  };
}

/** A finished helper's "ran on" text: `model on class · host` (the host from its latest call), or `model on this computer`. */
export function tentacleRanOn(r: Pick<TentacleResult, "model" | "class"> & Partial<Pick<TentacleResult, "calls" | "place">>): string {
  if (r.place === "local" || r.class === "this computer") return `${r.model} on this computer`;
  // The latest call's own host only: an earlier call's (another attempt's) host would mislabel it.
  const served = r.calls?.[r.calls.length - 1]?.served;
  const cls = r.class && r.class !== "unknown" && r.class !== "any" ? r.class : served?.computeClass || r.class;
  const host = hostOf(served);
  return `${r.model} on ${cls}${host ? ` · ${host}` : ""}`;
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
  const pin = c.promptTokens ?? s?.promptTokens ?? 0;
  const pout = c.outputTokens ?? s?.outputTokens ?? 0;
  const tokens = pin || pout ? `${tok(pin)} in / ${tok(pout)} out tok` : "";
  const model = c.model.replace(/^network\//, "");
  if (c.place === "local") return [model, "this computer", tokens, formatCSatsShort(c.cSats)].filter(Boolean).join(" · ");
  const host = hostOf(s);
  return [model, c.place === "network" ? `network ${cls}` : cls, host, tokens, formatCSatsShort(c.cSats)].filter(Boolean).join(" · ");
}

/**
 * Patches back from helpers that write (not read-only, not review) and have finished: how many
 * returned a non-empty patch, and the rate (#525: 0 of 16 came back from a 1.5B worker). Null rate
 * before any has finished.
 */
export function patchReturn(views: Array<Partial<Pick<TentacleView, "readOnly" | "kind" | "status" | "result">>>): { asked: number; returned: number; rate: number | null } {
  const writers = views.filter((v) => v.readOnly === false && v.kind !== "review" && v.status !== undefined && !["queued", "running", "verifying", "cancelled"].includes(v.status));
  const returned = writers.filter((v) => !!v.result?.patch?.trim()).length;
  return { asked: writers.length, returned, rate: writers.length ? Number((returned / writers.length).toFixed(3)) : null };
}

/** Totals over helper calls (the lead's summary): calls, models, tokens, cSats, patches returned, and one line. */
export function tentacleTotals(views: Array<Pick<TentacleView, "calls" | "cSats"> & Partial<Pick<TentacleView, "readOnly" | "kind" | "status" | "result">>>): { helpers: number; calls: number; models: string[]; promptTokens: number; outputTokens: number; cSats: number; patches: ReturnType<typeof patchReturn>; line: string } {
  const calls = views.flatMap((v) => v.calls ?? []);
  const models = [...new Set(calls.map((c) => c.model.replace(/^network\//, "")))];
  const promptTokens = calls.reduce((n, c) => n + (c.promptTokens ?? c.served?.promptTokens ?? 0), 0);
  const outputTokens = calls.reduce((n, c) => n + (c.outputTokens ?? c.served?.outputTokens ?? 0), 0);
  const cSats = round(views.reduce((n, v) => n + (Number.isFinite(v.cSats) ? v.cSats : 0), 0));
  const patches = patchReturn(views);
  const patchLine = patches.asked ? ` · ${patches.returned}/${patches.asked} patch${patches.asked === 1 ? "" : "es"} back` : "";
  const line = `${views.length} helper${views.length === 1 ? "" : "s"} · ${calls.length} call${calls.length === 1 ? "" : "s"}${models.length ? ` · ${models.join(", ")}` : ""} · ${tok(promptTokens)} in / ${tok(outputTokens)} out tok · ${formatCSatsShort(cSats)}${patchLine}`;
  return { helpers: views.length, calls: calls.length, models, promptTokens, outputTokens, cSats, patches, line };
}

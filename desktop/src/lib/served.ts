// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

// Shared by the desktop app (desktop/src/lib/served.ts) and the portal's web chat
// (src/common/served.ts, shipped to the page via Function.prototype.toString, so every helper is a
// plain function declaration). Keep both copies byte-identical (tests/common/served.test.ts).
//
// Where a reply's model calls ran (the coordinator's served-by, or "This computer (…)"), as the
// footer under a reply shows it, and the per-call breakdown its tooltip shows. The terminal prints
// the same line (src/terminal/render.ts usageLine).

export interface Served {
  label: string;
  own: boolean;
  computeClass: string;
  tier: string | null;
  hardware: string;
  gpu?: string;
  region: string | null;
  city?: string;
  country: string | null;
  pickupMs?: number;
  promptMs?: number;
  genMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  /** A frontier call on your own key (computeClass "frontier"): estimated USD. */
  usd?: number;
}

export interface CallUsage {
  cSats: number;
  where?: string;
  model?: string;
  served?: Served;
}

export function servedTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);
}
export function servedSecs(ms: number): string {
  return ms >= 10000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}
export function servedCost(n: number): string {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 3 })} cSats`;
}

/** "Datacenter GPU 2×A16", or "This computer (Apple M1 Max)". */
export function hardwareShort(s: Served): string {
  if (s.computeClass === "local") return s.hardware;
  const cls = s.hardware.replace(/\s*\([^)]*\)\s*$/, "");
  const gpu = s.gpu ? s.gpu.replace(/^(\d+)× /, "$1×").replace(/^(\d+×)?(NVIDIA|AMD|Apple|Intel) /, "$1") : "";
  return `${cls}${gpu ? ` ${gpu}` : s.tier ? ` (${s.tier})` : ""}${s.own ? " · your machine" : ""}`;
}

/** `qwen3-coder:30b · Datacenter GPU 2×A16 · Chicago · read 24.8k tok in 81 s · wrote 312 tok in 6.5 s · 3.4 cSats`; null without served calls. */
export function servedLine(calls: CallUsage[] | undefined): string | null {
  const withServed = (calls ?? []).filter((c) => c.served);
  if (!withServed.length || !calls) return null;
  const last = withServed[withServed.length - 1];
  const s = last.served!;
  const bits: string[] = [];
  if (s.computeClass === "frontier") {
    // Your own frontier key: provider · model · your key · tokens · $cost (no cSats).
    bits.push(s.hardware.split(" · ")[0], (last.model ?? "").replace(/^frontier\/[^/]+\//, ""), "your key");
  } else {
    if (last.model) bits.push(last.model.replace(/^network\//, ""));
    bits.push(hardwareShort(s));
    const place = s.city ?? s.region ?? s.country;
    if (place) bits.push(place);
  }
  const machines = new Set(withServed.map((c) => c.served!.label));
  if (machines.size > 1) bits.push(`${machines.size} machines`);
  const sum = function (k: "promptTokens" | "outputTokens" | "promptMs" | "genMs"): number {
    return calls.reduce((n, c) => n + (c.served?.[k] ?? 0), 0);
  };
  if (sum("promptTokens")) bits.push(`read ${servedTok(sum("promptTokens"))} tok${sum("promptMs") ? ` in ${servedSecs(sum("promptMs"))}` : ""}`);
  if (sum("outputTokens")) bits.push(`wrote ${servedTok(sum("outputTokens"))} tok${sum("genMs") ? ` in ${servedSecs(sum("genMs"))}` : ""}`);
  if (calls.length > 1) bits.push(`${calls.length} calls`);
  const total = calls.reduce((n, c) => n + (Number.isFinite(c.cSats) ? c.cSats : 0), 0);
  const anyFrontier = calls.some((c) => c.served?.computeClass === "frontier");
  if (!anyFrontier || total > 0) bits.push((s.computeClass === "local" || s.computeClass === "edgecoder" || s.own) && total === 0 ? "free" : servedCost(total));
  if (anyFrontier) {
    const usd = calls.reduce((n, c) => n + (c.served?.usd ?? 0), 0);
    bits.push(usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);
  }
  return bits.join(" · ");
}

/** One line per call, for the footer's tooltip. */
export function servedBreakdown(calls: CallUsage[] | undefined): string {
  return (calls ?? [])
    .map((c, i) => {
      const s = c.served;
      if (!s) return `${i + 1}. ${c.where ?? "unknown"} · ${servedCost(c.cSats)}`;
      const t = [
        s.pickupMs !== undefined ? `pickup ${servedSecs(s.pickupMs)}` : "",
        s.promptTokens !== undefined ? `read ${servedTok(s.promptTokens)} tok${s.promptMs !== undefined ? ` in ${servedSecs(s.promptMs)}` : ""}` : "",
        s.outputTokens !== undefined ? `wrote ${servedTok(s.outputTokens)} tok${s.genMs !== undefined ? ` in ${servedSecs(s.genMs)}` : ""}` : "",
      ].filter(Boolean);
      return `${i + 1}. ${[c.model?.replace(/^network\//, ""), s.label, s.hardware, s.gpu, [s.city, s.region].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}${t.length ? ` (${t.join(", ")})` : ""} · ${servedCost(c.cSats)}`;
    })
    .join("\n");
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Mergeable latency histograms and per-stage aggregates for the load generator. Every machine
 * prints its stage aggregates with histograms (log buckets, ~5% wide), so report.mjs can add up
 * the machines and still give correct percentiles.
 */
const GROWTH = 1.05;
const LOG_G = Math.log(GROWTH);

export const bucketOf = (ms) => (ms <= 1 ? 0 : Math.ceil(Math.log(ms) / LOG_G));
export const bucketValue = (b) => Math.round(GROWTH ** b);

export function histAdd(h, ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return;
  const b = bucketOf(ms);
  h[b] = (h[b] ?? 0) + 1;
}

export function histMerge(into, from) {
  for (const [b, n] of Object.entries(from ?? {})) into[b] = (into[b] ?? 0) + n;
  return into;
}

export function histPct(h, p) {
  const entries = Object.entries(h ?? {}).map(([b, n]) => [Number(b), n]).sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (!total) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * total));
  let seen = 0;
  for (const [b, n] of entries) {
    seen += n;
    if (seen >= rank) return bucketValue(b);
  }
  return bucketValue(entries[entries.length - 1][0]);
}

export const pcts = (h) => ({ p50: histPct(h, 50), p90: histPct(h, 90), p99: histPct(h, 99) });

/**
 * Errors that count toward the global stop: real failures. Not counted: over_capacity and
 * timeout_over_capacity (a model asked for beyond its slots; the planner backs that model off),
 * gaps (no machine holds the model or class), which say nothing about load.
 */
export const FAILURES = new Set([
  "timeout", "network_error", "no_capacity", "rate_limited", "auth_error", "insufficient_funds",
  // What used to be one "stream_error" (classifyCall below); kept for results from older runs.
  "stream_error", "stream_cut_before_tokens", "stream_cut_after_tokens", "stream_idle_timeout", "stream_truncated",
  "no_response_timeout", "timeout_after_tokens", "agent_error", "agent_lost_mid_reply", "relay_error", "relay_timeout", "server_restarting", "inband_error",
]);
export const isFailure = (e) => !!e && (FAILURES.has(e) || /^(http|upstream)_5/.test(e));

/** Error type of a finished call (null = success). */
export function classifyError(status, body) {
  const t = String(body ?? "").toLowerCase();
  if (status === "timeout") return "timeout";
  if (status === 0 || status === "network") return "network_error";
  if (t.includes("no_agent_in_class")) return "no_agent_in_class";
  if (t.includes("no machine on the network has")) return "no_agent_has_model";
  if (/no [a-z.]+ machine runs/.test(t)) return "no_agent_in_class";
  if (t.includes("no_capacity") || t.includes("no machine") || t.includes("no free") || status === 503) return "no_capacity";
  if (status === 429 || t.includes("rate_limit")) return "rate_limited";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 402 || t.includes("insufficient") || t.includes("billing")) return "insufficient_funds";
  if (status === 409) return "conflict_409";
  if (status === 404 || t.includes("not found") || t.includes("model_not_found")) return "model_not_found";
  if (typeof status === "number" && status >= 500) return `http_${status}`;
  if (typeof status === "number" && status !== 200) return `http_${status}`;
  return t ? "stream_error" : null;
}

/** A body that is not the API's JSON (an edge proxy's HTML error page: Cloudflare, Fly). */
const notJson = (body) => {
  const t = String(body ?? "").trim();
  if (!t) return true;
  try { JSON.parse(t); return false; } catch { return true; }
};

/**
 * Error type of a streamed call from how it ended (null = success). "stream_error" used to cover
 * every one of these; each now says which hop failed and when:
 *
 * - failure "timeout" (the client's own deadline): `timeout` before any token (the planner turns it
 *   into timeout_over_capacity at a model's share), `timeout_after_tokens` once text was arriving;
 * - failure "idle" (no byte, keepalive comments included, for the idle bound: the relay's 15 s
 *   keepalives stopped): `stream_idle_timeout` after the response head, `no_response_timeout` before;
 * - failure "network" (the connection closed under the client: undici's "terminated"):
 *   `network_error` before the response head, else `stream_cut_before_tokens` / `stream_cut_after_tokens`;
 * - a non-200 status with a non-JSON body (Cloudflare's or Fly's error page): `upstream_<status>`;
 *   the portal's own JSON errors keep classifyError's names (`http_502` = the portal said 502);
 * - an error event inside the stream: classifyError's names for capacity and the like, else
 *   `agent_error` (the machine reported a failure), `agent_lost_mid_reply` (it vanished after part of
 *   the reply), `server_restarting` (the portal drained the stream for a restart), `relay_error` /
 *   `relay_timeout` (the portal's relay from the coordinator), `inband_error` for anything else;
 * - a 200 stream that ended with no error and no [DONE]: `stream_truncated` (counted as a success before).
 */
export function classifyCall({ status, errBody = "", failure = null, gotHeaders = false, tokens = false, sawDone = false, inband = false }) {
  if (failure === "timeout") return tokens ? "timeout_after_tokens" : "timeout";
  if (failure === "idle") return gotHeaders ? "stream_idle_timeout" : "no_response_timeout";
  if (failure === "network") return !gotHeaders ? "network_error" : tokens ? "stream_cut_after_tokens" : "stream_cut_before_tokens";
  if (status !== 200) {
    if (typeof status === "number" && status >= 500 && notJson(errBody)) return `upstream_${status}`;
    return classifyError(status, errBody) ?? `http_${status}`;
  }
  if (inband) {
    const c = classifyError(200, errBody);
    if (c !== "stream_error") return c;
    const t = String(errBody).toLowerCase();
    if (t.includes("agent_lost_mid_reply") || t.includes("stopped responding")) return "agent_lost_mid_reply";
    if (t.includes("server_restarting") || t.includes("restarting")) return "server_restarting";
    if (t.includes("reported:")) return "agent_error";
    if (t.includes("didn't finish within")) return "relay_timeout";
    if (t.includes("network stream failed") || t.includes("network request failed")) return "relay_error";
    return "inband_error";
  }
  return sawDone ? null : "stream_truncated";
}

function emptyGroup() {
  return { calls: 0, ok: 0, checked: 0, correct: 0, errors: {}, cSats: 0, ttft: {}, total: {}, promptTokens: 0, outputTokens: 0 };
}

function addTo(g, r) {
  g.calls++;
  if (r.error) g.errors[r.error] = (g.errors[r.error] ?? 0) + 1;
  else {
    g.ok++;
    histAdd(g.ttft, r.ttftMs);
    histAdd(g.total, r.totalMs);
  }
  if (r.correct !== null && r.correct !== undefined && !r.error) {
    g.checked++;
    if (r.correct) g.correct++;
  }
  g.cSats += r.cSats ?? 0;
  g.promptTokens += r.promptTokens ?? 0;
  g.outputTokens += r.outputTokens ?? 0;
}

function mergeGroup(a, b) {
  for (const k of ["calls", "ok", "checked", "correct", "cSats", "promptTokens", "outputTokens"]) a[k] += b[k] ?? 0;
  for (const [e, n] of Object.entries(b.errors ?? {})) a.errors[e] = (a.errors[e] ?? 0) + n;
  histMerge(a.ttft, b.ttft);
  histMerge(a.total, b.total);
  return a;
}

/** The model's compute class as asked for: the @suffix, or "any" (auto = "auto"). */
export const classOf = (model) => (model === "auto" ? "auto" : model.includes("@") ? model.slice(model.lastIndexOf("@") + 1) : "any");

/** Aggregate for one stage on one machine; mergeable with mergeStage. */
export class StageStats {
  constructor(stage) {
    this.stage = stage.index;
    this.rate = stage.rate;
    this.startMs = Date.now();
    this.endMs = null;
    this.all = emptyGroup();
    this.byModel = {};
    this.byClass = {};
    this.byBehaviour = {};
    this.where = {};
    this.dropped = 0;
    this.droppedBy = {};
    this.errLogged = 0;
  }
  add(r) {
    addTo(this.all, r);
    addTo((this.byModel[r.model] ??= emptyGroup()), r);
    addTo((this.byClass[classOf(r.model)] ??= emptyGroup()), r);
    addTo((this.byBehaviour[r.behaviour] ??= emptyGroup()), r);
    if (r.where) this.where[r.where] = (this.where[r.where] ?? 0) + 1;
  }
  /** An arrival not sent: "inflight_cap", "capacity" (no model had room), "no_user" (all paused). */
  drop(reason) {
    this.dropped++;
    this.droppedBy[reason] = (this.droppedBy[reason] ?? 0) + 1;
  }
  toJSON() {
    return { stage: this.stage, rate: this.rate, startMs: this.startMs, endMs: this.endMs, utilSum: this.utilSum ?? 0, utilN: this.utilN ?? 0, dropped: this.dropped, droppedBy: this.droppedBy, all: this.all, byModel: this.byModel, byClass: this.byClass, byBehaviour: this.byBehaviour, where: this.where };
  }
}

export function mergeStage(a, b) {
  if (!a) return JSON.parse(JSON.stringify(b));
  a.startMs = Math.min(a.startMs, b.startMs);
  a.endMs = Math.max(a.endMs ?? 0, b.endMs ?? 0) || null;
  a.rate += b.rate;
  a.utilSum = (a.utilSum ?? 0) + (b.utilSum ?? 0);
  a.utilN = (a.utilN ?? 0) + (b.utilN ?? 0);
  a.dropped += b.dropped ?? 0;
  a.droppedBy ??= {};
  for (const [k, n] of Object.entries(b.droppedBy ?? {})) a.droppedBy[k] = (a.droppedBy[k] ?? 0) + n;
  mergeGroup(a.all, b.all);
  for (const key of ["byModel", "byClass", "byBehaviour"]) for (const [k, g] of Object.entries(b[key] ?? {})) mergeGroup((a[key][k] ??= emptyGroup()), g);
  for (const [k, n] of Object.entries(b.where ?? {})) a.where[k] = (a.where[k] ?? 0) + n;
  return a;
}

const r1 = (x) => Math.round(x * 10) / 10;

/** A readable digest of a group (what the JSON lines and the summary table show). */
export function digest(g, seconds) {
  return {
    calls: g.calls,
    offeredPerSec: seconds ? Math.round((100 * g.calls) / seconds) / 100 : null,
    throughputPerSec: seconds ? Math.round((100 * g.ok) / seconds) / 100 : null,
    successPct: g.calls ? r1((100 * g.ok) / g.calls) : null,
    accuracyPct: g.checked ? r1((100 * g.correct) / g.checked) : null,
    ttftMs: pcts(g.ttft),
    totalMs: pcts(g.total),
    errors: g.errors,
    cSats: Math.round(g.cSats * 1000) / 1000,
    tokens: { prompt: g.promptTokens, output: g.outputTokens },
  };
}

export function digestStage(s) {
  const seconds = s.endMs && s.startMs ? (s.endMs - s.startMs) / 1000 : null;
  const map = (o) => Object.fromEntries(Object.entries(o).map(([k, g]) => [k, digest(g, seconds)]));
  return { stage: s.stage, offeredRate: r1(s.rate), seconds: seconds && Math.round(seconds), utilPct: s.utilN ? r1((100 * s.utilSum) / s.utilN) : null, dropped: s.dropped, droppedBy: s.droppedBy ?? {}, ...digest(s.all, seconds), byModel: map(s.byModel), byClass: map(s.byClass), byBehaviour: map(s.byBehaviour), where: s.where };
}

/** Plain-text table of stage digests. */
export function table(rows) {
  const head = ["stage", "rate", "calls", "offered/s", "ok/s", "ok%", "acc%", "ttft p50/p90/p99 ms", "total p50/p90/p99 ms", "cSats", "errors"];
  const lines = rows.map((d) => [
    String(d.stage), String(d.offeredRate), String(d.calls), String(d.offeredPerSec ?? "-"), String(d.throughputPerSec ?? "-"), String(d.successPct ?? "-"), String(d.accuracyPct ?? "-"),
    `${d.ttftMs.p50 ?? "-"}/${d.ttftMs.p90 ?? "-"}/${d.ttftMs.p99 ?? "-"}`,
    `${d.totalMs.p50 ?? "-"}/${d.totalMs.p90 ?? "-"}/${d.totalMs.p99 ?? "-"}`,
    String(d.cSats), Object.entries(d.errors).map(([k, n]) => `${k}:${n}`).join(" ") || "-",
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cols) => cols.map((c, i) => c.padEnd(w[i])).join("  ");
  return [fmt(head), fmt(w.map((n) => "-".repeat(n))), ...lines.map(fmt)].join("\n");
}

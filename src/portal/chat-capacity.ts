// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * #39: which coordinator a portal chat goes to.
 *
 * The portal used to send every chat to the first coordinator that answered its health check. A
 * coordinator can be healthy and still have nothing to run a chat on (the US seed is
 * coordinator-only: no model of its own), so chat hung or failed while another seed had capacity.
 *
 * Before a chat is sent, each vetted coordinator is asked what it can serve:
 * - GET /health/runtime (public, no credentials): is the coordinator's own model server reachable
 *   and does it hold a model. That is what answers POST /portal/chat.
 * - GET /inference/models (portal service token): the models connected agents can run. That is
 *   what answers a chat on network compute (POST /inference/submit).
 * The coordinator's /capacity route is not used: it takes the mesh token, which the portal does
 * not hold, and it does not cover the coordinator's own model server.
 *
 * The first coordinator in configured order that reports capacity wins. A default chat is never
 * sent to a coordinator without a model of its own: that one would relay it over the mesh, which
 * is the slow path #39 is about. Answers are cached for a short TTL and concurrent chats share one
 * probe, so a chat normally costs no extra round trip.
 * Only URLs that pass the coordinator URL policy (coordinator-url-policy.ts) are probed.
 */

import { request } from "undici";

/**
 * - yes: it reports something to run the chat on.
 * - unknown: it answered without saying (an older build, or the list could not be read).
 * - unlisted: it is up, but its agent list does not show the model. The list leaves out agents not
 *   seen for a few minutes, so the coordinator's own answer to the job is what counts: it is tried
 *   last, and its refusal says exactly what is missing.
 * - no: it cannot serve the chat (unreachable, or no model of its own for a default chat).
 */
export type Capacity = "yes" | "unknown" | "unlisted" | "no";

/** A default chat (the coordinator's own model) or a chat on network compute for one model. */
/**
 * `computeClass` (cpu, apple, gpu, gpu.dc; omitted or "any" = any class): a classed call must go
 * to a coordinator with an agent of that class for the model. Classes are separate markets
 * (compute-classes.ts: own reference price and order book), so gpu.dc does not stand in for gpu.
 */
export type ChatNeed = { kind: "chat" } | { kind: "network"; model: string; computeClass?: string };

/** What one coordinator said when asked. */
export interface CapacityReport {
  /** false: no usable answer in time (connection error, timeout, error status on the health route). */
  reachable: boolean;
  /** kind "chat": models the coordinator's own model server holds; undefined when it did not say. */
  ownModelCount?: number;
  /** kind "network": models connected agents can run; undefined when the list could not be read. */
  agentModels?: string[];
  /** kind "network": per model, idle agents and calls waiting (coordinators that report them). */
  /** agents: holding the model; idle: holding nothing; free: model slots free now (newer coordinators); waiting: calls queued. */
  modelLoad?: Record<string, { agents?: number; idle: number; free?: number; waiting: number }>;
  /** kind "network": per model, the compute classes of the agents holding it (coordinators that report them). */
  modelClasses?: Record<string, string[]>;
}

/** A model the network can run now, across coordinators: agents holding it and their classes. */
export interface NetworkModelSummary {
  model: string;
  agents: number;
  classes: string[];
}

const wantsClass = (need: ChatNeed): string | undefined => (need.kind === "network" && need.computeClass && need.computeClass !== "any" ? need.computeClass : undefined);
/** False when the report says which classes hold the model and `cls` is not among them. */
const classOk = (report: CapacityReport, model: string, cls: string | undefined) => !cls || !report.modelClasses?.[model] || report.modelClasses[model].includes(cls);

export type CapacityProbe = (url: string, kind: ChatNeed["kind"]) => Promise<CapacityReport>;

export function capacityFor(report: CapacityReport, need: ChatNeed): Capacity {
  if (!report.reachable) return "no";
  if (need.kind === "chat") {
    if (report.ownModelCount === undefined) return "unknown";
    return report.ownModelCount > 0 ? "yes" : "no";
  }
  if (report.agentModels === undefined) return "unknown";
  return report.agentModels.includes(need.model) && classOk(report, need.model, wantsClass(need)) ? "yes" : "unlisted";
}

export const CHAT_CAPACITY_DEFAULT_TIMEOUT_MS = 2_000;
export const CHAT_CAPACITY_DEFAULT_TTL_MS = 15_000;
/** Oldest load report a network pick uses (model slots free and calls waiting change in seconds). */
export const LOAD_REPORT_MAX_AGE_MS = 2_000;
/** A "no" older than this is asked again before a chat is refused for lack of compute. */
const RECHECK_NO_AFTER_MS = 3_000;
const CANDIDATE_LIST_TTL_MS = 60_000;

/** PORTAL_CHAT_CAPACITY_TIMEOUT_MS / PORTAL_CHAT_CAPACITY_TTL_MS; the only place they are read. */
export function chatCapacityOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { timeoutMs: number; ttlMs: number } {
  const num = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number((raw ?? "").trim() || NaN);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    timeoutMs: num(env.PORTAL_CHAT_CAPACITY_TIMEOUT_MS, CHAT_CAPACITY_DEFAULT_TIMEOUT_MS, 100, 30_000),
    ttlMs: num(env.PORTAL_CHAT_CAPACITY_TTL_MS, CHAT_CAPACITY_DEFAULT_TTL_MS, 0, 600_000),
  };
}

/** Ask one coordinator over HTTP. Never throws; an unusable answer is `reachable: false`. */
export function httpCapacityProbe(opts: { serviceToken?: string; timeoutMs: number }): CapacityProbe {
  return async (url, kind) => {
    const base = url.replace(/\/+$/, "");
    try {
      if (kind === "chat") {
        // Public route: no credential is attached.
        const res = await request(`${base}/health/runtime`, {
          method: "GET",
          headersTimeout: opts.timeoutMs,
          bodyTimeout: opts.timeoutMs,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          await res.body.dump().catch(() => undefined);
          return { reachable: false };
        }
        const json = (await res.body.json().catch(() => null)) as { ollama?: { reachable?: unknown; modelCount?: unknown } } | null;
        const o = json?.ollama;
        if (!o || typeof o.reachable !== "boolean") return { reachable: true };
        const count = typeof o.modelCount === "number" && Number.isFinite(o.modelCount) ? o.modelCount : 0;
        return { reachable: true, ownModelCount: o.reachable ? count : 0 };
      }
      const res = await request(`${base}/inference/models`, {
        method: "GET",
        headers: opts.serviceToken ? { "x-portal-service-token": opts.serviceToken } : {},
        headersTimeout: opts.timeoutMs,
        bodyTimeout: opts.timeoutMs,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (res.statusCode !== 200) {
        await res.body.dump().catch(() => undefined);
        // It answered, so it is up; a gateway error means the coordinator behind it is not.
        return { reachable: res.statusCode < 502 || res.statusCode > 504 };
      }
      const json = (await res.body.json().catch(() => null)) as { models?: unknown } | null;
      if (!json || !Array.isArray(json.models)) return { reachable: true };
      const agentModels: string[] = [];
      const modelLoad: Record<string, { agents?: number; idle: number; free?: number; waiting: number }> = {};
      const modelClasses: Record<string, string[]> = {};
      const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      for (const m of json.models as Array<{ model?: unknown; agents?: unknown; idleAgents?: unknown; freeSlots?: unknown; waiting?: unknown; classes?: unknown }>) {
        if (m && typeof m.model === "string" && typeof m.agents === "number" && m.agents > 0) {
          agentModels.push(m.model);
          if (Array.isArray(m.classes)) modelClasses[m.model] = m.classes.filter((c): c is string => typeof c === "string");
          if (num(m.idleAgents)) {
            modelLoad[m.model] = { agents: m.agents, idle: m.idleAgents, ...(num(m.freeSlots) ? { free: m.freeSlots } : {}), waiting: num(m.waiting) ? m.waiting : 0 };
          }
        }
      }
      return { reachable: true, agentModels, ...(Object.keys(modelLoad).length ? { modelLoad } : {}), ...(Object.keys(modelClasses).length ? { modelClasses } : {}) };
    } catch {
      return { reachable: false };
    }
  };
}

export interface ChatCapacityOptions {
  /** Known coordinators, the configured primary first. May include URLs the policy refuses. */
  candidates: () => Promise<string[]>;
  /** The coordinator URL policy. A URL it refuses is never probed and never returned. */
  allowed: (url: string) => boolean;
  serviceToken?: string;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
  /** Tests: replaces the HTTP probe. */
  probe?: CapacityProbe;
}

export interface ChatCapacityPick {
  /** The coordinator to send the chat to; null when none can serve it. */
  url: string | null;
  /** How many vetted coordinators there are, whatever their capacity. */
  known: number;
}

export interface ChatCapacityDirectory {
  /** The best coordinator for `need`, leaving out `exclude` (the ones this chat already tried). */
  pick(need: ChatNeed, exclude?: readonly string[]): Promise<ChatCapacityPick>;
  /** A chat sent to `url` failed before it produced anything: prefer the others for a while. */
  markFailed(url: string): void;
  /**
   * Models online agents hold across every reachable coordinator, with the classes they hold them
   * in (what /v1/models may advertise as network/<model>@<class>). Empty when none reports.
   */
  networkModels(): Promise<NetworkModelSummary[]>;
  /**
   * model "auto": the coordinator to ask first (it routes across its peers and may send the call on):
   * the reachable one with the most free model slots over all models, configured order breaking
   * ties; null when none is known.
   */
  pickAuto(): Promise<string | null>;
  /** A vetted coordinator URL (a route_elsewhere answer is followed only to one of these). */
  isKnown(url: string): Promise<boolean>;
}

interface CacheEntry {
  at: number;
  report?: CapacityReport;
  pending?: Promise<CapacityReport>;
}

export function createChatCapacityDirectory(opts: ChatCapacityOptions): ChatCapacityDirectory {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? CHAT_CAPACITY_DEFAULT_TTL_MS;
  const probe = opts.probe ?? httpCapacityProbe({ serviceToken: opts.serviceToken, timeoutMs: opts.timeoutMs ?? CHAT_CAPACITY_DEFAULT_TIMEOUT_MS });
  const cache = new Map<string, CacheEntry>();
  const failedAt = new Map<string, number>();
  let list: { at: number; urls: string[] } | undefined;
  let listPending: Promise<string[]> | undefined;

  const vet = (urls: string[]): string[] => {
    const out: string[] = [];
    for (const raw of urls) {
      const url = String(raw ?? "").trim().replace(/\/+$/, "");
      if (url && opts.allowed(url) && !out.includes(url)) out.push(url);
    }
    return out;
  };

  const refreshList = (): Promise<string[]> => {
    listPending ??= opts
      .candidates()
      .then((urls) => {
        list = { at: now(), urls: vet(urls) };
        return list.urls;
      })
      .finally(() => {
        listPending = undefined;
      });
    return listPending;
  };

  /** The vetted list. Once known it is served from memory and refreshed in the background, so a slow source never delays a chat twice. */
  async function knownUrls(): Promise<string[]> {
    if (!list) return refreshList().catch(() => []);
    if (now() - list.at >= CANDIDATE_LIST_TTL_MS) void refreshList().catch(() => undefined);
    return list.urls;
  }

  /** The coordinator's report, from cache when younger than `maxAgeMs`; concurrent callers share one probe. */
  function reportOf(url: string, kind: ChatNeed["kind"], maxAgeMs: number): Promise<CapacityReport> {
    const key = `${kind}|${url}`;
    const hit = cache.get(key);
    if (hit?.pending) return hit.pending;
    if (hit?.report && now() - hit.at < maxAgeMs) return Promise.resolve(hit.report);
    const pending = probe(url, kind)
      .catch((): CapacityReport => ({ reachable: false }))
      .then((report) => {
        cache.set(key, { at: now(), report });
        return report;
      });
    cache.set(key, { at: hit?.at ?? 0, report: hit?.report, pending });
    return pending;
  }

  const recentlyFailed = (url: string) => {
    const at = failedAt.get(url);
    return at !== undefined && now() - at < Math.max(ttlMs, RECHECK_NO_AFTER_MS);
  };

  /**
   * Calls sent to a coordinator for a model since its report was taken: they occupy agents the
   * report still counts as idle, so a burst inside one cache window spreads instead of piling up.
   */
  const sentSince = new Map<string, { reportAt: number; n: number }>();
  const sentKey = (url: string, model: string) => `${url}|${model}`;
  const sentCount = (url: string, model: string, reportAt: number) => {
    const e = sentSince.get(sentKey(url, model));
    return e && e.reportAt === reportAt ? e.n : 0;
  };
  const noteSent = (url: string, model: string, reportAt: number) => {
    const key = sentKey(url, model);
    const e = sentSince.get(key);
    sentSince.set(key, { reportAt, n: e && e.reportAt === reportAt ? e.n + 1 : 1 });
  };

  /**
   * Network calls: among coordinators that list the model and report their load, the one with the
   * most free agents for it (idle minus waiting minus calls sent since its report); configured order
   * breaks ties. Inference runs where it is submitted, so this is what spreads calls across seeds.
   * Null when no coordinator reports load (older builds): the priority order below decides.
   */
  async function chooseByLoad(urls: string[], model: string, cls: string | undefined, maxAgeMs: number): Promise<string | null> {
    // Load moves in seconds: a report older than LOAD_REPORT_MAX_AGE_MS is fetched again, so calls
    // that already finished are not still counted against a coordinator for the whole cache TTL.
    const reports = await Promise.all(urls.map((u) => reportOf(u, "network", Math.min(maxAgeMs, LOAD_REPORT_MAX_AGE_MS))));
    const scored: Array<{ url: string; free: number; agents: number }> = [];
    for (let i = 0; i < urls.length; i++) {
      const r = reports[i];
      const load = r.modelLoad?.[model];
      if (!r.reachable || !load || recentlyFailed(urls[i]) || !r.agentModels?.includes(model) || !classOk(r, model, cls)) continue;
      const reportAt = cache.get(`network|${urls[i]}`)?.at ?? 0;
      // Free model slots when the coordinator reports them (agents run several calls at once), else idle agents.
      const room = load.free ?? load.idle;
      scored.push({ url: urls[i], free: room - load.waiting - sentCount(urls[i], model, reportAt), agents: Math.max(1, load.agents ?? 1) });
    }
    let best: (typeof scored)[number] | null = null;
    if (scored.some((s) => s.free > 0)) {
      // Room somewhere: the most free slots; a tie goes to the coordinator with more agents.
      for (const s of scored) if (!best || s.free > best.free || (s.free === best.free && s.agents > best.agents)) best = s;
    } else {
      // Everything is busy: share the backlog in proportion to agents, so a 2-agent region does not
      // take as many queued calls as a 7-agent one (equal absolute backlogs would).
      for (const s of scored) if (!best || s.free / s.agents > best.free / best.agents || (s.free / s.agents === best.free / best.agents && s.agents > best.agents)) best = s;
    }
    if (best) noteSent(best.url, model, cache.get(`network|${best.url}`)?.at ?? 0);
    return best?.url ?? null;
  }

  async function choose(urls: string[], need: ChatNeed, maxAgeMs: number): Promise<string | null> {
    if (need.kind === "network") {
      const byLoad = await chooseByLoad(urls, need.model, wantsClass(need), maxAgeMs);
      if (byLoad) return byLoad;
    }
    // Start every probe now so the wait is one timeout at most, then read them in priority order.
    const reports = urls.map((u) => reportOf(u, need.kind, maxAgeMs));
    const lesser: Array<{ url: string; rank: number }> = [];
    for (let i = 0; i < urls.length; i++) {
      const capacity = capacityFor(await reports[i], need);
      if (capacity === "no") continue;
      const failed = recentlyFailed(urls[i]);
      // The first coordinator that says yes wins without waiting for the ones after it.
      if (capacity === "yes" && !failed) return urls[i];
      // Then: did not say, then ones a chat just failed on, then ones whose list lacks the model.
      const rank = capacity === "unlisted" ? 4 : (failed ? 2 : 0) + (capacity === "yes" ? 0 : 1);
      lesser.push({ url: urls[i], rank: rank + (capacity === "unlisted" && failed ? 1 : 0) });
    }
    lesser.sort((a, b) => a.rank - b.rank);
    return lesser[0]?.url ?? null;
  }

  return {
    async pick(need, exclude = []) {
      const all = await knownUrls();
      const skip = new Set(exclude.map((u) => u.replace(/\/+$/, "")));
      const urls = all.filter((u) => !skip.has(u));
      if (urls.length === 0) return { url: null, known: all.length };
      let url = await choose(urls, need, ttlMs);
      // Before refusing a chat for lack of compute, ask again where the "no" is not fresh.
      if (!url && ttlMs > RECHECK_NO_AFTER_MS) url = await choose(urls, need, RECHECK_NO_AFTER_MS);
      return { url, known: all.length };
    },
    markFailed(url) {
      failedAt.set(url.replace(/\/+$/, ""), now());
    },
    async pickAuto() {
      const urls = await knownUrls();
      if (urls.length === 0) return null;
      const reports = await Promise.all(urls.map((u) => reportOf(u, "network", LOAD_REPORT_MAX_AGE_MS)));
      let best: { url: string; room: number } | null = null;
      for (let i = 0; i < urls.length; i++) {
        const r = reports[i];
        if (!r.reachable || recentlyFailed(urls[i]) || !r.agentModels?.length) continue;
        const room = Object.values(r.modelLoad ?? {}).reduce((n, l) => n + (l.free ?? l.idle) - l.waiting, 0);
        if (!best || room > best.room) best = { url: urls[i], room };
      }
      return best?.url ?? urls[0];
    },
    async isKnown(url) {
      return (await knownUrls()).includes(url.trim().replace(/\/+$/, ""));
    },
    async networkModels() {
      const urls = await knownUrls();
      const reports = await Promise.all(urls.map((u) => reportOf(u, "network", ttlMs)));
      const byModel = new Map<string, { agents: number; classes: Set<string> }>();
      for (const r of reports) {
        if (!r.reachable) continue;
        for (const model of r.agentModels ?? []) {
          const e = byModel.get(model) ?? { agents: 0, classes: new Set<string>() };
          e.agents += Math.max(1, r.modelLoad?.[model]?.agents ?? 1);
          for (const c of r.modelClasses?.[model] ?? []) e.classes.add(c);
          byModel.set(model, e);
        }
      }
      return [...byModel.entries()].map(([model, e]) => ({ model, agents: e.agents, classes: [...e.classes].sort() })).sort((a, b) => b.agents - a.agents || a.model.localeCompare(b.model));
    },
  };
}

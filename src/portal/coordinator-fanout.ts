// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Website lookups that depend on live machines ask every coordinator, not only the first.
 *
 * Each coordinator keeps its own connected machines in memory (a machine is linked to one at a
 * time), so a list read from one coordinator misses the machines on the others, and the lookup
 * fails outright while that one restarts. These helpers ask all of them (bounded concurrency, a
 * timeout per coordinator, a coordinator that fails is left out) and merge the answers. Lookups of
 * shared database state (balances, prices, reserves) still ask one, falling over to the next.
 */
import { coordinatorRequest } from "./coordinator-request.js";
import { drainRetryWaitMs } from "../apps/ide/network-inference.js";

/** At most this many coordinators are asked per lookup. */
export const MAX_COORDINATORS_ASKED = 8;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 5_000;

const norm = (u: string) => u.trim().replace(/\/+$/, "");

/**
 * Every allowlisted coordinator, the preferred one first: `preferred` (the healthy pick) leads, then
 * everything `all` lists; deduplicated and bounded. A source that fails is skipped.
 */
export function everyCoordinator(preferred: () => Promise<string[]>, all: () => Promise<string[]>): () => Promise<string[]> {
  return async () => {
    const [a, b] = await Promise.all([preferred().catch(() => [] as string[]), all().catch(() => [] as string[])]);
    return [...new Set([...a, ...b].map(norm).filter(Boolean))].slice(0, MAX_COORDINATORS_ASKED);
  };
}

export type CoordinatorAnswer<T> = { url: string; ok: true; value: T } | { url: string; ok: false; error: string };

/** Ask each coordinator (at most `concurrency` at once, each bounded by `timeoutMs`); answers in the order of `urls`. */
export async function askEveryCoordinator<T>(
  urls: string[],
  ask: (base: string, signal: AbortSignal) => Promise<T>,
  opts: { concurrency?: number; timeoutMs?: number } = {}
): Promise<Array<CoordinatorAnswer<T>>> {
  const list = [...new Set(urls.map(norm).filter(Boolean))].slice(0, MAX_COORDINATORS_ASKED);
  const out: Array<CoordinatorAnswer<T>> = new Array(list.length);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const url = list[i];
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          ask(url, ac.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              ac.abort();
              reject(new Error("timeout"));
            }, timeoutMs);
          })
        ]);
        out[i] = { url, ok: true, value };
      } catch (err) {
        out[i] = { url, ok: false, error: String((err as Error)?.message ?? err) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, list.length) }, worker));
  return out;
}

/** Ask coordinators one after another until one gives an accepted answer (shared database state). */
export async function firstCoordinatorAnswer<T>(
  urls: string[],
  ask: (base: string, signal: AbortSignal) => Promise<T>,
  accept: (value: T) => boolean = (v) => v !== null && v !== undefined,
  opts: { timeoutMs?: number } = {}
): Promise<{ url: string; value: T } | null> {
  for (const url of [...new Set(urls.map(norm).filter(Boolean))].slice(0, MAX_COORDINATORS_ASKED)) {
    const [answer] = await askEveryCoordinator([url], ask, { concurrency: 1, timeoutMs: opts.timeoutMs });
    if (answer?.ok && accept(answer.value)) return { url, value: answer.value };
  }
  return null;
}

/** A coordinator's 503 body: the wait before asking again when it is restarting (coordinator_draining), else null. */
export function drainingAnswer(text: string): number | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return json && json.error === "coordinator_draining" ? drainRetryWaitMs(json) : null;
  } catch {
    return null;
  }
}

// ── Merging ──

type ModelRow = Record<string, unknown> & { model: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const add = (a: unknown, b: unknown) => (num(a) === undefined && num(b) === undefined ? undefined : (num(a) ?? 0) + (num(b) ?? 0));

/**
 * GET /inference/models from several coordinators, as one list. A machine is live on one
 * coordinator at a time, so per-model counts (agents, idle, free slots, per class) add up; classes
 * are the union; the context window is the smallest any machine serves (what a caller can count
 * on); other fields come from the first coordinator that listed the model. The per-class `classes`
 * map keeps the first coordinator's prices and adds up its machine counts.
 */
export function mergeInferenceModels(answers: Array<{ models?: unknown; classes?: unknown }>): { models: ModelRow[]; classes: Record<string, Record<string, unknown>> } {
  const byModel = new Map<string, ModelRow>();
  const classes: Record<string, Record<string, unknown>> = {};
  for (const a of answers) {
    for (const raw of Array.isArray(a.models) ? a.models : []) {
      const m = raw as ModelRow;
      if (!m || typeof m.model !== "string") continue;
      const prev = byModel.get(m.model);
      if (!prev) {
        byModel.set(m.model, { ...m, ...(Array.isArray(m.classes) ? { classes: [...m.classes] } : {}) });
        continue;
      }
      for (const k of ["agents", "idleAgents", "freeSlots", "waiting"]) {
        const v = add(prev[k], m[k]);
        if (v !== undefined) prev[k] = v;
      }
      if (Array.isArray(m.classes)) prev.classes = [...new Set([...((prev.classes as unknown[]) ?? []), ...m.classes])];
      if (m.agentsByClass && typeof m.agentsByClass === "object") {
        const merged = { ...((prev.agentsByClass as Record<string, number>) ?? {}) };
        for (const [c, n] of Object.entries(m.agentsByClass as Record<string, unknown>)) merged[c] = (merged[c] ?? 0) + (num(n) ?? 0);
        prev.agentsByClass = merged;
      }
      const ctx = [num(prev.contextWindow), num(m.contextWindow)].filter((n): n is number => n !== undefined);
      if (ctx.length) prev.contextWindow = Math.min(...ctx);
    }
    if (a.classes && typeof a.classes === "object") {
      for (const [c, info] of Object.entries(a.classes as Record<string, Record<string, unknown>>)) {
        if (!info || typeof info !== "object") continue;
        if (!classes[c]) classes[c] = { ...info };
        else {
          const v = add(classes[c].agents, info.agents);
          if (v !== undefined) classes[c].agents = v;
        }
      }
    }
  }
  return { models: [...byModel.values()], classes };
}

/** A coordinator's own chat models (GET /portal/models `local`), deduplicated by name (running anywhere counts). */
export function mergeLocalModels<T extends { name: string; running?: boolean }>(lists: T[][]): T[] {
  const byName = new Map<string, T>();
  for (const list of lists) {
    for (const m of list) {
      if (!m || typeof m.name !== "string") continue;
      const prev = byName.get(m.name);
      if (!prev) byName.set(m.name, { ...m });
      else if (m.running && !prev.running) byName.set(m.name, { ...prev, running: true });
    }
  }
  return [...byName.values()];
}

/** GET a JSON document from one coordinator as the portal (service token; `account`: whose view it is). */
export async function getCoordinatorJson(base: string, path: string, opts: { serviceToken?: string; account?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>> {
  const res = await coordinatorRequest(`${norm(base)}${path}`, {
    method: "GET",
    headers: { ...(opts.serviceToken ? { "x-portal-service-token": opts.serviceToken } : {}), ...(opts.account ? { "x-edgecoder-account": opts.account } : {}) },
    headersTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bodyTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal
  });
  if (res.statusCode !== 200) {
    await res.body.dump().catch(() => undefined);
    throw new Error(`HTTP ${res.statusCode}`);
  }
  return (await res.body.json()) as Record<string, unknown>;
}

/**
 * The network's models as one account sees them, from every coordinator, merged (the shape of
 * GET /inference/models). status 200 when at least one coordinator answered, else 0.
 */
export async function networkModelsFromEvery(
  urls: string[],
  opts: { serviceToken?: string; account: string; timeoutMs?: number }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const answers = await askEveryCoordinator(urls, (base, signal) => getCoordinatorJson(base, "/inference/models", { ...opts, signal }), { timeoutMs: opts.timeoutMs ?? 8_000 });
  const ok = answers.filter((a): a is { url: string; ok: true; value: Record<string, unknown> } => a.ok);
  if (!ok.length) return { status: 0, json: {} };
  return { status: 200, json: { ...mergeInferenceModels(ok.map((a) => a.value)), coordinators: ok.length } };
}

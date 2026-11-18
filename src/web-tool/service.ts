// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The web tool on the coordinator (POST /v1/tools/web/search, /read, /status): who may use it, what
 * it costs, and how often. Each search and each page read is debited from the caller's account in
 * the existing ledger (reason `tool:web_search` / `tool:read_page`) before the call goes out, and
 * refunded in full (`tool:web_search_refund` / `tool:read_page_refund`) when it fails, so a failed
 * call costs nothing and the ledger always balances: balance before − balance after = the cSats of
 * the calls that returned something.
 *
 * Limits per account (sliding hour, per coordinator): WEB_SEARCH_PER_HOUR searches and
 * WEB_READ_PER_HOUR page reads. Without BRAVE_SEARCH_API_KEY the whole tool is off ("Web search
 * isn't set up yet"), page reads included, so the app hides or disables its Web toggle.
 *
 * Free on your own machine: a call made for a chat whose model runs on the account's own machine
 * (the route decides that basis; a client can't claim it, see routes/web-tools.ts) costs nothing and
 * needs no balance, up to WEB_FREE_OWN_MACHINE_SEARCHES_PER_DAY searches and
 * WEB_FREE_OWN_MACHINE_READS_PER_DAY page reads per account per UTC day, and WEB_FREE_GLOBAL_PER_DAY
 * free calls in all (a cost circuit-breaker), per coordinator. Free calls still count toward the
 * hour's limits. Past a daily cap the call is paid as usual (cSats when the balance allows, else
 * needs_csats). Free calls move no cSats; they are counted (recordFree) for ops visibility only.
 *
 * Searched on your own machine (local-web.ts): with the same own-machine basis, a search goes first
 * to the account's own machine's SearXNG, and a page read to that machine, when one reported it can
 * (deps.local). Its answer costs nothing, counts toward no daily cap (it cost EdgeCoder nothing) and
 * works without BRAVE_SEARCH_API_KEY; LOCAL_WEB_PER_HOUR bounds the relaying. When the machine has
 * nothing (none, down, late, no results), the call takes the path above as if it hadn't been asked.
 */

import { SEARCH_MAX_COUNT, braveSearch, cleanResults, type SearchResult } from "./brave.js";
import { fetchPage, PageFetchError, type FetchedPage } from "./fetch-page.js";
import type { LocalWebCapability } from "./local-web.js";

export const NOT_CONFIGURED_MESSAGE = "Web search isn't set up yet";

export interface WebToolConfig {
  braveApiKey?: string;
  searchCSats: number;
  readCSats: number;
  searchesPerHour: number;
  readsPerHour: number;
  /** Free calls for chats on the account's own machine, per account per UTC day (then paid). */
  freeSearchesPerDay: number;
  freeReadsPerDay: number;
  /** Free calls in all (every account, searches and reads) per UTC day on this coordinator. */
  freeGlobalPerDay: number;
}

/**
 * Defaults: 0.5 cSats a search, 0.2 a page, 60 searches and 120 reads an hour per account; on your
 * own machine 100 searches and 200 page reads a day free, 5000 free calls a day in all.
 */
export const WEB_TOOL_DEFAULTS = { searchCSats: 0.5, readCSats: 0.2, searchesPerHour: 60, readsPerHour: 120, freeSearchesPerDay: 100, freeReadsPerDay: 200, freeGlobalPerDay: 5000 } as const;

/** Why a call may be free: the chat's model runs on the account's own machine (decided by the route, never by a client). */
export interface WebCallBasis {
  ownMachine?: boolean;
  /** The calling agent (a signed agent caller): its own machine is asked first for local web. */
  agentId?: string;
}

/** Calls relayed to the account's own machines per account per hour (searches and reads together). */
export const LOCAL_WEB_PER_HOUR = 600;

/** The account's own machines (src/swarm/coordinator/local-web.ts); null: nothing from them. */
export interface LocalWebBackend {
  available: (accountId: string, preferAgentId?: string) => Promise<LocalWebCapability>;
  search: (accountId: string, query: string, count: number, preferAgentId?: string) => Promise<SearchResult[] | null>;
  read: (accountId: string, url: string, preferAgentId?: string) => Promise<FetchedPage | null>;
}

/** An account's free calls today (after a free call; for the usage record). */
export interface FreeWebCount {
  day: string;
  searches: number;
  reads: number;
}

export interface WebToolDeps {
  /** Take cSats from the account; throws an Error whose message starts "insufficient_credits" when short. */
  debit: (accountId: string, cSats: number, reason: string, idempotencyKey: string) => Promise<void>;
  /** Give a debit back (idempotent on the key). */
  refund: (accountId: string, cSats: number, reason: string, idempotencyKey: string) => Promise<void>;
  balance: (accountId: string) => Promise<number>;
  /** A free call ran (own machine): the account's free totals today. No cSats move. */
  recordFree?: (accountId: string, count: FreeWebCount) => void | Promise<void>;
  search?: (query: string, count: number) => Promise<SearchResult[]>;
  read?: (url: string) => Promise<FetchedPage>;
  /** Searches and page reads on the account's own machine (own-machine basis only). */
  local?: LocalWebBackend;
  now?: () => number;
}

export type WebToolResult<T> = { ok: true; value: T; cSats: number; free?: true; local?: true } | { ok: false; status: number; error: string; message: string };

/** Per-account sliding-window counter. */
export class HourlyLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs = 3_600_000) {}
  /** Count a use when under the limit; returns false (and counts nothing) when over it. */
  take(key: string, now: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  /** Give back the last use (a call refused before it ran). */
  untake(key: string): void {
    this.hits.get(key)?.pop();
  }
  remaining(key: string, now: number): number {
    return Math.max(0, this.limit - (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length);
  }
  /** Seconds until the oldest use in the window expires. */
  retryAfterSec(key: string, now: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    return list.length ? Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)) : 0;
  }
}

/** Counts per key for the current UTC day; starts over at midnight UTC. */
export class DailyCounter {
  private day = "";
  private counts = new Map<string, number>();
  static dayOf(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }
  private roll(now: number): void {
    const d = DailyCounter.dayOf(now);
    if (d !== this.day) {
      this.day = d;
      this.counts.clear();
    }
  }
  used(key: string, now: number): number {
    this.roll(now);
    return this.counts.get(key) ?? 0;
  }
  /** Count one when under `limit`; false (and nothing counted) at it. */
  take(key: string, limit: number, now: number): boolean {
    const n = this.used(key, now);
    if (n >= limit) return false;
    this.counts.set(key, n + 1);
    return true;
  }
  untake(key: string, now: number): void {
    const n = this.used(key, now);
    if (n > 0) this.counts.set(key, n - 1);
  }
}

const GLOBAL_FREE = "*";

export class WebToolService {
  private readonly searches: HourlyLimiter;
  private readonly reads: HourlyLimiter;
  private readonly free = new DailyCounter();
  private readonly localCalls = new HourlyLimiter(LOCAL_WEB_PER_HOUR);
  private readonly now: () => number;

  constructor(private readonly config: WebToolConfig, private readonly deps: WebToolDeps) {
    this.searches = new HourlyLimiter(config.searchesPerHour);
    this.reads = new HourlyLimiter(config.readsPerHour);
    this.now = deps.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.config.braveApiKey?.trim();
  }

  /** Free calls left today for an account on its own machine (its own cap and the global one). */
  freeLeft(accountId: string, now = this.now()): { searches: number; reads: number } {
    const global = Math.max(0, this.config.freeGlobalPerDay - this.free.used(GLOBAL_FREE, now));
    return {
      searches: Math.min(global, Math.max(0, this.config.freeSearchesPerDay - this.free.used(`s:${accountId}`, now))),
      reads: Math.min(global, Math.max(0, this.config.freeReadsPerDay - this.free.used(`r:${accountId}`, now))),
    };
  }

  /**
   * What the app needs for its toggle: set up or not, prices, the balance and the hour's room. With
   * the own-machine basis, `free` says the next search costs nothing (and so needs no cSats), with
   * the free calls left today.
   */
  async status(accountId: string, basis: WebCallBasis = {}) {
    const now = this.now();
    const balance = await this.deps.balance(accountId).catch(() => null);
    const left = basis.ownMachine ? this.freeLeft(accountId, now) : null;
    // Searched on your own machine: free with no daily cap (the caps below are the fallback's).
    const local = basis.ownMachine && this.deps.local ? await this.deps.local.available(accountId, basis.agentId).catch(() => null) : null;
    const localSearch = !!local?.search && this.localCalls.remaining(accountId, now) > 0;
    const free = localSearch || (!!left && left.searches > 0);
    const configured = this.configured || localSearch;
    return {
      configured,
      ...(configured ? {} : { message: NOT_CONFIGURED_MESSAGE }),
      searchCSats: this.config.searchCSats,
      readCSats: this.config.readCSats,
      balanceCSats: balance,
      // Enough for one search (or it's free): the toggle says "needs cSats" otherwise.
      canAfford: free || balance === null ? true : balance >= this.config.searchCSats,
      free,
      ...(left ? { freeSearchesLeftToday: left.searches, freeReadsLeftToday: left.reads } : {}),
      // No daily cap while your machine answers; the counts above apply only when it doesn't.
      ...(localSearch ? { localSearch: true, localRead: local?.read === true } : {}),
      searchesLeftThisHour: this.searches.remaining(accountId, now),
      readsLeftThisHour: this.reads.remaining(accountId, now),
    };
  }

  async search(accountId: string, query: string, count: number, requestId: string, basis: WebCallBasis = {}): Promise<WebToolResult<{ query: string; results: SearchResult[] }>> {
    const q = query.trim();
    if (!q) return { ok: false, status: 400, error: "invalid_query", message: "The search needs a query." };
    if (q.length > 400) return { ok: false, status: 400, error: "invalid_query", message: "The query is too long (400 characters at most)." };
    const n = Math.max(1, Math.min(SEARCH_MAX_COUNT, Math.floor(count) || 5));
    // Untrusted like Brave's (the host's word): cleaned here too; nothing found counts as no answer.
    const local = await this.onOwnMachine(accountId, basis, async (l) => {
      const found = cleanResults((await l.search(accountId, q, n, basis.agentId)) ?? [], n);
      return found.length ? found : null;
    });
    if (local) return { ok: true, value: { query: q, results: local }, cSats: 0, free: true, local: true };
    return this.charged(accountId, "web_search", this.searches, this.config.searchCSats, requestId, basis, async () => {
      const run = this.deps.search ?? ((qq: string, nn: number) => braveSearch(qq, nn, { apiKey: this.config.braveApiKey! }));
      return { query: q, results: await run(q, n) };
    });
  }

  async read(accountId: string, url: string, requestId: string, basis: WebCallBasis = {}): Promise<WebToolResult<FetchedPage>> {
    if (!url.trim()) return { ok: false, status: 400, error: "invalid_url", message: "read_page needs a URL." };
    const local = await this.onOwnMachine(accountId, basis, (l) => l.read(accountId, url.trim(), basis.agentId));
    if (local) return { ok: true, value: local, cSats: 0, free: true, local: true };
    return this.charged(accountId, "read_page", this.reads, this.config.readCSats, requestId, basis, () => (this.deps.read ?? ((u: string) => fetchPage(u)))(url));
  }

  /**
   * The account's own machine answers (own-machine basis only): its value, or null to take the
   * usual path. Counts toward LOCAL_WEB_PER_HOUR only when it answered.
   */
  private async onOwnMachine<T>(accountId: string, basis: WebCallBasis, run: (l: LocalWebBackend) => Promise<T | null>): Promise<T | null> {
    const l = this.deps.local;
    if (!basis.ownMachine || !l) return null;
    const now = this.now();
    if (!this.localCalls.take(accountId, now)) return null;
    const value = await run(l).catch(() => null);
    if (value === null || value === undefined) this.localCalls.untake(accountId);
    return value ?? null;
  }

  /** One of today's free calls for the account, when its cap and the global cap both have room. */
  private takeFree(accountId: string, tool: "web_search" | "read_page", now: number): boolean {
    const key = `${tool === "web_search" ? "s" : "r"}:${accountId}`;
    const cap = tool === "web_search" ? this.config.freeSearchesPerDay : this.config.freeReadsPerDay;
    if (!this.free.take(key, cap, now)) return false;
    if (this.free.take(GLOBAL_FREE, this.config.freeGlobalPerDay, now)) return true;
    this.free.untake(key, now);
    return false;
  }

  private untakeFree(accountId: string, tool: "web_search" | "read_page", now: number): void {
    this.free.untake(`${tool === "web_search" ? "s" : "r"}:${accountId}`, now);
    this.free.untake(GLOBAL_FREE, now);
  }

  /** Limit, then free (own machine, under today's caps) or debit; run, and refund or give the free call back when the run fails. */
  private async charged<T>(accountId: string, tool: "web_search" | "read_page", limiter: HourlyLimiter, price: number, requestId: string, basis: WebCallBasis, run: () => Promise<T>): Promise<WebToolResult<T>> {
    if (!this.configured) return { ok: false, status: 503, error: "web_search_not_configured", message: NOT_CONFIGURED_MESSAGE };
    const now = this.now();
    if (!limiter.take(accountId, now)) {
      const per = tool === "web_search" ? `${this.config.searchesPerHour} searches` : `${this.config.readsPerHour} page reads`;
      return { ok: false, status: 429, error: "rate_limited", message: `The web tool's limit is ${per} an hour; try again in ${Math.ceil(limiter.retryAfterSec(accountId, now) / 60)} min.` };
    }
    if (basis.ownMachine && this.takeFree(accountId, tool, now)) {
      try {
        const value = await run();
        const day = DailyCounter.dayOf(now);
        await Promise.resolve(this.deps.recordFree?.(accountId, { day, searches: this.free.used(`s:${accountId}`, now), reads: this.free.used(`r:${accountId}`, now) })).catch(() => {});
        return { ok: true, value, cSats: 0, free: true };
      } catch (err) {
        this.untakeFree(accountId, tool, now);
        return runFailure(err);
      }
    }
    const key = `tool:${tool}:${accountId}:${requestId}`;
    if (price > 0) {
      try {
        await this.deps.debit(accountId, price, `tool:${tool}`, key);
      } catch (err) {
        limiter.untake(accountId);
        const msg = (err as Error).message ?? "";
        if (msg.startsWith("insufficient_credits")) return { ok: false, status: 402, error: "needs_csats", message: `The web tool needs cSats (${price} a ${tool === "web_search" ? "search" : "page"}); top up to use it.` };
        if (msg.startsWith("duplicate_debit")) return { ok: false, status: 409, error: "duplicate_request", message: "This request was already made." };
        return { ok: false, status: 500, error: "debit_failed", message: "Couldn't charge for the web tool right now." };
      }
    }
    try {
      const value = await run();
      return { ok: true, value, cSats: price };
    } catch (err) {
      if (price > 0) await this.deps.refund(accountId, price, `tool:${tool}_refund`, `refund:${key}`).catch(() => {});
      return runFailure(err);
    }
  }
}

/** A search or page read that threw, as the answer the caller gets. */
function runFailure(err: unknown): { ok: false; status: number; error: string; message: string } {
  if (err instanceof PageFetchError) return { ok: false, status: err.code === "blocked_url" || err.code === "unsupported_type" || err.code === "too_large" ? 422 : 502, error: err.code, message: err.message };
  const status = (err as { status?: number }).status;
  return { ok: false, status: 502, error: "search_failed", message: status === 429 ? "The search service is busy; try again shortly." : (err as Error).message || "The web call failed." };
}

export function webToolConfigFromEnv(env: {
  BRAVE_SEARCH_API_KEY?: string;
  WEB_SEARCH_CSATS?: number;
  WEB_READ_CSATS?: number;
  WEB_SEARCH_PER_HOUR?: number;
  WEB_READ_PER_HOUR?: number;
  WEB_FREE_OWN_MACHINE_SEARCHES_PER_DAY?: number;
  WEB_FREE_OWN_MACHINE_READS_PER_DAY?: number;
  WEB_FREE_GLOBAL_PER_DAY?: number;
}): WebToolConfig {
  return {
    braveApiKey: env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
    searchCSats: env.WEB_SEARCH_CSATS ?? WEB_TOOL_DEFAULTS.searchCSats,
    readCSats: env.WEB_READ_CSATS ?? WEB_TOOL_DEFAULTS.readCSats,
    searchesPerHour: env.WEB_SEARCH_PER_HOUR ?? WEB_TOOL_DEFAULTS.searchesPerHour,
    readsPerHour: env.WEB_READ_PER_HOUR ?? WEB_TOOL_DEFAULTS.readsPerHour,
    freeSearchesPerDay: env.WEB_FREE_OWN_MACHINE_SEARCHES_PER_DAY ?? WEB_TOOL_DEFAULTS.freeSearchesPerDay,
    freeReadsPerDay: env.WEB_FREE_OWN_MACHINE_READS_PER_DAY ?? WEB_TOOL_DEFAULTS.freeReadsPerDay,
    freeGlobalPerDay: env.WEB_FREE_GLOBAL_PER_DAY ?? WEB_TOOL_DEFAULTS.freeGlobalPerDay,
  };
}

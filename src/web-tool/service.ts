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
 */

import { SEARCH_MAX_COUNT, braveSearch, type SearchResult } from "./brave.js";
import { fetchPage, PageFetchError, type FetchedPage } from "./fetch-page.js";

export const NOT_CONFIGURED_MESSAGE = "Web search isn't set up yet";

export interface WebToolConfig {
  braveApiKey?: string;
  searchCSats: number;
  readCSats: number;
  searchesPerHour: number;
  readsPerHour: number;
}

/** Defaults: 0.5 cSats a search, 0.2 a page, 60 searches and 120 reads an hour per account. */
export const WEB_TOOL_DEFAULTS = { searchCSats: 0.5, readCSats: 0.2, searchesPerHour: 60, readsPerHour: 120 } as const;

export interface WebToolDeps {
  /** Take cSats from the account; throws an Error whose message starts "insufficient_credits" when short. */
  debit: (accountId: string, cSats: number, reason: string, idempotencyKey: string) => Promise<void>;
  /** Give a debit back (idempotent on the key). */
  refund: (accountId: string, cSats: number, reason: string, idempotencyKey: string) => Promise<void>;
  balance: (accountId: string) => Promise<number>;
  search?: (query: string, count: number) => Promise<SearchResult[]>;
  read?: (url: string) => Promise<FetchedPage>;
  now?: () => number;
}

export type WebToolResult<T> = { ok: true; value: T; cSats: number } | { ok: false; status: number; error: string; message: string };

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

export class WebToolService {
  private readonly searches: HourlyLimiter;
  private readonly reads: HourlyLimiter;
  private readonly now: () => number;

  constructor(private readonly config: WebToolConfig, private readonly deps: WebToolDeps) {
    this.searches = new HourlyLimiter(config.searchesPerHour);
    this.reads = new HourlyLimiter(config.readsPerHour);
    this.now = deps.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.config.braveApiKey?.trim();
  }

  /** What the app needs for its toggle: set up or not, prices, the balance and the hour's room. */
  async status(accountId: string) {
    const now = this.now();
    const balance = await this.deps.balance(accountId).catch(() => null);
    return {
      configured: this.configured,
      ...(this.configured ? {} : { message: NOT_CONFIGURED_MESSAGE }),
      searchCSats: this.config.searchCSats,
      readCSats: this.config.readCSats,
      balanceCSats: balance,
      // Enough for one search: the toggle says "needs cSats" otherwise.
      canAfford: balance === null ? true : balance >= this.config.searchCSats,
      searchesLeftThisHour: this.searches.remaining(accountId, now),
      readsLeftThisHour: this.reads.remaining(accountId, now),
    };
  }

  async search(accountId: string, query: string, count: number, requestId: string): Promise<WebToolResult<{ query: string; results: SearchResult[] }>> {
    const q = query.trim();
    if (!q) return { ok: false, status: 400, error: "invalid_query", message: "The search needs a query." };
    if (q.length > 400) return { ok: false, status: 400, error: "invalid_query", message: "The query is too long (400 characters at most)." };
    const n = Math.max(1, Math.min(SEARCH_MAX_COUNT, Math.floor(count) || 5));
    return this.charged(accountId, "web_search", this.searches, this.config.searchCSats, requestId, async () => {
      const run = this.deps.search ?? ((qq: string, nn: number) => braveSearch(qq, nn, { apiKey: this.config.braveApiKey! }));
      return { query: q, results: await run(q, n) };
    });
  }

  async read(accountId: string, url: string, requestId: string): Promise<WebToolResult<FetchedPage>> {
    if (!url.trim()) return { ok: false, status: 400, error: "invalid_url", message: "read_page needs a URL." };
    return this.charged(accountId, "read_page", this.reads, this.config.readCSats, requestId, () => (this.deps.read ?? ((u: string) => fetchPage(u)))(url));
  }

  /** Limit, debit, run, and refund when the run fails. */
  private async charged<T>(accountId: string, tool: "web_search" | "read_page", limiter: HourlyLimiter, price: number, requestId: string, run: () => Promise<T>): Promise<WebToolResult<T>> {
    if (!this.configured) return { ok: false, status: 503, error: "web_search_not_configured", message: NOT_CONFIGURED_MESSAGE };
    const now = this.now();
    if (!limiter.take(accountId, now)) {
      const per = tool === "web_search" ? `${this.config.searchesPerHour} searches` : `${this.config.readsPerHour} page reads`;
      return { ok: false, status: 429, error: "rate_limited", message: `The web tool's limit is ${per} an hour; try again in ${Math.ceil(limiter.retryAfterSec(accountId, now) / 60)} min.` };
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
      if (err instanceof PageFetchError) return { ok: false, status: err.code === "blocked_url" || err.code === "unsupported_type" || err.code === "too_large" ? 422 : 502, error: err.code, message: err.message };
      const status = (err as { status?: number }).status;
      return { ok: false, status: 502, error: "search_failed", message: status === 429 ? "The search service is busy; try again shortly." : (err as Error).message || "The web call failed." };
    }
  }
}

export function webToolConfigFromEnv(env: { BRAVE_SEARCH_API_KEY?: string; WEB_SEARCH_CSATS?: number; WEB_READ_CSATS?: number; WEB_SEARCH_PER_HOUR?: number; WEB_READ_PER_HOUR?: number }): WebToolConfig {
  return {
    braveApiKey: env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
    searchCSats: env.WEB_SEARCH_CSATS ?? WEB_TOOL_DEFAULTS.searchCSats,
    readCSats: env.WEB_READ_CSATS ?? WEB_TOOL_DEFAULTS.readCSats,
    searchesPerHour: env.WEB_SEARCH_PER_HOUR ?? WEB_TOOL_DEFAULTS.searchesPerHour,
    readsPerHour: env.WEB_READ_PER_HOUR ?? WEB_TOOL_DEFAULTS.readsPerHour,
  };
}

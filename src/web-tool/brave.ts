// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * web_search's backend: the Brave Search API (https://api.search.brave.com). The key is a server
 * secret (BRAVE_SEARCH_API_KEY on the coordinator); it never leaves EdgeCoder's servers.
 */

import { decodeEntities } from "./extract.js";
import { WEB_TOOL_USER_AGENT } from "./fetch-page.js";

export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
/** Results a search may ask for. */
export const SEARCH_MAX_COUNT = 8;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class SearchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const plain = (s: unknown) => decodeEntities(String(s ?? "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** Search the web; up to `count` (1–8) results with title, URL and snippet. */
export async function braveSearch(query: string, count: number, opts: { apiKey: string; fetch?: FetchFn; timeoutMs?: number }): Promise<SearchResult[]> {
  const n = Math.max(1, Math.min(SEARCH_MAX_COUNT, Math.floor(count) || 5));
  const url = `${BRAVE_SEARCH_URL}?${new URLSearchParams({ q: query, count: String(n), safesearch: "moderate", text_decorations: "false" })}`;
  const f: FetchFn = opts.fetch ?? (fetch as unknown as FetchFn);
  const res = await f(url, {
    method: "GET",
    headers: { accept: "application/json", "x-subscription-token": opts.apiKey, "user-agent": WEB_TOOL_USER_AGENT },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new SearchError(res.status === 429 ? "The search service is busy; try again shortly." : `The search service answered HTTP ${res.status}.`, res.status);
  const body = (await res.json()) as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
  const out: SearchResult[] = [];
  for (const r of body.web?.results ?? []) {
    const link = String(r.url ?? "");
    if (!/^https?:\/\//i.test(link)) continue;
    out.push({ title: plain(r.title).slice(0, 300) || link, url: link, snippet: plain(r.description).slice(0, 600) });
    if (out.length >= n) break;
  }
  return out;
}

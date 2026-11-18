// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * web_search on a host's own SearXNG (docs/web-tool.md, "Searches on your own machine"). The
 * installer runs SearXNG on Linux hosts, bound to 127.0.0.1 (src/install/searxng.ts), and points
 * the agent at it with SEARXNG_URL. The agent asks it when its coordinator sends a signed local_web
 * frame for its owner's chat (local-web.ts); nothing here is reachable from outside the machine.
 *
 * SearXNG's answer is untrusted exactly like Brave's: the same cleanResults (plain text, capped,
 * http(s) only, at most 8), here on the agent and again on the coordinator.
 */

import { SearchError, cleanResults, type FetchFn, type SearchResult } from "./brave.js";
import { WEB_TOOL_USER_AGENT } from "./fetch-page.js";

/** The port the installer gives SearXNG (127.0.0.1 only). */
export const SEARXNG_DEFAULT_PORT = 18888;
export const SEARXNG_DEFAULT_URL = `http://127.0.0.1:${SEARXNG_DEFAULT_PORT}`;
/** SearXNG asks several engines at once; its own per-engine timeouts are 3 to 6 s (settings.yml). */
export const SEARXNG_TIMEOUT_MS = 8_000;
/** A SearXNG answer larger than this is not read (a normal page of results is ~20-60 KB). */
export const SEARXNG_MAX_BYTES = 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * SEARXNG_URL as a base URL, or null when unset or not on this machine: only plain http to a
 * loopback address, so a mistyped setting can't send the owner's searches anywhere else.
 */
export function searxngBaseUrl(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v || /^(off|0|false|no)$/i.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || !LOOPBACK_HOSTS.has(u.hostname) || u.username || u.password) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** SearXNG's JSON (format=json) as cleaned results: `content` is its snippet. */
export function parseSearxngResults(body: unknown, n: number): SearchResult[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return cleanResults(
    results.map((r: { title?: unknown; url?: unknown; content?: unknown }) => ({ title: r?.title, url: r?.url, snippet: r?.content })),
    n,
  );
}

export interface SearxngFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}
export type SearxngFetch = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<SearxngFetchResponse>;

/** One search on the local SearXNG; up to `count` (1–8) cleaned results. Throws SearchError when it fails. */
export async function searxngSearch(baseUrl: string, query: string, count: number, opts: { fetch?: SearxngFetch; timeoutMs?: number } = {}): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 400);
  if (!q) return [];
  const url = `${baseUrl}/search?${new URLSearchParams({ q, format: "json", safesearch: "1", pageno: "1" })}`;
  const f: SearxngFetch = opts.fetch ?? (fetch as unknown as SearxngFetch);
  let res: SearxngFetchResponse;
  try {
    res = await f(url, { method: "GET", headers: { accept: "application/json", "user-agent": WEB_TOOL_USER_AGENT }, signal: AbortSignal.timeout(opts.timeoutMs ?? SEARXNG_TIMEOUT_MS) });
  } catch (err) {
    throw new SearchError(`Local search unreachable: ${(err as Error).message ?? err}`.slice(0, 200), 502);
  }
  if (!res.ok) throw new SearchError(`Local search answered HTTP ${res.status}.`, res.status);
  const text = await res.text();
  if (text.length > SEARXNG_MAX_BYTES) throw new SearchError("Local search answered too much.", 502);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // format=json not enabled (an HTML page or a 403 from a hand-made settings.yml).
    throw new SearchError("Local search did not answer JSON.", 502);
  }
  return parseSearxngResults(body, count);
}

/** SearXNG's /healthz answers 200 when it is up. */
export async function searxngHealthy(baseUrl: string, opts: { fetch?: SearxngFetch; timeoutMs?: number } = {}): Promise<boolean> {
  const f: SearxngFetch = opts.fetch ?? (fetch as unknown as SearxngFetch);
  try {
    const res = await f(`${baseUrl}/healthz`, { method: "GET", headers: { "user-agent": WEB_TOOL_USER_AGENT }, signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export type { FetchFn };

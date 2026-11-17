// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * read_page's fetch, run on EdgeCoder's servers only (never on a host's machine): the SSRF checks
 * of ssrf.ts on the URL and on every redirect, the connection pinned to the address that was
 * checked, 10 seconds and 2 MB at most, and only HTML, text, JSON and (simple) PDF pages.
 */

import { Agent, request } from "undici";
import { BlockedUrlError, checkUrlShape, pinnedLookup, resolvePublic, systemResolver, type Resolver } from "./ssrf.js";
import { htmlToText, jsonToText, pdfToText, plainToText, type PageText } from "./extract.js";

/** What the fetcher says it is (no personal contact details). */
export const WEB_TOOL_USER_AGENT = "EdgeCoderWebTool/1.0 (+https://edgecoder.io)";
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;

export class PageFetchError extends Error {
  constructor(message: string, readonly code: "blocked_url" | "fetch_failed" | "unsupported_type" | "too_large" | "timeout" | "http_error") {
    super(message);
  }
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Drop the rest of the body (redirects, refusals). */
  close: () => Promise<void>;
}

/** One GET to `url`, connecting to `pin` (the address already checked), never following redirects. */
export type PageTransport = (url: URL, pin: { address: string; family: 4 | 6 }, opts: { signal: AbortSignal; headers: Record<string, string> }) => Promise<TransportResponse>;

/** undici with a per-request dispatcher whose DNS lookup always answers the pinned address. */
export const pinnedTransport: PageTransport = async (url, pin, opts) => {
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(pin.address, pin.family) as never }, connections: 1 });
  try {
    const res = await request(url.toString(), { method: "GET", headers: opts.headers, signal: opts.signal, dispatcher, headersTimeout: PAGE_TIMEOUT_MS, bodyTimeout: PAGE_TIMEOUT_MS });
    return {
      status: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: res.body,
      close: async () => {
        await res.body.dump().catch(() => {});
        await dispatcher.close().catch(() => {});
      },
    };
  } catch (err) {
    await dispatcher.close().catch(() => {});
    throw err;
  }
};

export interface FetchPageDeps {
  resolve?: Resolver;
  transport?: PageTransport;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface FetchedPage extends PageText {
  /** Where the page was in the end (after redirects). */
  url: string;
  contentType: string;
}

const header = (h: TransportResponse["headers"], name: string): string => {
  const v = h[name] ?? h[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

type Kind = "html" | "json" | "text" | "pdf";

/** What kind of page a content type is, or null when it can't be read. */
export function pageKind(contentType: string): Kind | null {
  const t = contentType.split(";")[0].trim().toLowerCase();
  if (t === "text/html" || t === "application/xhtml+xml") return "html";
  if (t === "application/json" || t.endsWith("+json")) return "json";
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("text/") || t === "application/xml" || t.endsWith("+xml")) return "text";
  // No content type: sniffed from the bytes later as HTML or text.
  if (t === "") return "html";
  return null;
}

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return m ? m[1].toLowerCase() : "utf-8";
}

function decode(buf: Buffer, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** Fetch a public page and return its title and readable text. Throws PageFetchError. */
export async function fetchPage(raw: string, deps: FetchPageDeps = {}): Promise<FetchedPage> {
  const resolve = deps.resolve ?? systemResolver;
  const transport = deps.transport ?? pinnedTransport;
  const maxBytes = deps.maxBytes ?? PAGE_MAX_BYTES;
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? PAGE_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const headers = { "user-agent": WEB_TOOL_USER_AGENT, accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,application/pdf;q=0.5,*/*;q=0.1" };
  let url: URL;
  try {
    url = checkUrlShape(raw);
  } catch (err) {
    throw new PageFetchError((err as Error).message, "blocked_url");
  }
  try {
    for (let hop = 0; ; hop++) {
      const pin = await resolvePublic(url, resolve);
      const res = await transport(url, pin, { signal, headers });
      if (res.status >= 300 && res.status < 400 && header(res.headers, "location")) {
        await res.close();
        if (hop >= MAX_REDIRECTS) throw new PageFetchError("The page redirected too many times.", "fetch_failed");
        let next: URL;
        try {
          next = new URL(header(res.headers, "location"), url);
        } catch {
          throw new PageFetchError("The page redirected to an invalid address.", "fetch_failed");
        }
        // The same checks as the first URL, on every hop.
        url = checkUrlShape(next.toString());
        continue;
      }
      if (res.status >= 400) {
        await res.close();
        throw new PageFetchError(`The page answered HTTP ${res.status}.`, "http_error");
      }
      const contentType = header(res.headers, "content-type");
      const kind = pageKind(contentType);
      if (!kind) {
        await res.close();
        throw new PageFetchError(`That page is ${contentType.split(";")[0] || "an unknown type"}, which can't be read (only HTML, text, JSON and PDF).`, "unsupported_type");
      }
      const declared = Number(header(res.headers, "content-length"));
      if (Number.isFinite(declared) && declared > maxBytes && kind === "pdf") {
        await res.close();
        throw new PageFetchError(`That PDF is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, "too_large");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let cut = false;
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk);
        if (size + b.length > maxBytes) {
          chunks.push(b.subarray(0, maxBytes - size));
          size = maxBytes;
          cut = true;
          break;
        }
        chunks.push(b);
        size += b.length;
      }
      await res.close();
      const body = Buffer.concat(chunks);
      if (kind === "pdf") {
        if (cut) throw new PageFetchError(`That PDF is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, "too_large");
        const pdf = pdfToText(body);
        if (!pdf) throw new PageFetchError("Couldn't get text out of that PDF (it may be scanned or use fonts the reader doesn't know).", "unsupported_type");
        return { ...pdf, url: url.toString(), contentType: "application/pdf" };
      }
      const text = decode(body, contentType);
      const looksHtml = kind === "html" && (contentType !== "" || /<(html|body|p|div|title)\b/i.test(text.slice(0, 4096)));
      const page = kind === "json" ? jsonToText(text) : looksHtml ? htmlToText(text) : plainToText(text);
      return { ...page, truncated: page.truncated || cut, url: url.toString(), contentType: contentType.split(";")[0].trim() || "text/html" };
    }
  } catch (err) {
    if (err instanceof PageFetchError) throw err;
    if (err instanceof BlockedUrlError) throw new PageFetchError(err.message, "blocked_url");
    if (timeout.aborted) throw new PageFetchError(`The page took longer than ${Math.round((deps.timeoutMs ?? PAGE_TIMEOUT_MS) / 1000)} seconds.`, "timeout");
    throw new PageFetchError(`Couldn't fetch the page (${(err as Error).message ?? String(err)}).`, "fetch_failed");
  }
}

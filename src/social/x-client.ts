// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, randomBytes } from "node:crypto";
import type { XCredentials } from "./config.js";

/**
 * X API v2 posting with OAuth 1.0a user-context signing (HMAC-SHA1), done here with node:crypto.
 * The only call is POST /2/tweets with a body of `{ text }`: never a reply, quote, like, follow,
 * repost or DM. Secrets never leave this module except inside the Authorization header.
 */

export const X_TWEETS_URL = "https://api.x.com/2/tweets";

/** RFC 3986 percent-encoding, as OAuth 1.0a requires. */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface OAuthSignInput {
  method: string;
  /** Full URL; its query parameters are signed with the oauth_* ones. */
  url: string;
  creds: XCredentials;
  /** Form-encoded body parameters, when the body is application/x-www-form-urlencoded (not for JSON bodies). */
  bodyParams?: Record<string, string>;
  nonce?: string;
  timestampSec?: number;
}

/** The signature base string: METHOD & encoded base URL & encoded sorted parameter string. */
export function oauthBaseString(method: string, url: string, params: Array<[string, string]>): string {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
  const all: Array<[string, string]> = [...params];
  for (const [k, v] of u.searchParams) all.push([k, v]);
  const encoded = all.map(([k, v]) => [percentEncode(k), percentEncode(v)] as const);
  encoded.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const paramString = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  return `${method.toUpperCase()}&${percentEncode(base)}&${percentEncode(paramString)}`;
}

/** The oauth_* parameters, the signature, and the Authorization header value. */
export function oauthSign(i: OAuthSignInput): { signature: string; header: string; baseString: string } {
  const oauth: Record<string, string> = {
    oauth_consumer_key: i.creds.consumerKey,
    oauth_nonce: i.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(i.timestampSec ?? Math.floor(Date.now() / 1000)),
    oauth_token: i.creds.token,
    oauth_version: "1.0"
  };
  const baseString = oauthBaseString(i.method, i.url, [...Object.entries(oauth), ...Object.entries(i.bodyParams ?? {})]);
  const key = `${percentEncode(i.creds.consumerSecret)}&${percentEncode(i.creds.tokenSecret)}`;
  const signature = createHmac("sha1", key).update(baseString).digest("base64");
  const header =
    "OAuth " +
    Object.entries({ ...oauth, oauth_signature: signature })
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(", ");
  return { signature, header, baseString };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export type XPostResult = { ok: true; id: string } | { ok: false; error: string; status?: number };

/** Post an original tweet. Errors carry X's status and error title, never request headers. */
export async function postTweet(text: string, creds: XCredentials, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<XPostResult> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const { header } = oauthSign({ method: "POST", url: X_TWEETS_URL, creds });
  let status = 0;
  let body = "";
  try {
    const res = await doFetch(X_TWEETS_URL, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json", "user-agent": "edgecoder-portal" },
      // Only `text`: no reply, quote_tweet_id, media or poll fields, ever.
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000)
    });
    status = res.status;
    body = await res.text();
  } catch (error) {
    return { ok: false, error: `x_unreachable: ${error instanceof Error ? error.name : "error"}` };
  }
  let json: { data?: { id?: unknown }; title?: unknown; detail?: unknown; errors?: Array<{ message?: unknown }> } = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch {
    json = {};
  }
  if ((status === 200 || status === 201) && typeof json.data?.id === "string" && /^\d+$/.test(json.data.id)) return { ok: true, id: json.data.id };
  const detail = [json.title, json.detail, json.errors?.[0]?.message].filter((v): v is string => typeof v === "string").join(": ").slice(0, 300);
  return { ok: false, status, error: `x_http_${status}${detail ? `: ${detail}` : ""}` };
}

export const tweetUrl = (id: string) => `https://x.com/i/web/status/${id}`;

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, randomBytes } from "node:crypto";
import type { XCredentials } from "./config.js";

/**
 * X API v2 posting with OAuth 1.0a user-context signing (HMAC-SHA1), done here with node:crypto.
 * Three calls, nothing else (never a quote, like, follow, repost or DM):
 *
 * - POST /2/media/upload: X's one-shot image upload (multipart/form-data, fields `media` and
 *   `media_category=tweet_image`). Multipart body fields are NOT part of the OAuth 1.0a signature
 *   base string (only application/x-www-form-urlencoded bodies are), so it is signed with the
 *   oauth_* parameters alone.
 * - POST /2/media/metadata: alt text for an uploaded image (JSON body, likewise unsigned).
 * - POST /2/tweets: `{ text }`, plus `media.media_ids` when the post has images, and
 *   `reply.in_reply_to_tweet_id` ONLY for the next post of a thread this system is posting itself
 *   (src/social/service.ts sendThread passes the id X returned for our previous post).
 *
 * Secrets never leave this module except inside the Authorization header.
 */

export const X_TWEETS_URL = "https://api.x.com/2/tweets";
export const X_MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";
export const X_MEDIA_METADATA_URL = "https://api.x.com/2/media/metadata";

/** RFC 3986 percent-encoding, as OAuth 1.0a requires. */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface OAuthSignInput {
  method: string;
  /** Full URL; its query parameters are signed with the oauth_* ones. */
  url: string;
  creds: XCredentials;
  /** Form-encoded body parameters, when the body is application/x-www-form-urlencoded (not for JSON or multipart bodies). */
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

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }
) => Promise<{ status: number; text(): Promise<string> }>;

export type XPostResult = { ok: true; id: string } | { ok: false; error: string; status?: number };

export interface XOpts {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Tests only: fixed OAuth nonce and timestamp. */
  nonce?: string;
  timestampSec?: number;
}

const ID_RE = /^\d{1,19}$/;

/** One signed POST. The result is X's data.id, or an error with X's status and title (never request headers). */
async function xPost(url: string, creds: XCredentials, contentType: string, body: string | Uint8Array, opts: XOpts): Promise<XPostResult> {
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => globalThis.fetch(u, init as RequestInit));
  // JSON and multipart bodies are never signed: only the oauth_* parameters go into the base string.
  const { header } = oauthSign({ method: "POST", url, creds, nonce: opts.nonce, timestampSec: opts.timestampSec });
  let status = 0;
  let text = "";
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: header, "content-type": contentType, "user-agent": "edgecoder-portal" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000)
    });
    status = res.status;
    text = await res.text();
  } catch (error) {
    return { ok: false, error: `x_unreachable: ${error instanceof Error ? error.name : "error"}` };
  }
  let json: { data?: { id?: unknown }; title?: unknown; detail?: unknown; errors?: Array<{ message?: unknown }> } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if ((status === 200 || status === 201) && typeof json.data?.id === "string" && ID_RE.test(json.data.id)) return { ok: true, id: json.data.id };
  const detail = [json.title, json.detail, json.errors?.[0]?.message].filter((v): v is string => typeof v === "string").join(": ").slice(0, 300);
  return { ok: false, status, error: `x_http_${status}${detail ? `: ${detail}` : ""}` };
}

export interface TweetOptions extends XOpts {
  /** Up to 4 media ids from uploadMedia. */
  mediaIds?: string[];
  /**
   * The previous post of a thread this system just posted itself (the id X returned to it). The
   * service never passes anyone else's tweet: this is the only reply the client makes.
   */
  inReplyToOwnTweetId?: string;
}

/** The JSON body of POST /2/tweets: text, optional media ids, optional reply to our own previous post. */
export function tweetBody(text: string, o: Pick<TweetOptions, "mediaIds" | "inReplyToOwnTweetId"> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { text };
  if (o.mediaIds?.length) body.media = { media_ids: o.mediaIds.slice(0, 4) };
  if (o.inReplyToOwnTweetId !== undefined) {
    if (!ID_RE.test(o.inReplyToOwnTweetId)) throw new Error("invalid reply target");
    body.reply = { in_reply_to_tweet_id: o.inReplyToOwnTweetId };
  }
  return body;
}

/** Post a tweet: an original post, or the next post of our own thread. No quote, poll or other fields, ever. */
export async function postTweet(text: string, creds: XCredentials, opts: TweetOptions = {}): Promise<XPostResult> {
  let body: string;
  try {
    body = JSON.stringify(tweetBody(text, opts));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid tweet" };
  }
  return xPost(X_TWEETS_URL, creds, "application/json", body, { timeoutMs: 15_000, ...opts });
}

/** A multipart/form-data body (RFC 7578): text fields, then one file field. */
export function multipartBody(
  fields: Record<string, string>,
  file: { name: string; filename: string; contentType: string; bytes: Uint8Array },
  boundary = `----edgecoder${randomBytes(12).toString("hex")}`
): { body: Uint8Array; contentType: string } {
  const safe = (s: string) => s.replace(/["\r\n\\]/g, "_");
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(k)}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(file.name)}"; filename="${safe(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
  parts.push(Buffer.from(file.bytes));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: new Uint8Array(Buffer.concat(parts)), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Upload one image (PNG or JPEG, at most 5 MB) with X's one-shot v2 upload; the id goes in media_ids. */
export async function uploadMedia(image: { filename: string; contentType: string; bytes: Uint8Array }, creds: XCredentials, opts: XOpts = {}): Promise<XPostResult> {
  const { body, contentType } = multipartBody({ media_category: "tweet_image" }, { name: "media", ...image });
  return xPost(X_MEDIA_UPLOAD_URL, creds, contentType, body, opts);
}

/** Alt text (at most 1000 characters) for an uploaded image. */
export async function setMediaAltText(mediaId: string, alt: string, creds: XCredentials, opts: XOpts = {}): Promise<XPostResult> {
  if (!ID_RE.test(mediaId)) return { ok: false, error: "invalid media id" };
  const body = JSON.stringify({ id: mediaId, metadata: { alt_text: { text: alt.slice(0, 1000) } } });
  return xPost(X_MEDIA_METADATA_URL, creds, "application/json", body, { timeoutMs: 15_000, ...opts });
}

export const tweetUrl = (id: string) => `https://x.com/i/web/status/${id}`;

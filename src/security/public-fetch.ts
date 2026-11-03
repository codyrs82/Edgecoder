// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * JSON GET for URLs a user or remote party chose (LNURL-pay endpoints and callbacks): https only,
 * no credentials in the URL, the host must resolve to public addresses (checked before the request
 * and again by the dispatcher at connect time, against DNS rebinding), redirects are refused, and
 * the body is capped. Same address policy as model downloads (src/security/model-download.ts).
 */

import { request, type Dispatcher } from "undici";
import { assertPublicHttps, guardedAgent } from "./model-download.js";

export interface PublicFetchOptions {
  timeoutMs?: number;
  /** Largest body read (default 64 KiB). */
  maxBytes?: number;
  /** Injectable for tests. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  dispatcher?: Dispatcher;
}

export class PublicFetchError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export async function fetchPublicJson(url: string, opts: PublicFetchOptions = {}): Promise<unknown> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PublicFetchError("invalid_url");
  }
  if (u.username || u.password) throw new PublicFetchError("url_has_credentials");
  await assertPublicHttps(u.toString(), opts.resolveHost);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const res = await request(u.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
    dispatcher: opts.dispatcher ?? guardedAgent,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });
  if (res.statusCode >= 300 && res.statusCode < 400) {
    await res.body.dump();
    throw new PublicFetchError("redirect_refused", String(res.statusCode));
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    await res.body.dump();
    throw new PublicFetchError(`http_${res.statusCode}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > maxBytes) {
      res.body.destroy();
      throw new PublicFetchError("response_too_large");
    }
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PublicFetchError("invalid_json");
  }
}

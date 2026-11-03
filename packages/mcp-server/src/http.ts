// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** The one way the MCP server talks to EdgeCoder: JSON over HTTPS to the portal's hosted API. */
export type HttpResult = { status: number; json: any };
export type Http = (method: "GET" | "POST", path: string, body?: unknown, apiKey?: string) => Promise<HttpResult>;

/** Same default as the installer's DEFAULT_PORTAL_URL (src/install/options.ts); EDGECODER_URL overrides. */
export const DEFAULT_PORTAL_URL = "https://edgecoder.io";

export function baseUrlFrom(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.EDGECODER_URL || env.EDGECODER_PORTAL_URL || DEFAULT_PORTAL_URL).trim().replace(/\/+$/, "");
  const u = new URL(raw);
  // An API key must not travel in clear text, except to this machine (development).
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error(`EDGECODER_URL must be https:// (got ${raw})`);
  return raw;
}

export function fetchHttp(baseUrl: string, timeoutMs = 120_000): Http {
  return async (method, path, body, apiKey) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return { status: res.status, json: text ? JSON.parse(text) : {} };
    } catch {
      return { status: res.status, json: { error: text.slice(0, 300) } };
    }
  };
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Headers a reverse proxy adds when it relays a request. A proxy on the same machine (Caddy,
 * nginx, cloudflared, a sidecar) connects from 127.0.0.1 on behalf of whoever reached it, so a
 * loopback socket carrying any of these is not this machine talking to itself. Header names are
 * the lower-case form Node gives them.
 */
export const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "via",
  "cf-connecting-ip",
  "cf-ray",
  "true-client-ip",
  "fly-client-ip",
  "fly-forwarded-port"
] as const;

/** True when the request was relayed by a proxy (any PROXY_HEADERS entry is present). */
export function carriesProxyHeaders(headers: Record<string, unknown> | undefined | null): boolean {
  if (!headers) return false;
  return PROXY_HEADERS.some((h) => headers[h] !== undefined);
}

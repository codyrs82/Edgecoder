// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * SSRF guard for read_page (docs/web-tool.md). A page is fetched only when:
 *   - the URL is http or https, on port 80 or 443, with no user:password part;
 *   - every address its host resolves to is public: not loopback, private (10/8, 172.16/12,
 *     192.168/16, fc00::/7, which includes Fly's 6PN fdaa::/16), link-local (169.254/16, which
 *     includes the 169.254.169.254 metadata service, and fe80::/10), carrier-grade NAT, multicast,
 *     reserved or unspecified. IPv4-mapped and NAT64 IPv6 addresses are checked as the IPv4 inside.
 *
 * DNS rebinding: the host is resolved once per hop and the connection is pinned to that address
 * (pinnedLookup), so a second, different answer can't move the request onto a private address after
 * the check. Every redirect is checked the same way before it is followed.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Ports a page may be fetched from. */
export const ALLOWED_PORTS: ReadonlySet<string> = new Set(["", "80", "443"]);

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

/** The system resolver: every address the host has. */
export const systemResolver: Resolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

export class BlockedUrlError extends Error {
  readonly code = "blocked_url";
}

function v4Parts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function blockedV4(ip: string): string | null {
  const p = v4Parts(ip);
  if (!p) return "not an address";
  const [a, b, c] = p;
  if (a === 0) return "unspecified (0.0.0.0/8)";
  if (a === 10) return "private (10.0.0.0/8)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return c === 169 && p[3] === 254 ? "cloud metadata (169.254.169.254)" : "link-local (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12)";
  if (a === 192 && b === 168) return "private (192.168.0.0/16)";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10)";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (a === 192 && b === 0 && c === 2) return "documentation (192.0.2.0/24)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15)";
  if (a === 198 && b === 51 && c === 100) return "documentation (198.51.100.0/24)";
  if (a === 203 && b === 0 && c === 113) return "documentation (203.0.113.0/24)";
  if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
  if (a >= 240) return "reserved (240.0.0.0/4)";
  return null;
}

/** The 8 16-bit groups of an IPv6 address, or null. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const p = v4Parts(tail);
    if (!p) return null;
    s = `${s.slice(0, lastColon + 1)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === "" ? [] : h.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some((g) => Number.isNaN(g))) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  return [...head, ...new Array(Math.max(0, missing)).fill(0), ...rest];
}

function blockedV6(ip: string): string | null {
  const g = v6Groups(ip);
  if (!g) return "not an address";
  if (g.every((x) => x === 0)) return "unspecified (::)";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback (::1)";
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): the IPv4 address decides.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const inner = blockedV4(embedded(g[6], g[7]));
    return inner ? `IPv4 inside IPv6: ${inner}` : null;
  }
  // NAT64 (64:ff9b::/96) reaches the IPv4 address inside.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const inner = blockedV4(embedded(g[6], g[7]));
    return inner ? `NAT64: ${inner}` : null;
  }
  if ((g[0] & 0xfe00) === 0xfc00) return g[0] === 0xfdaa ? "Fly private network (fdaa::/16)" : "unique local (fc00::/7)";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g[0] & 0xffc0) === 0xfec0) return "site-local (fec0::/10)";
  if ((g[0] & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation (2001:db8::/32)";
  // 6to4 (2002::/16) carries an IPv4 address in its next 32 bits.
  if (g[0] === 0x2002) {
    const inner = blockedV4(embedded(g[1], g[2]));
    return inner ? `6to4: ${inner}` : null;
  }
  return null;
}

/** Why an address may not be fetched, or null when it is public. */
export function blockedAddressReason(ip: string): string | null {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0]);
  if (kind === 4) return blockedV4(ip);
  if (kind === 6) return blockedV6(ip.replace(/^\[|\]$/g, ""));
  return "not an address";
}

/** A URL read_page may try (scheme, port, no credentials); throws BlockedUrlError otherwise. */
export function checkUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BlockedUrlError("That isn't a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("Only http and https pages can be read.");
  if (url.username || url.password) throw new BlockedUrlError("URLs with a user name or password can't be read.");
  if (!ALLOWED_PORTS.has(url.port)) throw new BlockedUrlError("Only pages on port 80 or 443 can be read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BlockedUrlError("That URL has no host.");
  if (isIP(host)) {
    const why = blockedAddressReason(host);
    if (why) throw new BlockedUrlError(`That address can't be read: ${why}.`);
  } else if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || !host.includes(".")) {
    throw new BlockedUrlError("Pages on private or local host names can't be read.");
  }
  return url;
}

/**
 * Resolve the URL's host once and check every address; returns the address to connect to.
 * A host that resolves to any blocked address is refused (one bad answer is enough: a resolver
 * that mixes public and private answers is how DNS rebinding starts).
 */
export async function resolvePublic(url: URL, resolve: Resolver = systemResolver): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  if (literal) return { address: host, family: literal as 4 | 6 };
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await resolve(host);
  } catch {
    throw new BlockedUrlError(`Couldn't find ${host}.`);
  }
  if (answers.length === 0) throw new BlockedUrlError(`Couldn't find ${host}.`);
  for (const a of answers) {
    const why = blockedAddressReason(a.address);
    if (why) throw new BlockedUrlError(`${host} points at an address that can't be read (${why}).`);
  }
  const first = answers[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * A `lookup` for the socket that always answers the address already checked, whatever the host:
 * the connection can't be steered elsewhere by a second DNS answer.
 */
export function pinnedLookup(address: string, family: 4 | 6) {
  return (
    _host: string,
    opts: unknown,
    cb: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
  ): void => {
    if (opts && typeof opts === "object" && (opts as { all?: boolean }).all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

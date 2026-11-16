// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * LAN proximity between one account's own machines (docs/security/lan-proximity.md).
 *
 * The coordinator can only measure its own round trip to each machine, so two Macs on the same
 * home network looked as far apart as two machines on different continents. This module is the
 * shared, pure part of seeing that they are neighbours:
 *
 * - Agents report their private IPv4 addresses with the subnet prefix (`lanAddresses`, signed
 *   /register; AGENT_LAN_HINTS=off turns it off). Only RFC 1918 addresses are kept.
 * - Coordinators compare a tag of the public address each machine connects from (`networkTag`:
 *   IPv4, or the /64 of an IPv6 address). Machines behind the same NAT share it.
 * - The world view shares a machine's private addresses and the same-public-network hint only with
 *   that machine's owner, and only with a signed agent (the desktop app), never with the portal.
 * - The desktop app's IDE provider then measures the round trip itself (ICMP echo, the OS `ping`)
 *   to own machines that share its public network and one of its subnets. No port is opened and
 *   nothing new listens on the LAN.
 */
import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";

/** At most this many private addresses per machine are reported and kept. */
export const LAN_MAX_ADDRESSES = 4;

function v4Parts(ip: string): number[] | null {
  if (!isIPv4(ip)) return null;
  return ip.split(".").map(Number);
}

/** RFC 1918 private IPv4 (10/8, 172.16/12, 192.168/16). Link-local, loopback and CGNAT are not. */
export function isPrivateIPv4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

/** `a.b.c.d/nn` with a private address and a prefix a home or office LAN would have (8..30). */
export function parseLanCidr(raw: unknown): { ip: string; prefix: number } | null {
  if (typeof raw !== "string" || raw.length > 18) return null;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(raw);
  if (!m) return null;
  const prefix = Number(m[2]);
  if (!isPrivateIPv4(m[1]) || prefix < 8 || prefix > 30) return null;
  return { ip: m[1], prefix };
}

/** A reported list, checked entry by entry: private CIDRs only, deduplicated, capped. */
export function sanitizeLanAddresses(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw.slice(0, 16)) {
    const c = parseLanCidr(item);
    if (!c) continue;
    const s = `${c.ip}/${c.prefix}`;
    if (!out.includes(s)) out.push(s);
    if (out.length >= LAN_MAX_ADDRESSES) break;
  }
  return out;
}

function v4Int(ip: string): number {
  const p = v4Parts(ip)!;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** Whether `ip` is inside `net/prefix`. */
export function inSubnet(ip: string, net: string, prefix: number): boolean {
  if (!isIPv4(ip) || !isIPv4(net) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (v4Int(ip) & mask) === (v4Int(net) & mask);
}

/** This computer's private IPv4 addresses with their prefix (`192.168.1.23/24`), physical interfaces first. */
export function localLanAddresses(nets: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const physical = /^(en|eth|wlan|wl|wifi|ethernet|wi-fi)/i;
  const found: Array<{ cidr: string; rank: number }> = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const iface of list ?? []) {
      if (iface.family !== "IPv4" || iface.internal || !iface.cidr) continue;
      if (!parseLanCidr(iface.cidr)) continue;
      found.push({ cidr: iface.cidr, rank: physical.test(name) ? 0 : 1 });
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  return sanitizeLanAddresses(found.map((f) => f.cidr));
}

/**
 * Addresses of another machine worth probing from here: those inside one of this computer's own
 * subnets. Anything else is not on this LAN (or not reachable directly) and is never probed.
 */
export function probeableAddresses(remote: readonly string[], local: readonly string[]): string[] {
  const mine = local.map(parseLanCidr).filter((c): c is { ip: string; prefix: number } => c !== null);
  const out: string[] = [];
  for (const r of remote) {
    const c = parseLanCidr(r);
    if (!c || mine.some((m) => m.ip === c.ip)) continue;
    if (mine.some((m) => inSubnet(c.ip, m.ip, m.prefix)) && !out.includes(c.ip)) out.push(c.ip);
  }
  return out;
}

function expandIPv6(ip: string): string[] | null {
  if (!isIPv6(ip)) return null;
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  // An embedded IPv4 tail counts as two groups.
  const groups = [...h, ...t].reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  if (tail === null && groups !== 8) return null;
  const fill = tail === null ? [] : Array(8 - groups).fill("0");
  return [...h, ...fill, ...t].filter((g) => !g.includes(".")).map((g) => g.padStart(4, "0").toLowerCase());
}

/**
 * The part of a public address that machines behind the same router share: the IPv4 address
 * itself, or the /64 prefix of an IPv6 address. Null for anything that is not a public-looking
 * client address (missing, loopback, private: a coordinator on the same LAN sees those).
 */
export function networkKey(ip: string | null | undefined): string | null {
  if (typeof ip !== "string" || !ip) return null;
  const s = ip.trim().replace(/^::ffff:/i, "");
  if (isIPv4(s)) {
    if (s.startsWith("127.") || s === "0.0.0.0") return null;
    return s;
  }
  const g = expandIPv6(s);
  if (!g || g.length < 4 || g.every((x) => x === "0000") || g.join(":") === "0000:0000:0000:0000:0000:0000:0000:0001") return null;
  return `${g.slice(0, 4).join(":")}::/64`;
}

/** Tag of a public network, compared between coordinators. Internal: never sent to clients. */
export function networkTag(ip: string | null | undefined): string | null {
  const key = networkKey(ip);
  return key ? createHash("sha256").update("edgecoder-world-net\n").update(key).digest("hex").slice(0, 32) : null;
}

/** Two client addresses are behind the same router (same IPv4, or the same IPv6 /64). */
export function samePublicNetwork(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = networkKey(a);
  return x !== null && x === networkKey(b);
}

/**
 * "My machines" calls: of the requester's own machines that hold the model, the one behind the
 * same router as the request (most free slots first), for a soft preference (dispatch.ts
 * preferAgent). Null when none is: the call stays open to every own machine as before.
 */
export function pickSameNetworkAgent(
  candidates: ReadonlyArray<{ agentId: string; sourceIp?: string | null; freeSlots: number }>,
  requestIp: string | null | undefined
): string | null {
  if (!networkKey(requestIp)) return null;
  const near = candidates.filter((c) => c.freeSlots > 0 && samePublicNetwork(c.sourceIp, requestIp));
  near.sort((a, b) => b.freeSlots - a.freeSlots || a.agentId.localeCompare(b.agentId));
  return near[0]?.agentId ?? null;
}

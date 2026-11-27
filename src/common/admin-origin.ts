// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { BlockList, isIPv4, isIPv6 } from "node:net";
import { carriesProxyHeaders } from "./proxy-headers.js";

/*
 * Where operator (admin-token) requests may come from. The token is still required; this decides
 * only whether a request is allowed to try it.
 *
 * Trust comes from the TCP socket, never from a header:
 * - loopback (the machine itself: `fly ssh console`, the control plane in the same process group)
 *   is internal, unless it is a configured reverse proxy (COORDINATOR_TRUST_PROXY);
 * - on Fly (FLY_APP_NAME set) the private network 6PN, fdaa::/16, is internal. Fly's public edge
 *   proxy connects from another range, so a request from the internet never matches;
 * - off Fly, the private ranges (RFC 1918, fc00::/7, fe80::/10) are internal;
 * - ADMIN_ALLOWED_CIDRS adds ranges in both cases.
 *
 * Headers can only refuse: Fly's edge sets Fly-Client-IP and Fly-Forwarded-Port on every public
 * request, so a request carrying either came (or claims to come) through the public proxy and is
 * refused. Sending them from inside only locks the sender out. Any other proxy header
 * (X-Forwarded-For, Forwarded, X-Real-IP, Via, ...) means a proxy relayed the request, so it is
 * refused as via_proxy whatever the socket address: a same-host proxy connects from loopback.
 */

export interface AdminOriginPolicy {
  onFly: boolean;
  /** Extra CIDRs (ADMIN_ALLOWED_CIDRS). */
  allowedCidrs: string[];
  /** Reverse proxies in front of this service (their traffic is the outside world's). */
  trustedProxies: string[];
}

export type AdminOriginDecision = { ok: true; via: "loopback" | "private_network" | "allowlist" } | { ok: false; reason: "public_ingress" | "via_proxy" | "not_internal" | "no_socket_address" };

const PUBLIC_INGRESS_HEADERS = ["fly-client-ip", "fly-forwarded-port"];

function normalize(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let v = raw.trim();
  if (v.startsWith("[") && v.includes("]")) v = v.slice(1, v.indexOf("]"));
  const zone = v.indexOf("%");
  if (zone > 0) v = v.slice(0, zone);
  if (v.toLowerCase().startsWith("::ffff:") && isIPv4(v.slice(7))) v = v.slice(7);
  return v || undefined;
}

/** Parses "a.b.c.d/n" / "x::/n" / a bare address; throws on anything else (config validation). */
export function addCidr(list: BlockList, cidr: string): void {
  const [addrRaw, prefixRaw] = cidr.trim().split("/");
  const addr = normalize(addrRaw);
  if (!addr || !(isIPv4(addr) || isIPv6(addr))) throw new Error(`invalid CIDR "${cidr}"`);
  const family = isIPv4(addr) ? "ipv4" : "ipv6";
  const max = family === "ipv4" ? 32 : 128;
  const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`invalid CIDR "${cidr}"`);
  list.addSubnet(addr, prefix, family);
}

/** Problems with an ADMIN_ALLOWED_CIDRS value, or null. */
export function allowedCidrsProblem(raw: string | undefined): string | null {
  try {
    const list = new BlockList();
    for (const c of splitList(raw)) addCidr(list, c);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function contains(list: BlockList, ip: string): boolean {
  return list.check(ip, isIPv4(ip) ? "ipv4" : "ipv6");
}

const FLY_PRIVATE = ["fdaa::/16"];
const LAN_PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "fe80::/10"];
const LOOPBACK = ["127.0.0.0/8", "::1/128"];

export function adminOriginPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AdminOriginPolicy {
  return {
    onFly: Boolean((env.FLY_APP_NAME ?? "").trim()),
    allowedCidrs: splitList(env.ADMIN_ALLOWED_CIDRS),
    trustedProxies: splitList(env.COORDINATOR_TRUST_PROXY).map((p) => normalize(p)!).filter(Boolean)
  };
}

const compiled = new WeakMap<AdminOriginPolicy, { loopback: BlockList; privateNet: BlockList; extra: BlockList }>();
function lists(policy: AdminOriginPolicy) {
  let c = compiled.get(policy);
  if (!c) {
    const build = (cidrs: string[]) => {
      const l = new BlockList();
      for (const x of cidrs) addCidr(l, x);
      return l;
    };
    c = { loopback: build(LOOPBACK), privateNet: build(policy.onFly ? FLY_PRIVATE : LAN_PRIVATE), extra: build(policy.allowedCidrs) };
    compiled.set(policy, c);
  }
  return c;
}

/** Decides from the socket's remote address (and refuses on public-ingress headers). */
export function adminOriginDecision(remoteAddress: string | undefined, headers: Record<string, unknown>, policy: AdminOriginPolicy): AdminOriginDecision {
  for (const h of PUBLIC_INGRESS_HEADERS) {
    if (headers[h] !== undefined) return { ok: false, reason: "public_ingress" };
  }
  const ip = normalize(remoteAddress);
  if (!ip || !(isIPv4(ip) || isIPv6(ip))) return { ok: false, reason: "no_socket_address" };
  if (policy.trustedProxies.includes(ip)) return { ok: false, reason: "via_proxy" };
  const l = lists(policy);
  const via = contains(l.loopback, ip) ? "loopback" : contains(l.privateNet, ip) ? "private_network" : contains(l.extra, ip) ? "allowlist" : null;
  if (!via) return { ok: false, reason: "not_internal" };
  // An internal socket that relays someone else (a same-host or LAN proxy) is not internal.
  if (carriesProxyHeaders(headers)) return { ok: false, reason: "via_proxy" };
  return { ok: true, via };
}

/** The TCP peer address of a Fastify / Node request (never a header). */
export function socketAddressOf(req: unknown): string | undefined {
  const r = req as { socket?: { remoteAddress?: string }; raw?: { socket?: { remoteAddress?: string } } };
  return r?.socket?.remoteAddress ?? r?.raw?.socket?.remoteAddress;
}

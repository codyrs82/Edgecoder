// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// DNS seed discovery. Operators publish TXT records at `_edgecoder._tcp.<domain>`:
//   "v=ec1 url=https://coord-ord.edgecoder.io region=ord peer=coord-abc123"
// and optionally SRV records at the same name as a fallback (one per coordinator host).

import dns from "node:dns/promises";
import type { CoordinatorCandidate } from "./types.js";
import { normalizeCoordinatorUrl } from "./types.js";

export const DISCOVERY_SERVICE_LABEL = "_edgecoder._tcp";

/** Default lookup domain; EDGECODER_DISCOVERY_DOMAIN overrides it (#22: no hard-coded hosts). */
export function defaultDiscoveryDomain(env: NodeJS.ProcessEnv = process.env): string {
  return (env.EDGECODER_DISCOVERY_DOMAIN ?? "edgecoder.io").trim();
}

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

/** Subset of node:dns/promises used here; injectable for tests. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveSrv(hostname: string): Promise<SrvRecord[]>;
}

export interface DnsSeed {
  url: string;
  region?: string;
  peerId?: string;
  publicKeyFingerprint?: string;
}

export function discoveryHostname(domain: string): string {
  const d = domain.trim().replace(/^\.+|\.+$/g, "");
  return d.startsWith(`${DISCOVERY_SERVICE_LABEL}.`) ? d : `${DISCOVERY_SERVICE_LABEL}.${d}`;
}

/**
 * Parse one TXT record. Tokens are `key=value` separated by whitespace; unknown keys are ignored.
 * Returns null unless `v=ec1` and a valid http(s) `url` are present.
 */
export function parseDiscoveryTxt(txt: string): DnsSeed | null {
  const fields = new Map<string, string>();
  for (const token of txt.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1).replace(/^"|"$/g, "");
    if (!fields.has(key)) fields.set(key, value);
  }
  if (fields.get("v") !== "ec1") return null;
  const url = normalizeCoordinatorUrl(fields.get("url") ?? "");
  if (!url) return null;
  const seed: DnsSeed = { url };
  const region = fields.get("region");
  if (region) seed.region = region.slice(0, 64);
  const peer = fields.get("peer");
  if (peer) seed.peerId = peer.slice(0, 256);
  const fp = fields.get("fp") ?? fields.get("key");
  if (fp && /^[0-9a-f]{64}$/i.test(fp)) seed.publicKeyFingerprint = fp.toLowerCase();
  return seed;
}

/** SRV records map to `https://<target>[:port]`; port 443 is dropped, port 80 means http. */
export function srvToUrl(record: SrvRecord): string | null {
  const host = record.name.replace(/\.+$/, "");
  if (!host) return null;
  if (record.port === 80) return normalizeCoordinatorUrl(`http://${host}`);
  if (record.port === 443) return normalizeCoordinatorUrl(`https://${host}`);
  return normalizeCoordinatorUrl(`https://${host}:${record.port}`);
}

export interface ResolveDnsOptions {
  /** One domain or several; each is queried under `_edgecoder._tcp.`. Default edgecoder.io. */
  domain?: string | string[];
  resolver?: DnsResolver;
  /** Per-query timeout (default 3 s). DNS failures never throw; they yield no candidates. */
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Resolve DNS seeds for every domain. TXT first; SRV only when a domain yields no TXT seeds. */
export async function resolveDnsSeeds(opts: ResolveDnsOptions = {}): Promise<CoordinatorCandidate[]> {
  const resolver: DnsResolver = opts.resolver ?? dns;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const domains = (Array.isArray(opts.domain) ? opts.domain : [opts.domain ?? defaultDiscoveryDomain()])
    .map((d) => d.trim())
    .filter(Boolean);
  const results = await Promise.all(domains.map((d) => resolveOneDomain(d, resolver, timeoutMs)));
  const seen = new Set<string>();
  const out: CoordinatorCandidate[] = [];
  for (const list of results) {
    for (const c of list) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
  }
  return out;
}

async function resolveOneDomain(domain: string, resolver: DnsResolver, timeoutMs: number): Promise<CoordinatorCandidate[]> {
  const host = discoveryHostname(domain);
  const fromTxt: CoordinatorCandidate[] = [];
  try {
    const records = await withTimeout(resolver.resolveTxt(host), timeoutMs, `TXT ${host}`);
    for (const chunks of records) {
      const seed = parseDiscoveryTxt(chunks.join(""));
      if (!seed) continue;
      fromTxt.push({ url: seed.url, peerId: seed.peerId, region: seed.region, source: "dns" });
    }
  } catch {
    // NXDOMAIN / ENODATA / timeout: fall through to SRV.
  }
  if (fromTxt.length > 0) return fromTxt;
  try {
    const srv = await withTimeout(resolver.resolveSrv(host), timeoutMs, `SRV ${host}`);
    return [...srv]
      .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
      .map((r) => srvToUrl(r))
      .filter((u): u is string => Boolean(u))
      .map((url) => ({ url, source: "dns" as const }));
  } catch {
    return [];
  }
}

export function discoveryDomainsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return defaultDiscoveryDomain(env)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

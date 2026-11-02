// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { BitcoinNetwork } from "../common/types.js";
import { signPayload, verifyPayload } from "../mesh/peer.js";
import {
  BITCOIN_P2P_PORT,
  isLightningNodeId,
  probeBitcoind,
  probeCoordinatorIdentity,
  probeElectrum,
  probeLightning,
  resolveProbeTarget,
  type IdentityFetcher,
  type ProbeResult
} from "./service-probes.js";

/*
 * Infrastructure-host heartbeats (pentest: "host weight/uptime is self-reported").
 *
 * 1. Identity. A remote heartbeat (POST /economy/hosts/heartbeat) is signed with the host's
 *    coordinator key and checked against the key the mesh admitted for that hostId (allowlisted
 *    in production). The mesh token alone no longer lets anyone heartbeat for any host.
 * 2. Uptime. A heartbeat counts toward the window at most once per ~HOST_HEARTBEAT_MS
 *    (heartbeatCounts); extra heartbeats refresh lastSeen but add no uptime.
 * 3. Services. Declared services only count in the weight once the receiving coordinator has
 *    attested them over the network (HostServiceAttestor, protocols in service-probes.ts),
 *    probing the host of the coordinator URL the mesh knows — never a host the heartbeat names.
 *    A coordinator's own heartbeat is attested locally from the backends it actually uses.
 */

export const HOST_SERVICES = ["coordinator", "bitcoind", "lightning", "electrs"] as const;
export type HostService = (typeof HOST_SERVICES)[number];

export const HOST_HEARTBEAT_MAX_SKEW_MS = 5 * 60_000;

export interface HostHeartbeatFields {
  hostId: string;
  accountId?: string;
  services: string[];
  region?: string;
  coordinatorUrl?: string;
  lightningAddress?: string;
  /** Compressed secp256k1 node id; required for the lightning service to be attested. */
  lightningNodeId?: string;
  /** Ports of the declared services on the coordinator's host (defaults per network). */
  ports?: Partial<Record<"bitcoind" | "lightning" | "electrs", number>>;
}

export interface SignedHostHeartbeat extends HostHeartbeatFields {
  issuedAtMs: number;
  signature: string;
}

export function normalizeServices(services: string[]): string[] {
  return [...new Set(services.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Canonical bytes a host signs; every field that affects payment or weight is covered. */
export function hostHeartbeatPayload(h: HostHeartbeatFields & { issuedAtMs: number }): string {
  const ports = h.ports ?? {};
  return [
    "edgecoder-host-heartbeat-v1",
    h.hostId,
    h.accountId ?? "",
    normalizeServices(h.services).join(","),
    h.region ?? "",
    h.coordinatorUrl ?? "",
    h.lightningAddress ?? "",
    (h.lightningNodeId ?? "").toLowerCase(),
    ["bitcoind", "lightning", "electrs"].map((k) => String(ports[k as keyof typeof ports] ?? "")).join(","),
    h.issuedAtMs
  ].join("\n");
}

export function signHostHeartbeat(fields: HostHeartbeatFields, privateKeyPem: string, nowMs = Date.now()): SignedHostHeartbeat {
  return { ...fields, issuedAtMs: nowMs, signature: signPayload(hostHeartbeatPayload({ ...fields, issuedAtMs: nowMs }), privateKeyPem) };
}

export type HeartbeatVerdict = { ok: true } | { ok: false; reason: "host_unknown" | "stale_heartbeat" | "invalid_signature" | "reserved_account" };

export function verifyHostHeartbeat(
  hb: SignedHostHeartbeat,
  hostPublicKeyPem: string | undefined,
  opts: { nowMs?: number; reservedAccounts?: string[] } = {}
): HeartbeatVerdict {
  if (!hostPublicKeyPem) return { ok: false, reason: "host_unknown" };
  const now = opts.nowMs ?? Date.now();
  if (!Number.isFinite(hb.issuedAtMs) || Math.abs(now - hb.issuedAtMs) > HOST_HEARTBEAT_MAX_SKEW_MS) return { ok: false, reason: "stale_heartbeat" };
  if (!verifyPayload(hostHeartbeatPayload(hb), hb.signature, hostPublicKeyPem)) return { ok: false, reason: "invalid_signature" };
  // The pool must not be able to pay itself (or another system account) through a host record.
  if (hb.accountId && (opts.reservedAccounts ?? []).includes(hb.accountId)) return { ok: false, reason: "reserved_account" };
  return { ok: true };
}

/**
 * Whether a heartbeat at `nowMs` adds one to the host's window. Allows 20 % jitter on the
 * interval, so an honest host never loses a beat but a flood earns at most one per interval.
 */
export function heartbeatCounts(lastCountedMs: number | undefined, nowMs: number, heartbeatIntervalMs: number): boolean {
  if (lastCountedMs === undefined || !Number.isFinite(lastCountedMs)) return true;
  return nowMs - lastCountedMs >= Math.floor(heartbeatIntervalMs * 0.8);
}

/* ------------------------------------------------------------------ */
/*  Attestation                                                        */
/* ------------------------------------------------------------------ */

export interface AttestationResult {
  /** Declared services that passed, always including "coordinator" when that probe passed. */
  attested: string[];
  results: Record<string, ProbeResult>;
  atMs: number;
}

export interface RemoteHostTarget {
  hostId: string;
  publicKeyPem: string;
  /** The URL the mesh admitted for this peer (pinned in production); the probe host comes from here. */
  coordinatorUrl: string;
  services: string[];
  lightningNodeId?: string;
  ports?: HostHeartbeatFields["ports"];
}

export interface ServiceProbes {
  coordinator(url: string, hostId: string, publicKeyPem: string): Promise<ProbeResult>;
  bitcoind(host: string, port: number, network: BitcoinNetwork): Promise<ProbeResult>;
  lightning(host: string, port: number, nodeId: string): Promise<ProbeResult>;
  electrs(host: string, port: number): Promise<ProbeResult>;
  resolve(host: string): Promise<{ ok: true; address: string } | { ok: false; detail: string }>;
}

export function networkServiceProbes(opts: { allowPrivate?: boolean; fetcher?: IdentityFetcher; timeoutMs?: number } = {}): ServiceProbes {
  return {
    coordinator: (url, hostId, pem) => probeCoordinatorIdentity(url, hostId, pem, opts.fetcher, opts.timeoutMs),
    bitcoind: (host, port, network) => probeBitcoind(host, port, network, opts.timeoutMs),
    lightning: (host, port, nodeId) => probeLightning(host, port, nodeId, opts.timeoutMs),
    electrs: (host, port) => probeElectrum(host, port, opts.timeoutMs),
    resolve: (host) => resolveProbeTarget(host, opts.allowPrivate === true)
  };
}

function validPort(p: unknown, fallback: number): number {
  return typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536 ? p : fallback;
}

/**
 * Probes a remote host's declared services and caches the outcome per host: a pass is kept for
 * `ttlMs` (default 6 h), a failure is retried after `retryMs` (default 15 min), and any change to
 * what the host declares (services, node id, ports, URL) re-probes at once.
 */
export class HostServiceAttestor {
  private readonly cache = new Map<string, { key: string; result: AttestationResult; expiresAtMs: number }>();
  private readonly inflight = new Map<string, Promise<AttestationResult>>();

  constructor(
    private readonly opts: {
      network: BitcoinNetwork;
      probes: ServiceProbes;
      ttlMs?: number;
      retryMs?: number;
      now?: () => number;
    }
  ) {}

  /** Last attestation for a host, if any (status display). */
  peek(hostId: string): AttestationResult | undefined {
    return this.cache.get(hostId)?.result;
  }

  async attest(target: RemoteHostTarget): Promise<AttestationResult> {
    const now = (this.opts.now ?? Date.now)();
    const declared = normalizeServices(target.services);
    const key = JSON.stringify([target.coordinatorUrl, target.publicKeyPem, declared, target.lightningNodeId ?? "", target.ports ?? {}]);
    const hit = this.cache.get(target.hostId);
    if (hit && hit.key === key && hit.expiresAtMs > now) return hit.result;
    const running = this.inflight.get(target.hostId);
    if (running) return running;
    const p = this.run(target, declared, now)
      .then((result) => {
        const allPassed = declared.every((s) => result.attested.includes(s));
        // An unreachable coordinator is retried within a minute: until it passes, no beat counts.
        const ttl = allPassed
          ? this.opts.ttlMs ?? 6 * 3_600_000
          : result.attested.includes("coordinator")
            ? this.opts.retryMs ?? 15 * 60_000
            : Math.min(60_000, this.opts.retryMs ?? 60_000);
        this.cache.set(target.hostId, { key, result, expiresAtMs: now + ttl });
        return result;
      })
      .finally(() => this.inflight.delete(target.hostId));
    this.inflight.set(target.hostId, p);
    return p;
  }

  private async run(target: RemoteHostTarget, declared: string[], now: number): Promise<AttestationResult> {
    const results: Record<string, ProbeResult> = {};
    const probes = this.opts.probes;
    results.coordinator = await probes.coordinator(target.coordinatorUrl, target.hostId, target.publicKeyPem);
    // Without a reachable coordinator that proves the key, nothing else is attributed to this host.
    if (!results.coordinator.ok) return { attested: [], results, atMs: now };
    let hostname: string;
    try {
      hostname = new URL(target.coordinatorUrl).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return { attested: ["coordinator"], results, atMs: now };
    }
    const resolved = await probes.resolve(hostname);
    const ports = target.ports ?? {};
    const checks: Array<Promise<void>> = [];
    const check = (service: HostService, run: (address: string) => Promise<ProbeResult>) => {
      if (!declared.includes(service)) return;
      if (!resolved.ok) {
        results[service] = { ok: false, detail: resolved.detail };
        return;
      }
      checks.push(run(resolved.address).then((r) => void (results[service] = r)));
    };
    check("bitcoind", (a) => probes.bitcoind(a, validPort(ports.bitcoind, BITCOIN_P2P_PORT[this.opts.network]), this.opts.network));
    check("lightning", (a) =>
      isLightningNodeId(target.lightningNodeId) ? probes.lightning(a, validPort(ports.lightning, 9735), target.lightningNodeId) : Promise.resolve({ ok: false, detail: "no_node_id" })
    );
    check("electrs", (a) => probes.electrs(a, validPort(ports.electrs, 50001)));
    await Promise.all(checks);
    const attested = ["coordinator", ...declared.filter((s) => s !== "coordinator" && results[s]?.ok)];
    return { attested: normalizeServices(attested), results, atMs: now };
  }
}

/**
 * A coordinator's own heartbeat: each declared service counts only if the backend this process
 * actually uses answers (local checks injected by the coordinator: Lightning provider, bitcoind
 * RPC, electrs endpoint). "coordinator" is this process.
 */
export async function attestSelfServices(
  declared: string[],
  checks: Partial<Record<Exclude<HostService, "coordinator">, () => Promise<ProbeResult>>>,
  nowMs = Date.now()
): Promise<AttestationResult> {
  const services = normalizeServices(declared);
  const results: Record<string, ProbeResult> = { coordinator: { ok: true, detail: "self" } };
  await Promise.all(
    services
      .filter((s) => s !== "coordinator")
      .map(async (s) => {
        const run = checks[s as Exclude<HostService, "coordinator">];
        try {
          results[s] = run ? await run() : { ok: false, detail: "no_local_check" };
        } catch (err) {
          results[s] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      })
  );
  return { attested: normalizeServices(["coordinator", ...services.filter((s) => results[s]?.ok)]), results, atMs: nowMs };
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The app's Network page: the coordinator's anonymized world view (GET /network/world, through
 * this machine's agent, signed) plus this computer's own round trip to every coordinator in it.
 *
 * "Latency to me" for an agent is then an estimate the app makes: this computer's round trip to
 * the agent's coordinator plus the coordinator's measured round trip to the agent (WebSocket
 * pings). Agents never talk to the app directly, so that sum is also the path work takes.
 *
 * The round trip to a coordinator is timed here (the IDE provider runs on the same computer as
 * the app): two GETs of its public /identity, the faster one counted, so connection setup is left
 * out. Only http(s) URLs from the coordinator's own answer are probed, and only that path.
 *
 * LAN proximity (src/swarm/lan-proximity.ts, docs/security/lan-proximity.md). The coordinator tells
 * this computer's agent (and only it, for its owner's own machines) which of its owner's machines
 * connect from the same public network, and their private addresses. Those inside one of this
 * computer's own subnets are pinged directly (ICMP echo with the OS `ping`: no port is opened, no
 * agent listens on the LAN). A machine that answers is marked `lan.sameNetwork` with its measured
 * round trip; the addresses themselves are not passed on to the page.
 */
import { execFile } from "node:child_process";
import { request } from "undici";
import { localLanAddresses, parseLanCidr, probeableAddresses } from "../../swarm/lan-proximity.js";
import { call, type NetworkDeps } from "./network-inference.js";

export const COORDINATOR_PROBE_TIMEOUT_MS = 2_500;
export const COORDINATOR_PROBE_CACHE_MS = 30_000;
const MAX_PROBED = 16;

/** Round trip to a coordinator in ms, or null when it did not answer. */
export type CoordinatorProbe = (url: string) => Promise<number | null>;

function probeTarget(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return `${u.origin}/identity`;
  } catch {
    return null;
  }
}

/** Two timed GETs of {url}/identity; the faster one (the second reuses the connection). */
export const timedIdentityProbe: CoordinatorProbe = async (url) => {
  const target = probeTarget(url);
  if (!target) return null;
  let best: number | null = null;
  for (let i = 0; i < 2; i++) {
    const started = performance.now();
    try {
      const res = await request(target, { method: "GET", headersTimeout: COORDINATOR_PROBE_TIMEOUT_MS, bodyTimeout: COORDINATOR_PROBE_TIMEOUT_MS, signal: AbortSignal.timeout(COORDINATOR_PROBE_TIMEOUT_MS) });
      await res.body.text();
      if (res.statusCode !== 200) continue;
      const ms = performance.now() - started;
      best = best === null ? ms : Math.min(best, ms);
    } catch {
      // Unreachable from here: no figure.
    }
  }
  return best === null ? null : Math.round(best);
};

const probeCache = new Map<string, { atMs: number; value: Promise<number | null> }>();

function cachedProbe(probe: CoordinatorProbe, url: string, nowMs: number): Promise<number | null> {
  const hit = probeCache.get(url);
  if (hit && nowMs - hit.atMs < COORDINATOR_PROBE_CACHE_MS) return hit.value;
  const value = probe(url).catch(() => null);
  probeCache.set(url, { atMs: nowMs, value });
  while (probeCache.size > 64) probeCache.delete(probeCache.keys().next().value as string);
  return value;
}

/** Tests. */
export function resetCoordinatorProbeCache(): void {
  probeCache.clear();
  lanCache.clear();
}

// ── LAN proximity ──

export const LAN_PROBE_TIMEOUT_S = 2;
export const LAN_PROBE_CACHE_MS = 30_000;
/** At most this many of your machines are probed per refresh. */
export const LAN_MAX_PROBED = 8;

/** Round trip to a LAN address in ms, or null when it did not answer. */
export type LanProbe = (ip: string) => Promise<number | null>;

/** The best round trip in `ping` output (macOS / Linux "min/avg/max", Windows "Minimum = 2ms"). */
export function parsePingMs(out: string): number | null {
  const unix = /min\/avg\/max[^=]*=\s*([\d.]+)\//.exec(out);
  const win = /Minimum\s*=\s*(\d+)\s*ms/i.exec(out);
  const ms = unix ? Number(unix[1]) : win ? Number(win[1]) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms * 10) / 10 : null;
}

/** Three ICMP echoes with the OS `ping` (no shell; the address is a checked private IPv4). */
export const icmpLanProbe: LanProbe = (ip) =>
  new Promise((resolve) => {
    if (!parseLanCidr(`${ip}/24`)) return resolve(null);
    const args =
      process.platform === "win32"
        ? ["-n", "3", "-w", String(LAN_PROBE_TIMEOUT_S * 1000), ip]
        : process.platform === "darwin"
          ? ["-n", "-q", "-c", "3", "-i", "0.2", "-t", String(LAN_PROBE_TIMEOUT_S), ip]
          : ["-n", "-q", "-c", "3", "-i", "0.2", "-w", String(LAN_PROBE_TIMEOUT_S), ip];
    execFile("ping", args, { timeout: (LAN_PROBE_TIMEOUT_S + 1) * 1000, windowsHide: true }, (_err, stdout) => resolve(parsePingMs(String(stdout ?? ""))));
  });

const lanCache = new Map<string, { atMs: number; value: Promise<number | null> }>();

function cachedLanProbe(probe: LanProbe, ip: string, nowMs: number): Promise<number | null> {
  const hit = lanCache.get(ip);
  if (hit && nowMs - hit.atMs < LAN_PROBE_CACHE_MS) return hit.value;
  const value = probe(ip).catch(() => null);
  lanCache.set(ip, { atMs: nowMs, value });
  while (lanCache.size > 64) lanCache.delete(lanCache.keys().next().value as string);
  return value;
}

/** What the page gets for one of your machines: no addresses. */
export interface AgentLanView {
  /** It answered a direct probe from this computer over the local network. */
  sameNetwork: boolean;
  /** Measured round trip from this computer, ms (null: not probed or no answer). */
  rttMs: number | null;
}

/**
 * Which of the coordinator's agents to probe, and where: only the caller's own machines (`mine`)
 * that the coordinator saw on the same public network, not stale, not this computer, with an
 * address inside one of this computer's subnets. Everything else is never probed.
 */
export function lanCandidates(agents: ReadonlyArray<Record<string, unknown>>, selfAgentId: string, localCidrs: readonly string[]): Array<{ index: number; ip: string }> {
  const out: Array<{ index: number; ip: string }> = [];
  agents.forEach((a, index) => {
    if (out.length >= LAN_MAX_PROBED) return;
    if (a.mine !== true || a.name === selfAgentId || a.status === "stale") return;
    const lan = a.lan as { samePublicNetwork?: unknown; addresses?: unknown } | undefined;
    if (!lan || lan.samePublicNetwork !== true || !Array.isArray(lan.addresses)) return;
    const ip = probeableAddresses(lan.addresses as string[], localCidrs)[0];
    if (ip) out.push({ index, ip });
  });
  return out;
}

/**
 * The agents with `lan` replaced by what the page may see: `{ sameNetwork, rttMs }` on the
 * machines probed, nothing on the rest. Private addresses never reach the page.
 */
export async function withLanProximity(
  agents: ReadonlyArray<Record<string, unknown>>,
  selfAgentId: string,
  opts: { probe?: LanProbe; localCidrs?: readonly string[]; nowMs?: number } = {}
): Promise<Array<Record<string, unknown>>> {
  const candidates = lanCandidates(agents, selfAgentId, opts.localCidrs ?? localLanAddresses());
  const probe = opts.probe ?? icmpLanProbe;
  const timed = await Promise.all(candidates.map((c) => cachedLanProbe(probe, c.ip, opts.nowMs ?? Date.now())));
  const byIndex = new Map(candidates.map((c, i) => [c.index, timed[i]]));
  return agents.map((a, i) => {
    const { lan: _lan, ...rest } = a;
    if (!byIndex.has(i)) return rest;
    const ms = byIndex.get(i) ?? null;
    const view: AgentLanView = { sameNetwork: ms !== null, rttMs: ms };
    return { ...rest, lan: view };
  });
}

/**
 * The world view with `myRttMs` on each coordinator (this computer's measured round trip; null when
 * it did not answer). Non-200 answers from the coordinator are passed through as they are.
 */
export async function networkWorld(
  d: NetworkDeps,
  probe: CoordinatorProbe = timedIdentityProbe,
  nowMs = Date.now(),
  lan: { probe?: LanProbe; localCidrs?: readonly string[] } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await call(d, "GET", "/network/world");
  if (r.status !== 200) return r;
  const coordinators = Array.isArray(r.json.coordinators) ? (r.json.coordinators as Array<Record<string, unknown>>) : [];
  // Hosted (transport) callers are not on the user's computer; their timings would be the server's.
  const measure = !d.transport;
  const timed = await Promise.all(
    // Every coordinator listed, also one the answering coordinator could not reach this time: this
    // computer's round trip to it does not depend on that (only its public /identity is timed).
    coordinators.map((c, i) => (measure && i < MAX_PROBED && typeof c.url === "string" ? cachedProbe(probe, c.url, nowMs) : Promise.resolve(null)))
  );
  // LAN probes only from the user's own computer; a hosted caller drops the LAN facts entirely.
  const rawAgents = Array.isArray(r.json.agents) ? (r.json.agents as Array<Record<string, unknown>>) : [];
  const agents = measure ? await withLanProximity(rawAgents, d.agentId, { ...lan, nowMs }) : rawAgents.map(({ lan: _lan, ...rest }) => rest);
  return {
    status: 200,
    json: {
      ...r.json,
      agents,
      coordinators: coordinators.map((c, i) => ({ ...c, myRttMs: timed[i] })),
      latency: {
        measuredFrom: measure ? "this computer" : null,
        note: "Latency to a machine is an estimate: your round trip to its coordinator plus the coordinator's measured round trip to the machine. Your own machines on the same local network are measured directly from this computer."
      }
    }
  };
}

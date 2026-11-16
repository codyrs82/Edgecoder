// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator side of cross-account LAN proximity (docs/security/lan-proximity.md). Pure and in
 * memory; the coordinator keeps one instance (coordinator/lan.ts).
 *
 * - Each agent registers its current rotating LAN ids and their keys over its signed heartbeat.
 *   The registry maps an id to the agent and checks proofs with the key.
 * - Each agent reports the neighbours it sees: { id, p, w, rttMs }. A report counts only with a
 *   fresh, valid proof (lan-discovery.ts checkLanProof): the reporter heard the neighbour's own
 *   announcement in the last few minutes. Ids of agents on another coordinator are checked against
 *   that coordinator's current proofs (shared mesh-only in its LocalWorld, never the key).
 * - Proximity is symmetric (A sees B or B sees A) and the better measurement wins.
 *
 * Nothing here holds an address: the agents never send one.
 */
import { checkLanProof, isLanId, lanProof, lanProofWindow, LAN_PROOF_WINDOWS_ACCEPTED } from "./lan-discovery.js";

/** A registration or a report not refreshed for this long is forgotten. */
export const LAN_REGISTRY_TTL_MS = 5 * 60_000;
/** Neighbour facts are used for routing and the world view while younger than this. */
export const LAN_NEIGHBOUR_FRESH_MS = 5 * 60_000;
export const LAN_MAX_IDS_PER_AGENT = 2;
export const LAN_MAX_REPORTS_PER_AGENT = 16;
/** A round trip above this is not "the same network" (a VPN or a bridged site). */
export const LAN_MAX_RTT_MS = 50;

export interface LanRegistration {
  ids: Array<{ id: string; key: string }>;
  /** The agent has direct transfer on (AGENT_LAN_DIRECT). */
  direct?: boolean;
}

export interface LanReport {
  id: string;
  p: string;
  w: number;
  rttMs: number;
}

interface IdEntry {
  agentId: string;
  key: Buffer;
  atMs: number;
}

interface AgentEntry {
  ids: string[];
  direct: boolean;
  atMs: number;
  /** Raw reports (resolved when used: a neighbour on a peer coordinator is resolved against its proofs). */
  reports: Array<LanReport & { atMs: number; agentId?: string }>;
}

/** Resolves an id + proof of an agent on another coordinator to its agent id (or null). */
export type RemoteLanResolver = (id: string, p: string, w: number) => string | null;

export class LanRegistry {
  private readonly byId = new Map<string, IdEntry>();
  private readonly agents = new Map<string, AgentEntry>();

  /** Register (replace) an agent's LAN ids and keys. Malformed entries are dropped. */
  register(agentId: string, reg: LanRegistration, nowMs: number): void {
    const prev = this.agents.get(agentId);
    for (const id of prev?.ids ?? []) if (this.byId.get(id)?.agentId === agentId) this.byId.delete(id);
    const ids: string[] = [];
    for (const e of (reg.ids ?? []).slice(0, LAN_MAX_IDS_PER_AGENT)) {
      if (!isLanId(e?.id) || typeof e.key !== "string") continue;
      const key = Buffer.from(e.key, "base64");
      if (key.length !== 32) continue;
      // An id another agent holds is not taken over (ids are random; a collision is an attack).
      const owner = this.byId.get(e.id);
      if (owner && owner.agentId !== agentId && nowMs - owner.atMs <= LAN_REGISTRY_TTL_MS) continue;
      this.byId.set(e.id, { agentId, key, atMs: nowMs });
      ids.push(e.id);
    }
    this.agents.set(agentId, { ids, direct: reg.direct === true && ids.length > 0, atMs: nowMs, reports: prev?.reports ?? [] });
  }

  /** Store an agent's neighbour reports (bounded; its own ids dropped). */
  noteReports(agentId: string, reports: readonly LanReport[], nowMs: number): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    const own = new Set(a.ids);
    const out: AgentEntry["reports"] = [];
    for (const r of reports.slice(0, LAN_MAX_REPORTS_PER_AGENT)) {
      if (!isLanId(r?.id) || own.has(r.id) || typeof r.p !== "string" || !Number.isInteger(r.w)) continue;
      if (typeof r.rttMs !== "number" || !Number.isFinite(r.rttMs) || r.rttMs < 0 || r.rttMs > LAN_MAX_RTT_MS) continue;
      const local = this.resolveLocal(r.id, r.p, r.w, nowMs);
      if (local === agentId) continue;
      out.push({ id: r.id, p: r.p, w: r.w, rttMs: Math.round(r.rttMs * 10) / 10, atMs: nowMs, ...(local ? { agentId: local } : {}) });
    }
    a.reports = out;
  }

  /** The agent registered here that holds `id`, when `p` is its fresh proof for window `w`. */
  resolveLocal(id: string, p: string, w: number, nowMs: number): string | null {
    const e = this.byId.get(id);
    if (!e || nowMs - e.atMs > LAN_REGISTRY_TTL_MS) return null;
    return checkLanProof(e.key, id, p, w, nowMs) ? e.agentId : null;
  }

  /** The agent's ids and current proofs (for peers: mesh-only LocalWorld, stripped from every public answer). */
  proofsOf(agentId: string, nowMs: number): Array<{ id: string; p: string[]; w: number }> {
    const a = this.agents.get(agentId);
    if (!a || nowMs - a.atMs > LAN_REGISTRY_TTL_MS) return [];
    const w = lanProofWindow(nowMs);
    return a.ids.flatMap((id) => {
      const e = this.byId.get(id);
      if (!e) return [];
      const p: string[] = [];
      for (let i = 0; i < LAN_PROOF_WINDOWS_ACCEPTED; i++) p.push(lanProof(e.key, id, w - i));
      return [{ id, p, w }];
    });
  }

  /** The agent's current LAN id (the one it announces now), or null. */
  currentLanId(agentId: string, nowMs: number): string | null {
    const a = this.agents.get(agentId);
    return a && nowMs - a.atMs <= LAN_REGISTRY_TTL_MS ? a.ids[0] ?? null : null;
  }

  /** The key the agent registered with `lanId` (tickets for it are MACed with a key derived from it). */
  keyOf(agentId: string, lanId: string, nowMs: number): Buffer | null {
    const e = this.byId.get(lanId);
    return e && e.agentId === agentId && nowMs - e.atMs <= LAN_REGISTRY_TTL_MS ? e.key : null;
  }

  directOn(agentId: string, nowMs: number): boolean {
    const a = this.agents.get(agentId);
    return !!a && a.direct && nowMs - a.atMs <= LAN_REGISTRY_TTL_MS;
  }

  /**
   * Agents on the same LAN as `agentId`, with the best round trip either side measured: those it
   * reported (resolved here or by `remote`) and those that reported it.
   */
  neighboursOf(agentId: string, nowMs: number, remote?: RemoteLanResolver): Map<string, number> {
    const out = new Map<string, number>();
    const put = (id: string, ms: number) => {
      if (id === agentId) return;
      const prev = out.get(id);
      if (prev === undefined || ms < prev) out.set(id, ms);
    };
    const me = this.agents.get(agentId);
    if (me) {
      for (const r of me.reports) {
        if (nowMs - r.atMs > LAN_NEIGHBOUR_FRESH_MS) continue;
        const who = r.agentId ?? remote?.(r.id, r.p, r.w) ?? null;
        if (who) put(who, r.rttMs);
      }
    }
    for (const [other, e] of this.agents) {
      if (other === agentId) continue;
      for (const r of e.reports) if (r.agentId === agentId && nowMs - r.atMs <= LAN_NEIGHBOUR_FRESH_MS) put(other, r.rttMs);
    }
    return out;
  }

  /** Raw reports of an agent (ids, proofs, round trips) for peers to resolve against their own agents. */
  reportsOf(agentId: string, nowMs: number): LanReport[] {
    return (this.agents.get(agentId)?.reports ?? []).filter((r) => nowMs - r.atMs <= LAN_NEIGHBOUR_FRESH_MS).map(({ id, p, w, rttMs }) => ({ id, p, w, rttMs }));
  }

  /**
   * Proximity groups: agents connected by fresh neighbour reports (union-find), each group an
   * opaque number. Agents with no neighbour are in no group.
   */
  groups(nowMs: number): Map<string, number> {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const union = (a: string, b: string) => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    for (const [id, e] of this.agents) for (const r of e.reports) if (r.agentId && nowMs - r.atMs <= LAN_NEIGHBOUR_FRESH_MS) union(id, r.agentId);
    const numbers = new Map<string, number>();
    const out = new Map<string, number>();
    for (const id of [...parent.keys()].sort()) {
      const root = find(id);
      if (!numbers.has(root)) numbers.set(root, numbers.size + 1);
      out.set(id, numbers.get(root)!);
    }
    return out;
  }

  forget(agentId: string): void {
    const a = this.agents.get(agentId);
    for (const id of a?.ids ?? []) if (this.byId.get(id)?.agentId === agentId) this.byId.delete(id);
    this.agents.delete(agentId);
  }

  prune(nowMs: number): void {
    for (const [id, e] of this.byId) if (nowMs - e.atMs > LAN_REGISTRY_TTL_MS) this.byId.delete(id);
    for (const [id, a] of this.agents) if (nowMs - a.atMs > LAN_REGISTRY_TTL_MS) this.agents.delete(id);
  }
}

/** Resolve an id + proof against peers' shared proofs ({ agentId, lanProofs } per agent). */
export function remoteResolverFrom(agents: ReadonlyArray<{ agentId: string; lanProofs?: Array<{ id: string; p: string[]; w: number }> }>): RemoteLanResolver {
  const index = new Map<string, { agentId: string; p: string[]; w: number }>();
  for (const a of agents) for (const lp of a.lanProofs ?? []) if (isLanId(lp.id)) index.set(lp.id, { agentId: a.agentId, p: lp.p, w: lp.w });
  return (id, p, w) => {
    const e = index.get(id);
    if (!e) return null;
    const i = e.w - w;
    return i >= 0 && i < e.p.length && e.p[i] === p ? e.agentId : null;
  };
}

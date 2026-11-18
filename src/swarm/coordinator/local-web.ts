// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Web calls on the owner's own machine, coordinator side (src/web-tool/local-web.ts has the chain).
 *
 *   - Which machine: an agent whose verified owner (agent_ownership) is the chat's account, that
 *     reported local web in a signed heartbeat in the last few minutes, and whose mesh WebSocket
 *     proved its key. The calling agent first (the desktop's own machine), then the most recently seen.
 *   - The frame is signed with this coordinator's identity key and goes only down that socket.
 *   - The answer settles only a command this coordinator sent to that very agent, once; it is
 *     cleaned again before anything uses it. No answer in time: null, and the caller falls back.
 */

import type { SearchResult } from "../../web-tool/brave.js";
import type { FetchedPage } from "../../web-tool/fetch-page.js";
import { cleanLocalPage, cleanLocalResults, createLocalWebFrame, LOCAL_READ_WAIT_MS, LOCAL_SEARCH_WAIT_MS, LOCAL_WEB_REPORT_TTL_MS, type LocalWebCapability, type LocalWebRequest, type LocalWebResult } from "../../web-tool/local-web.js";
import { agentControlConnected, sendAgentControlFrame } from "./model-control.js";

const MAX_PENDING = 2_000;

interface Pending {
  agentId: string;
  accountId: string;
  settle: (r: LocalWebResult | null) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, Pending>();
/** agentId -> what it reported in its last signed heartbeat. */
const reports = new Map<string, LocalWebCapability & { atMs: number }>();

/** A signed heartbeat's localWeb (absent: the agent does none, e.g. an older release). */
export function noteLocalWebReport(agentId: string, cap: LocalWebCapability | undefined, nowMs = Date.now()): void {
  if (!cap || (!cap.search && !cap.read)) reports.delete(agentId);
  else reports.set(agentId, { search: cap.search, read: cap.read, atMs: nowMs });
}

export interface LocalWebDeps {
  /** Owner account per agent (agent_ownership; agent-accounts.ts accountsFor). */
  accountsFor: (agentIds: string[], nowMs: number) => Promise<Map<string, string | null>>;
  connected: (agentId: string) => boolean;
  send: (agentId: string, frame: string) => boolean;
  lastSeenMs: (agentId: string) => number;
  coordinatorId: () => string;
  privateKeyPem: () => string;
  now?: () => number;
}

export class LocalWebRelay {
  constructor(private readonly d: LocalWebDeps) {}
  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** The account's machines that can do `kind` now, best first. */
  async candidates(accountId: string, kind: keyof LocalWebCapability, preferAgentId?: string): Promise<string[]> {
    const now = this.now();
    const ids = [...reports].filter(([id, r]) => r[kind] && now - r.atMs < LOCAL_WEB_REPORT_TTL_MS && this.d.connected(id)).map(([id]) => id);
    if (!ids.length) return [];
    const owners = await this.d.accountsFor(ids, now);
    return ids
      .filter((id) => owners.get(id) === accountId)
      .sort((a, b) => (a === preferAgentId ? -1 : b === preferAgentId ? 1 : this.d.lastSeenMs(b) - this.d.lastSeenMs(a)));
  }

  /** What the account's own machines can do now (status). */
  async available(accountId: string, preferAgentId?: string): Promise<LocalWebCapability> {
    const [search, read] = await Promise.all([this.candidates(accountId, "search", preferAgentId), this.candidates(accountId, "read", preferAgentId)]);
    return { search: search.length > 0, read: read.length > 0 };
  }

  /** Send one command to one agent and wait for its answer (null: undelivered, refused, failed or late). */
  private ask(agentId: string, accountId: string, request: LocalWebRequest, waitMs: number): Promise<LocalWebResult | null> {
    if (pending.size >= MAX_PENDING) return Promise.resolve(null);
    const frame = createLocalWebFrame({ request, agentId, coordinatorId: this.d.coordinatorId(), requestedBy: accountId, privateKeyPem: this.d.privateKeyPem(), nowMs: this.now() });
    return new Promise((resolve) => {
      const id = frame.command.id;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, waitMs);
      timer.unref?.();
      pending.set(id, { agentId, accountId, timer, settle: resolve });
      if (!this.d.send(agentId, JSON.stringify(frame))) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  }

  /** Results from the account's own SearXNG, or null (none, down, late, or nothing found). */
  async search(accountId: string, query: string, count: number, preferAgentId?: string): Promise<SearchResult[] | null> {
    const [agentId] = await this.candidates(accountId, "search", preferAgentId);
    if (!agentId) return null;
    const r = await this.ask(agentId, accountId, { action: "search", args: { query: query.slice(0, 400), count } }, LOCAL_SEARCH_WAIT_MS);
    if (!r || r.status !== "done") return null;
    const results = cleanLocalResults(r.results, count);
    return results.length ? results : null;
  }

  /** A page read by the account's own machine, or null. */
  async read(accountId: string, url: string, preferAgentId?: string): Promise<FetchedPage | null> {
    const [agentId] = await this.candidates(accountId, "read", preferAgentId);
    if (!agentId) return null;
    const r = await this.ask(agentId, accountId, { action: "read", args: { url } }, LOCAL_READ_WAIT_MS);
    if (!r || r.status !== "done") return null;
    return cleanLocalPage(r.page);
  }
}

/** The agent's signed answer (its request proved it is `agentId`). */
export function acceptLocalWebResult(agentId: string, result: LocalWebResult): { ok: boolean; error?: string } {
  const p = pending.get(result.commandId);
  // Only a command this coordinator sent to this very agent, and only once.
  if (!p || p.agentId !== agentId) return { ok: false, error: "unknown_command" };
  pending.delete(result.commandId);
  clearTimeout(p.timer);
  p.settle(result);
  return { ok: true };
}

/** The coordinator's relay (agentCapabilities, ownership rows, the mesh socket, its identity key). */
export function defaultLocalWebDeps(input: Pick<LocalWebDeps, "accountsFor" | "lastSeenMs" | "coordinatorId" | "privateKeyPem">): LocalWebDeps {
  return { ...input, connected: agentControlConnected, send: sendAgentControlFrame };
}

/** Test hook. */
export function resetLocalWebForTests(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  reports.clear();
}

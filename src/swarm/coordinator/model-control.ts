// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Remote model control, coordinator side (src/model/remote-control/protocol.ts has the chain).
 *
 *   - Only the owning account may command an agent: the portal names the account from its session
 *     (service token), and the agent's verified ownership row (verifiedAccountOf) must name the same
 *     account. An agent without an ownership row cannot be controlled at all.
 *   - The command goes down the agent's authenticated mesh WebSocket (a bind that proved the
 *     agent's registered key), signed with this coordinator's identity key; never over an unsigned
 *     bind, never by HTTP to the agent.
 *   - Rate limits per account and per agent; one pull at a time per agent.
 *   - Every command is audited (who, what, when, result): in memory, and in Postgres when there is
 *     one (ollama_rollouts, target_type "model-control").
 */

import { pgStore } from "../../db/store.js";
import { createModelControlFrame, type ModelControlRequest, type ModelControlResult, type ModelControlState } from "../../model/remote-control/protocol.js";

export interface ModelControlTransport {
  /** The agent has an open mesh WebSocket whose bind proved its registered key. */
  connected(agentId: string): boolean;
  send(agentId: string, frame: string): boolean;
}
let transport: ModelControlTransport | undefined;
/** Registered by the mesh WebSocket routes (routes/mesh.ts). */
export function setModelControlTransport(t: ModelControlTransport | undefined): void {
  transport = t;
}
export function agentControlConnected(agentId: string): boolean {
  return transport?.connected(agentId) ?? false;
}
/** Sends a signed owner frame down the agent's authenticated socket (also bot_control: bot-relay.ts). */
export function sendAgentControlFrame(agentId: string, frame: string): boolean {
  return transport?.send(agentId, frame) ?? false;
}

export type AuditStatus = "sent" | "accepted" | "progress" | "done" | "refused" | "failed" | "undelivered" | "expired";
const FINAL: ReadonlySet<AuditStatus> = new Set(["done", "refused", "failed", "undelivered", "expired"]);

export interface AuditEntry {
  commandId: string;
  agentId: string;
  accountId: string;
  action: string;
  /** The command's arguments as JSON (what was asked). */
  args: string;
  status: AuditStatus;
  requestedAtMs: number;
  updatedAtMs: number;
  error?: string;
  message?: string;
  progressPct?: number;
  coordinatorId?: string;
}

/** Commands an account may send per window (all its machines), and per agent. */
export const ACCOUNT_COMMANDS_PER_WINDOW = 30;
export const AGENT_COMMANDS_PER_WINDOW = 12;
export const COMMAND_WINDOW_MS = 10 * 60_000;
/** A refresh (state request) per agent at most this often. */
export const REFRESH_MIN_INTERVAL_MS = 5_000;
/** A command the agent never answered is marked expired after this long (pulls get longer). */
const ANSWER_TIMEOUT_MS = 3 * 60_000;
const PULL_TIMEOUT_MS = 3 * 60 * 60_000;
const AUDIT_PER_AGENT = 50;
/** Reported state larger than this is refused. */
export const MAX_STATE_BYTES = 64 * 1024;

const audit = new Map<string, AuditEntry[]>();
const byCommand = new Map<string, AuditEntry>();
const windows = new Map<string, number[]>();
const lastRefresh = new Map<string, number>();
const states = new Map<string, { state: ModelControlState; atMs: number }>();

/**
 * Agents whose last model report lists `model` as installed (Ollama tags, whatever the agent
 * serves on the network). The "My machines" refusal uses it to tell "none of your machines has it"
 * from "it is installed, but kept off the network and that agent can't run it for you only".
 */
export function agentsReportingInstalled(model: string): string[] {
  const out: string[] = [];
  for (const [agentId, s] of states) if ((s.state.installed ?? []).some((m) => m?.name === model)) out.push(agentId);
  return out;
}

function hits(key: string, nowMs: number): number[] {
  const list = (windows.get(key) ?? []).filter((t) => nowMs - t < COMMAND_WINDOW_MS);
  windows.set(key, list);
  return list;
}

function persist(e: AuditEntry): void {
  if (!pgStore) return;
  void pgStore
    .upsertModelControlAudit({
      commandId: e.commandId,
      agentId: e.agentId,
      action: e.action,
      args: e.args,
      status: e.status,
      accountId: e.accountId,
      requestedAtMs: e.requestedAtMs,
      updatedAtMs: e.updatedAtMs,
      error: [e.error, e.message].filter(Boolean).join(": ").slice(0, 500) || undefined
    })
    .catch(() => undefined);
}

function record(e: AuditEntry): void {
  const list = audit.get(e.agentId) ?? [];
  list.unshift(e);
  while (list.length > AUDIT_PER_AGENT) {
    const dropped = list.pop();
    if (dropped) byCommand.delete(dropped.commandId);
  }
  audit.set(e.agentId, list);
  byCommand.set(e.commandId, e);
  persist(e);
}

function expireStale(nowMs: number): void {
  for (const e of byCommand.values()) {
    if (FINAL.has(e.status)) continue;
    const limit = e.action === "pull" ? PULL_TIMEOUT_MS : ANSWER_TIMEOUT_MS;
    if (nowMs - e.updatedAtMs > limit) {
      e.status = "expired";
      e.updatedAtMs = nowMs;
      persist(e);
    }
  }
}

export type SendDecision =
  | { ok: true; entry: AuditEntry }
  | { ok: false; status: number; error: string; message?: string };

/**
 * Sends one owner command. `ownerAccountId` is the agent's verified account (the caller looked it
 * up); `accountId` is who asks. Every refusal after ownership is audited too.
 */
export function sendModelControlCommand(input: {
  agentId: string;
  accountId: string;
  ownerAccountId: string | null;
  request: ModelControlRequest;
  coordinatorId: string;
  privateKeyPem: string;
  nowMs?: number;
}): SendDecision {
  const nowMs = input.nowMs ?? Date.now();
  // Not the owner, or no verified owner: the same answer, so nobody learns whose machine it is.
  if (!input.ownerAccountId || input.ownerAccountId !== input.accountId) return { ok: false, status: 403, error: "not_your_machine" };
  expireStale(nowMs);
  const { request } = input;
  if (request.action === "refresh") {
    const last = lastRefresh.get(input.agentId) ?? 0;
    if (nowMs - last < REFRESH_MIN_INTERVAL_MS) return { ok: false, status: 429, error: "rate_limited", message: "refresh at most every 5 s" };
  } else {
    const acct = hits(`acct:${input.accountId}`, nowMs);
    const agent = hits(`agent:${input.agentId}`, nowMs);
    if (acct.length >= ACCOUNT_COMMANDS_PER_WINDOW || agent.length >= AGENT_COMMANDS_PER_WINDOW) {
      return { ok: false, status: 429, error: "rate_limited", message: "too many commands; try again in a few minutes" };
    }
    if (request.action === "pull" && (audit.get(input.agentId) ?? []).some((e) => e.action === "pull" && !FINAL.has(e.status))) {
      return { ok: false, status: 409, error: "pull_in_progress" };
    }
  }
  if (!agentControlConnected(input.agentId)) return { ok: false, status: 409, error: "agent_not_connected" };
  const frame = createModelControlFrame({ request, agentId: input.agentId, coordinatorId: input.coordinatorId, requestedBy: input.accountId, privateKeyPem: input.privateKeyPem, nowMs });
  const delivered = transport?.send(input.agentId, JSON.stringify(frame)) ?? false;
  if (request.action === "refresh") {
    lastRefresh.set(input.agentId, nowMs);
    if (!delivered) return { ok: false, status: 409, error: "agent_not_connected" };
    // Refreshes are not audited (they change nothing); the state report is the answer.
    return { ok: true, entry: { commandId: frame.command.id, agentId: input.agentId, accountId: input.accountId, action: "refresh", args: "{}", status: "sent", requestedAtMs: nowMs, updatedAtMs: nowMs } };
  }
  hits(`acct:${input.accountId}`, nowMs).push(nowMs);
  hits(`agent:${input.agentId}`, nowMs).push(nowMs);
  const entry: AuditEntry = {
    commandId: frame.command.id,
    agentId: input.agentId,
    accountId: input.accountId,
    action: request.action,
    args: JSON.stringify(request.args).slice(0, 400),
    status: delivered ? "sent" : "undelivered",
    requestedAtMs: nowMs,
    updatedAtMs: nowMs,
    coordinatorId: input.coordinatorId
  };
  record(entry);
  if (!delivered) return { ok: false, status: 409, error: "agent_not_connected" };
  return { ok: true, entry };
}

/** The agent's report (its signed request already proved it is `agentId`). */
export function acceptModelControlReport(agentId: string, body: { state?: unknown; result?: ModelControlResult }, nowMs = Date.now()): { ok: boolean; error?: string } {
  if (body.state !== undefined) {
    const text = JSON.stringify(body.state);
    if (!body.state || typeof body.state !== "object" || text.length > MAX_STATE_BYTES) return { ok: false, error: "state_too_large" };
    states.set(agentId, { state: body.state as ModelControlState, atMs: nowMs });
  }
  if (body.result) {
    const e = byCommand.get(body.result.commandId);
    // Only a command this coordinator sent to this very agent, and never after it settled.
    if (!e || e.agentId !== agentId) return { ok: false, error: "unknown_command" };
    if (FINAL.has(e.status)) return { ok: true };
    e.status = body.result.status;
    e.updatedAtMs = nowMs;
    if (body.result.error) e.error = body.result.error.slice(0, 80);
    if (body.result.message) e.message = body.result.message.slice(0, 300);
    if (body.result.progressPct !== undefined) e.progressPct = body.result.progressPct;
    if (body.result.status !== "progress") persist(e);
  }
  return { ok: true };
}

export async function machineView(agentId: string, nowMs = Date.now()): Promise<{
  agentId: string;
  connected: boolean;
  state: ModelControlState | null;
  stateAtMs: number | null;
  audit: AuditEntry[];
}> {
  expireStale(nowMs);
  const mem = audit.get(agentId) ?? [];
  let entries = [...mem];
  if (pgStore) {
    try {
      const rows = await pgStore.listModelControlAudit(agentId, 25);
      const seen = new Set(entries.map((e) => e.commandId));
      for (const r of rows) {
        if (seen.has(r.commandId)) continue;
        entries.push({ commandId: r.commandId, agentId: r.agentId, accountId: r.accountId, action: r.action, args: r.args, status: r.status as AuditStatus, requestedAtMs: r.requestedAtMs, updatedAtMs: r.updatedAtMs, error: r.error });
      }
    } catch {
      /* the in-memory log still answers */
    }
  }
  entries = entries.sort((a, b) => b.requestedAtMs - a.requestedAtMs).slice(0, 25);
  const s = states.get(agentId);
  return { agentId, connected: agentControlConnected(agentId), state: s?.state ?? null, stateAtMs: s?.atMs ?? null, audit: entries };
}

/** Test hook. */
export function resetModelControlForTests(): void {
  audit.clear();
  byCommand.clear();
  windows.clear();
  lastRefresh.clear();
  states.clear();
}

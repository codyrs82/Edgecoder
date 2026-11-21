// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * "Code from your phone", coordinator side (src/common/code-relay.ts has the chain), modelled on
 * bot-relay.ts and model-control.ts.
 *
 *   - Snapshots: an agent's own signed report, filed under that agent, kept in memory (the last known
 *     one stays while the Mac is off). The route keeps it only when the snapshot's account is the
 *     agent's verified owner; it is served only to that account.
 *   - Commands: only the owning account (portal service token + accountId, checked against the
 *     verified ownership row), rate limited per account (changes, reads, new sessions), signed with
 *     this coordinator's identity key and sent only down the agent's authenticated mesh WebSocket.
 *   - Results: the agent's signed report settles a command this coordinator sent to that agent; the
 *     portal reads it with the same account that asked (anyone else gets "unknown"). Kept a few minutes.
 *   - Audit: every command sent (account, agent, action, session, project, status, time), never its
 *     text. In memory only (the last AUDIT_PER_AGENT per agent): the only Postgres audit helper is
 *     model control's, whose rows show in the model-control view, and a new table needs a migration.
 */

import { CODE_READ_ACTIONS, MAX_CODE_RESULT_BYTES, MAX_CODE_SNAPSHOT_BYTES, codeRequestTargets, createCodeControlFrame, type CodeControlRequest, type CodeControlResult, type CodeSnapshot } from "../../common/code-relay.js";
import { agentControlConnected, sendAgentControlFrame } from "./model-control.js";

/** Changes (message, approve, cancel, undo, settings…) an account may send per window. */
export const ACCOUNT_CODE_CHANGES_PER_WINDOW = 120;
/** Reads (projects, sessions, a session's snapshot, messages, changes) per account per window. */
export const ACCOUNT_CODE_READS_PER_WINDOW = 600;
export const CODE_COMMAND_WINDOW_MS = 10 * 60_000;
/** New sessions from the phone an account may start per hour (they count as changes too). */
export const ACCOUNT_CODE_CREATES_PER_HOUR = 20;
export const CODE_CREATE_WINDOW_MS = 60 * 60_000;
/** A result is kept this long for the portal to read. */
const RESULT_TTL_MS = 5 * 60_000;
/** A command the agent never answered is reported as expired after this long. */
const ANSWER_TIMEOUT_MS = 60_000;
const MAX_PENDING = 5_000;
const AUDIT_PER_AGENT = 50;

export type CodeAuditStatus = "sent" | "undelivered" | "expired" | CodeControlResult["status"];

export interface CodeAuditEntry {
  commandId: string;
  agentId: string;
  accountId: string;
  action: string;
  sessionId?: string;
  projectId?: string;
  status: CodeAuditStatus;
  requestedAtMs: number;
  updatedAtMs: number;
  error?: string;
}

interface Entry {
  commandId: string;
  agentId: string;
  accountId: string;
  action: string;
  sentAtMs: number;
  result?: CodeControlResult;
  settledAtMs?: number;
}

const snapshots = new Map<string, { snapshot: CodeSnapshot; atMs: number }>();
const commands = new Map<string, Entry>();
const windows = new Map<string, number[]>();
const audit = new Map<string, CodeAuditEntry[]>();
const auditByCommand = new Map<string, CodeAuditEntry>();

function hits(key: string, nowMs: number, windowMs = CODE_COMMAND_WINDOW_MS): number[] {
  const list = (windows.get(key) ?? []).filter((t) => nowMs - t < windowMs);
  if (list.length) windows.set(key, list);
  else windows.delete(key);
  return list;
}
function record(key: string, nowMs: number, windowMs = CODE_COMMAND_WINDOW_MS): void {
  windows.set(key, [...hits(key, nowMs, windowMs), nowMs]);
}

function sweep(nowMs: number): void {
  for (const [id, e] of commands) {
    if (nowMs - (e.settledAtMs ?? e.sentAtMs) > RESULT_TTL_MS) commands.delete(id);
  }
  for (const e of auditByCommand.values()) {
    if (e.status === "sent" && nowMs - e.updatedAtMs > ANSWER_TIMEOUT_MS) {
      e.status = "expired";
      e.updatedAtMs = nowMs;
    }
  }
}

function audited(e: CodeAuditEntry): void {
  const list = audit.get(e.agentId) ?? [];
  list.unshift(e);
  while (list.length > AUDIT_PER_AGENT) {
    const dropped = list.pop();
    if (dropped) auditByCommand.delete(dropped.commandId);
  }
  audit.set(e.agentId, list);
  auditByCommand.set(e.commandId, e);
}

/** The agent's own report (its signed request proved it is `agentId`; the route checked the account). */
export function acceptCodeSnapshot(agentId: string, snapshot: CodeSnapshot, nowMs = Date.now()): { ok: boolean; error?: string } {
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_CODE_SNAPSHOT_BYTES) return { ok: false, error: "snapshot_too_large" };
  snapshots.set(agentId, { snapshot, atMs: nowMs });
  return { ok: true };
}

export function acceptCodeResult(agentId: string, result: CodeControlResult, nowMs = Date.now()): { ok: boolean; error?: string } {
  const e = commands.get(result.commandId);
  // Only a command this coordinator sent to this very agent, and only once.
  if (!e || e.agentId !== agentId) return { ok: false, error: "unknown_command" };
  if (e.result) return { ok: true };
  if (result.data !== undefined && Buffer.byteLength(JSON.stringify(result.data)) > MAX_CODE_RESULT_BYTES) return { ok: false, error: "result_too_large" };
  e.result = { commandId: e.commandId, status: result.status, ...(result.error ? { error: result.error.slice(0, 80) } : {}), ...(result.message ? { message: result.message.slice(0, 300) } : {}), ...(result.data !== undefined ? { data: result.data } : {}) };
  e.settledAtMs = nowMs;
  const a = auditByCommand.get(e.commandId);
  if (a) {
    a.status = result.status;
    a.updatedAtMs = nowMs;
    if (result.error) a.error = result.error.slice(0, 80);
  }
  return { ok: true };
}

/** What the owner's phone sees of one machine (the caller has checked `accountId` owns it). */
export function codeMachineView(agentId: string, accountId: string, nowMs = Date.now()): { agentId: string; connected: boolean; snapshot: CodeSnapshot | null; reportedAtMs: number | null; audit: CodeAuditEntry[] } {
  sweep(nowMs);
  const s = snapshots.get(agentId);
  // A snapshot made for another account (the machine changed hands) is not shown.
  const snapshot = s && s.snapshot.account === accountId ? s.snapshot : null;
  const entries = (audit.get(agentId) ?? []).filter((e) => e.accountId === accountId).slice(0, 25).map((e) => ({ ...e }));
  return { agentId, connected: agentControlConnected(agentId), snapshot, reportedAtMs: snapshot ? (s?.atMs ?? null) : null, audit: entries };
}

export type CodeSendDecision = { ok: true; commandId: string } | { ok: false; status: number; error: string; message?: string };

export function sendCodeCommand(input: {
  agentId: string;
  accountId: string;
  ownerAccountId: string | null;
  request: CodeControlRequest;
  coordinatorId: string;
  privateKeyPem: string;
  nowMs?: number;
}): CodeSendDecision {
  const nowMs = input.nowMs ?? Date.now();
  // Not the owner, or no verified owner: the same answer, so nobody learns whose machine it is.
  if (!input.ownerAccountId || input.ownerAccountId !== input.accountId) return { ok: false, status: 403, error: "not_your_machine" };
  sweep(nowMs);
  const read = CODE_READ_ACTIONS.has(input.request.action);
  const create = input.request.action === "create";
  if (read) {
    if (hits(`read:${input.accountId}`, nowMs).length >= ACCOUNT_CODE_READS_PER_WINDOW) return { ok: false, status: 429, error: "rate_limited", message: "too many requests; try again in a few minutes" };
  } else {
    if (create && hits(`create:${input.accountId}`, nowMs, CODE_CREATE_WINDOW_MS).length >= ACCOUNT_CODE_CREATES_PER_HOUR) return { ok: false, status: 429, error: "rate_limited", message: "too many new sessions; try again later" };
    if (hits(`change:${input.accountId}`, nowMs).length >= ACCOUNT_CODE_CHANGES_PER_WINDOW) return { ok: false, status: 429, error: "rate_limited", message: "too many commands; try again in a few minutes" };
  }
  if (commands.size >= MAX_PENDING) return { ok: false, status: 503, error: "busy" };
  if (!agentControlConnected(input.agentId)) return { ok: false, status: 409, error: "agent_not_connected" };
  const frame = createCodeControlFrame({ request: input.request, agentId: input.agentId, coordinatorId: input.coordinatorId, requestedBy: input.accountId, privateKeyPem: input.privateKeyPem, nowMs });
  const delivered = sendAgentControlFrame(input.agentId, JSON.stringify(frame));
  audited({ commandId: frame.command.id, agentId: input.agentId, accountId: input.accountId, action: input.request.action, ...codeRequestTargets(input.request), status: delivered ? "sent" : "undelivered", requestedAtMs: nowMs, updatedAtMs: nowMs });
  if (!delivered) return { ok: false, status: 409, error: "agent_not_connected" };
  if (read) record(`read:${input.accountId}`, nowMs);
  else {
    record(`change:${input.accountId}`, nowMs);
    if (create) record(`create:${input.accountId}`, nowMs, CODE_CREATE_WINDOW_MS);
  }
  commands.set(frame.command.id, { commandId: frame.command.id, agentId: input.agentId, accountId: input.accountId, action: input.request.action, sentAtMs: nowMs });
  return { ok: true, commandId: frame.command.id };
}

/** One command's state for the account that sent it (null: unknown here, or someone else's). */
export function codeCommandState(commandId: string, accountId: string, nowMs = Date.now()): { status: "sent" | "expired" | CodeControlResult["status"]; result?: CodeControlResult; agentId: string; action: string } | null {
  const e = commands.get(commandId);
  if (!e || e.accountId !== accountId) return null;
  if (e.result) return { status: e.result.status, result: e.result, agentId: e.agentId, action: e.action };
  return { status: nowMs - e.sentAtMs > ANSWER_TIMEOUT_MS ? "expired" : "sent", agentId: e.agentId, action: e.action };
}

/** Test hook. */
export function resetCodeRelayForTests(): void {
  snapshots.clear();
  commands.clear();
  windows.clear();
  audit.clear();
  auditByCommand.clear();
}

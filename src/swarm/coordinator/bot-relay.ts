// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Bots on the web, coordinator side (src/common/bot-relay.ts has the chain).
 *
 *   - Snapshots: an agent's own signed report, filed under that agent, kept in memory (the last
 *     known one stays while the Mac is off). Served only to the agent's verified owning account.
 *   - Commands: only the owning account (portal service token + accountId, checked against the
 *     verified ownership row), rate limited per account and per agent, signed with this
 *     coordinator's identity key and sent only down the agent's authenticated mesh WebSocket.
 *   - Results: the agent's signed report settles a command this coordinator sent to that agent;
 *     the portal reads it with the same account that asked. Kept a few minutes.
 */

import { createBotControlFrame, MAX_RESULT_BYTES, MAX_SNAPSHOT_BYTES, BOT_READ_ACTIONS, type BotControlRequest, type BotControlResult, type BotsSnapshot } from "../../common/bot-relay.js";
import { agentControlConnected, sendAgentControlFrame } from "./model-control.js";

/** Changes (message, pause, settings, approve…) an account may send per window, and per agent. */
export const ACCOUNT_BOT_COMMANDS_PER_WINDOW = 60;
export const AGENT_BOT_COMMANDS_PER_WINDOW = 30;
/** Reads (older messages, runs, memory) per account per window. */
export const ACCOUNT_BOT_READS_PER_WINDOW = 120;
export const BOT_COMMAND_WINDOW_MS = 10 * 60_000;
/** A result is kept this long for the portal to read. */
const RESULT_TTL_MS = 5 * 60_000;
/** A command the agent never answered is reported as expired after this long. */
const ANSWER_TIMEOUT_MS = 60_000;
const MAX_PENDING = 5_000;

interface Entry {
  commandId: string;
  agentId: string;
  accountId: string;
  botId: string;
  action: string;
  sentAtMs: number;
  result?: BotControlResult;
  settledAtMs?: number;
}

const snapshots = new Map<string, { snapshot: BotsSnapshot; atMs: number }>();
const commands = new Map<string, Entry>();
const windows = new Map<string, number[]>();

function hits(key: string, nowMs: number): number[] {
  const list = (windows.get(key) ?? []).filter((t) => nowMs - t < BOT_COMMAND_WINDOW_MS);
  if (list.length) windows.set(key, list);
  else windows.delete(key);
  return list;
}
function record(key: string, nowMs: number): void {
  windows.set(key, [...hits(key, nowMs), nowMs]);
}

function sweep(nowMs: number): void {
  for (const [id, e] of commands) {
    if (nowMs - (e.settledAtMs ?? e.sentAtMs) > RESULT_TTL_MS) commands.delete(id);
  }
}

/** The agent's own report (its signed request proved it is `agentId`). */
export function acceptBotSnapshot(agentId: string, snapshot: BotsSnapshot, nowMs = Date.now()): { ok: boolean; error?: string } {
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) return { ok: false, error: "snapshot_too_large" };
  snapshots.set(agentId, { snapshot, atMs: nowMs });
  return { ok: true };
}

export function acceptBotResult(agentId: string, result: BotControlResult, nowMs = Date.now()): { ok: boolean; error?: string } {
  const e = commands.get(result.commandId);
  // Only a command this coordinator sent to this very agent, and only once.
  if (!e || e.agentId !== agentId) return { ok: false, error: "unknown_command" };
  if (e.result) return { ok: true };
  if (result.data !== undefined && Buffer.byteLength(JSON.stringify(result.data)) > MAX_RESULT_BYTES) return { ok: false, error: "result_too_large" };
  e.result = { commandId: e.commandId, status: result.status, ...(result.error ? { error: result.error.slice(0, 80) } : {}), ...(result.message ? { message: result.message.slice(0, 300) } : {}), ...(result.data !== undefined ? { data: result.data } : {}) };
  e.settledAtMs = nowMs;
  return { ok: true };
}

/** What the owner's portal sees of one machine (the caller has checked the account owns it). */
export function botMachineView(agentId: string): { agentId: string; connected: boolean; snapshot: BotsSnapshot | null; reportedAtMs: number | null } {
  const s = snapshots.get(agentId);
  return { agentId, connected: agentControlConnected(agentId), snapshot: s?.snapshot ?? null, reportedAtMs: s?.atMs ?? null };
}

export type BotSendDecision = { ok: true; commandId: string } | { ok: false; status: number; error: string; message?: string };

export function sendBotCommand(input: {
  agentId: string;
  botId: string;
  accountId: string;
  ownerAccountId: string | null;
  request: BotControlRequest;
  coordinatorId: string;
  privateKeyPem: string;
  nowMs?: number;
}): BotSendDecision {
  const nowMs = input.nowMs ?? Date.now();
  // Not the owner, or no verified owner: the same answer, so nobody learns whose machine it is.
  if (!input.ownerAccountId || input.ownerAccountId !== input.accountId) return { ok: false, status: 403, error: "not_your_machine" };
  sweep(nowMs);
  const read = BOT_READ_ACTIONS.has(input.request.action);
  if (read) {
    if (hits(`read:${input.accountId}`, nowMs).length >= ACCOUNT_BOT_READS_PER_WINDOW) return { ok: false, status: 429, error: "rate_limited", message: "too many requests; try again in a few minutes" };
  } else if (hits(`acct:${input.accountId}`, nowMs).length >= ACCOUNT_BOT_COMMANDS_PER_WINDOW || hits(`agent:${input.agentId}`, nowMs).length >= AGENT_BOT_COMMANDS_PER_WINDOW) {
    return { ok: false, status: 429, error: "rate_limited", message: "too many commands; try again in a few minutes" };
  }
  if (commands.size >= MAX_PENDING) return { ok: false, status: 503, error: "busy" };
  if (!agentControlConnected(input.agentId)) return { ok: false, status: 409, error: "agent_not_connected" };
  const frame = createBotControlFrame({ request: input.request, botId: input.botId, agentId: input.agentId, coordinatorId: input.coordinatorId, requestedBy: input.accountId, privateKeyPem: input.privateKeyPem, nowMs });
  if (!sendAgentControlFrame(input.agentId, JSON.stringify(frame))) return { ok: false, status: 409, error: "agent_not_connected" };
  if (read) record(`read:${input.accountId}`, nowMs);
  else {
    record(`acct:${input.accountId}`, nowMs);
    record(`agent:${input.agentId}`, nowMs);
  }
  commands.set(frame.command.id, { commandId: frame.command.id, agentId: input.agentId, accountId: input.accountId, botId: input.botId, action: input.request.action, sentAtMs: nowMs });
  return { ok: true, commandId: frame.command.id };
}

/** One command's state for the account that sent it (null: unknown here, or someone else's). */
export function botCommandState(commandId: string, accountId: string, nowMs = Date.now()): { status: "sent" | "expired" | BotControlResult["status"]; result?: BotControlResult; agentId: string; botId: string; action: string } | null {
  const e = commands.get(commandId);
  if (!e || e.accountId !== accountId) return null;
  if (e.result) return { status: e.result.status, result: e.result, agentId: e.agentId, botId: e.botId, action: e.action };
  return { status: nowMs - e.sentAtMs > ANSWER_TIMEOUT_MS ? "expired" : "sent", agentId: e.agentId, botId: e.botId, action: e.action };
}

/** Test hook. */
export function resetBotRelayForTests(): void {
  snapshots.clear();
  commands.clear();
  windows.clear();
}

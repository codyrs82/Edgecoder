// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coding sessions driven from the owner's phone ("Code from your phone"), modelled on the bots relay
 * (src/common/bot-relay.ts). The Mac's half is src/apps/ide/code-remote.ts.
 *
 * Publishing (Mac -> phone):
 *   provider (/v1/ide/code/remote/snapshot?account=, IDE token) <- this machine's agent polls it for
 *   the account the coordinator says owns this machine, and sends the snapshot (trusted projects by
 *   opaque projectId, visible sessions) to its coordinator on change and on a heartbeat (signed agent
 *   request). The coordinator keeps it only when that account is the machine's verified owner, and
 *   serves it only to that account.
 *
 * Commands (phone -> Mac), the same chain as bots on the web:
 *   phone -> portal (session, accountId = acct-<user>) -> coordinator (verified ownership row names
 *   the account; rate limits; audit) -> agent (a code_control frame signed by the coordinator's
 *   identity key, down the agent's authenticated mesh WebSocket; pinned key, own agent id, 2-minute
 *   lifetime, replay cache; AGENT_CODE_RELAY; local rate limits) -> provider
 *   (/v1/ide/code/remote/command, IDE token; the account signed in on the Mac must be the one that
 *   asked; trusted folders only; the session's remote rules; Auto mode is set on the Mac only).
 *   The agent reports each result back with a signed request; the portal polls for it, and only the
 *   account that asked can read it.
 *
 * No request names a path: projects are opaque 16-hex ids, sessions are UUIDs, and every action's
 * arguments are a strict schema (an unknown field, such as `path` or `cwd`, is refused).
 * AGENT_CODE_RELAY: off (default) publishes nothing and takes no command; view publishes snapshots
 * only (no command, reads included); on also takes commands. AGENT_REMOTE_CONTROL=off caps it at view.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { signPayload, verifyPayload } from "../mesh/peer.js";
import { canonicalJson, CommandReplayGuard } from "../model/remote-control/protocol.js";
import { MAX_PAGE_MESSAGES, MAX_RESULT_BYTES, MAX_SNAPSHOT_BYTES } from "./bot-relay.js";

export { CommandReplayGuard };

export const CODE_CONTROL_FRAME_TYPE = "code_control";
export const CODE_CONTROL_VERSION = 1;
export const CODE_CONTROL_MAX_LIFETIME_MS = 2 * 60_000;
export const CODE_CONTROL_MAX_FUTURE_SKEW_MS = 60_000;

/** A whole published snapshot (the provider already fits it to this). */
export const MAX_CODE_SNAPSHOT_BYTES = MAX_SNAPSHOT_BYTES;
/** A command result's data (a session snapshot, a page of messages, a turn's file changes). */
export const MAX_CODE_RESULT_BYTES = MAX_RESULT_BYTES;
export const MAX_CODE_PROJECTS = 200;
export const MAX_CODE_SESSIONS = 50;

export type CodeRelayControls = "on" | "view";
export type CodeRelayMode = "off" | CodeRelayControls;

// ---- Snapshot ----

export interface CodeProject {
  projectId: string;
  name: string;
  parent: string;
  branch?: string;
}

/** One visible session's summary (src/apps/ide/code-remote.ts RemoteSessionSummary). */
export interface CodeSessionSummary {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  [k: string]: unknown;
}

export interface CodeSnapshot {
  v: 1;
  /** The Mac's name as its owner sees it ("MAW-MB-02"). */
  machineName: string;
  /** on: the phone may drive sessions; view: it sees them only. */
  controls: CodeRelayControls;
  /** The account the snapshot is for (the coordinator keeps it only if this is the verified owner). */
  account: string;
  generatedAtMs: number;
  projects: CodeProject[];
  sessions: CodeSessionSummary[];
}

// ---- Commands ----

export const projectIdSchema = z.string().regex(/^[0-9a-f]{16}$/);
const sessionId = z.string().uuid();
const turnId = z.string().uuid();
// "auto" passes the schema only so the Mac can refuse it with a clear message (Auto is set on the Mac).
const mode = z.enum(["ask", "auto-edits", "plan", "auto"]);
const model = z.string().min(1).max(200);

/** Every action of code-remote.ts, with its arguments (never `requestedBy`: the frame names it). */
export const CODE_CONTROL_ACTIONS = ["projects", "sessions", "snapshot", "changes", "messages", "create", "message", "approve", "cancel", "undo", "plan", "settings", "unqueue"] as const;
export type CodeControlAction = (typeof CODE_CONTROL_ACTIONS)[number];
/** Actions that only read (their own, larger rate limit). */
export const CODE_READ_ACTIONS: ReadonlySet<CodeControlAction> = new Set(["projects", "sessions", "snapshot", "changes", "messages"]);

const none = z.object({}).strict().default({});
/** Strict throughout: no field an action doesn't name (no paths, ever). */
export const codeControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("projects"), args: none }).strict(),
  z.object({ action: z.literal("sessions"), args: none }).strict(),
  z.object({ action: z.literal("snapshot"), args: z.object({ sessionId }).strict() }).strict(),
  z.object({ action: z.literal("changes"), args: z.object({ sessionId, turnId }).strict() }).strict(),
  z.object({ action: z.literal("messages"), args: z.object({ sessionId, beforeId: z.string().uuid().optional(), limit: z.number().int().min(1).max(MAX_PAGE_MESSAGES).optional() }).strict() }).strict(),
  z.object({ action: z.literal("create"), args: z.object({ projectId: projectIdSchema, title: z.string().max(120).optional(), model: model.optional(), mode: mode.optional() }).strict() }).strict(),
  z.object({ action: z.literal("message"), args: z.object({ sessionId, text: z.string().min(1).max(32_000) }).strict() }).strict(),
  z.object({ action: z.literal("approve"), args: z.object({ sessionId, callId: z.string().min(1).max(200), approved: z.boolean() }).strict() }).strict(),
  z.object({ action: z.literal("cancel"), args: z.object({ sessionId }).strict() }).strict(),
  z.object({ action: z.literal("undo"), args: z.object({ sessionId, turnId: turnId.optional() }).strict() }).strict(),
  z.object({ action: z.literal("plan"), args: z.object({ sessionId, mode: z.enum(["ask", "auto-edits"]).optional() }).strict() }).strict(),
  z.object({ action: z.literal("settings"), args: z.object({ sessionId, title: z.string().max(120).optional(), model: model.optional(), mode: mode.optional() }).strict() }).strict(),
  z.object({ action: z.literal("unqueue"), args: z.object({ sessionId, queuedId: z.string().uuid() }).strict() }).strict()
]);
export type CodeControlRequest = z.infer<typeof codeControlRequestSchema>;

/** The session and project a request names (for the audit log; never its text). */
export function codeRequestTargets(request: CodeControlRequest): { sessionId?: string; projectId?: string } {
  const a = request.args as { sessionId?: string; projectId?: string };
  return { ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(a.projectId ? { projectId: a.projectId } : {}) };
}

export interface CodeControlCommand {
  v: typeof CODE_CONTROL_VERSION;
  id: string;
  agentId: string;
  coordinatorId: string;
  /** The owning account the coordinator verified (acct-<userId>). */
  requestedBy: string;
  issuedAtMs: number;
  expiresAtMs: number;
  action: CodeControlAction;
  args: Record<string, unknown>;
}

export interface CodeControlFrame {
  type: typeof CODE_CONTROL_FRAME_TYPE;
  command: CodeControlCommand;
  signature: string;
}

export function codeControlSigningPayload(command: CodeControlCommand): string {
  return `edgecoder-code-control-v1\n${canonicalJson(command)}`;
}

export function createCodeControlFrame(input: {
  request: CodeControlRequest;
  agentId: string;
  coordinatorId: string;
  requestedBy: string;
  privateKeyPem: string;
  nowMs?: number;
  id?: string;
}): CodeControlFrame {
  const issuedAtMs = input.nowMs ?? Date.now();
  const command: CodeControlCommand = {
    v: CODE_CONTROL_VERSION,
    id: input.id ?? randomUUID(),
    agentId: input.agentId,
    coordinatorId: input.coordinatorId,
    requestedBy: input.requestedBy,
    issuedAtMs,
    expiresAtMs: issuedAtMs + CODE_CONTROL_MAX_LIFETIME_MS,
    action: input.request.action,
    args: input.request.args as Record<string, unknown>
  };
  return { type: CODE_CONTROL_FRAME_TYPE, command, signature: signPayload(codeControlSigningPayload(command), input.privateKeyPem) };
}

const commandShape = z
  .object({
    v: z.literal(CODE_CONTROL_VERSION),
    id: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/),
    agentId: z.string().min(1).max(128),
    coordinatorId: z.string().min(1).max(256),
    requestedBy: z.string().min(1).max(160),
    issuedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
    action: z.enum(CODE_CONTROL_ACTIONS),
    args: z.record(z.string(), z.unknown())
  })
  .strict();

export type CodeFrameVerdict =
  | { ok: true; command: CodeControlCommand; request: CodeControlRequest }
  | { ok: false; reason: "malformed" | "no_verified_coordinator" | "wrong_coordinator" | "invalid_signature" | "wrong_agent" | "expired" | "from_future" | "lifetime_too_long" | "replayed" | "replay_cache_full" | "invalid_request" };

/** The agent's check of a code_control frame (the same rules as verifyBotControlFrame). */
export function verifyCodeControlFrame(
  frame: unknown,
  ctx: { agentId: string; coordinator: { peerId: string; publicKeyPem: string } | null; replay: CommandReplayGuard; nowMs?: number }
): CodeFrameVerdict {
  const f = frame as Partial<CodeControlFrame> | null;
  if (!f || typeof f !== "object" || f.type !== CODE_CONTROL_FRAME_TYPE || typeof f.signature !== "string") return { ok: false, reason: "malformed" };
  const parsed = commandShape.safeParse(f.command);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const command = parsed.data as CodeControlCommand;
  if (!ctx.coordinator) return { ok: false, reason: "no_verified_coordinator" };
  if (command.coordinatorId !== ctx.coordinator.peerId) return { ok: false, reason: "wrong_coordinator" };
  if (!verifyPayload(codeControlSigningPayload(f.command as CodeControlCommand), f.signature, ctx.coordinator.publicKeyPem)) return { ok: false, reason: "invalid_signature" };
  if (command.agentId !== ctx.agentId) return { ok: false, reason: "wrong_agent" };
  const now = ctx.nowMs ?? Date.now();
  if (command.issuedAtMs > now + CODE_CONTROL_MAX_FUTURE_SKEW_MS) return { ok: false, reason: "from_future" };
  if (command.expiresAtMs - command.issuedAtMs > CODE_CONTROL_MAX_LIFETIME_MS || command.expiresAtMs < command.issuedAtMs) return { ok: false, reason: "lifetime_too_long" };
  if (now > command.expiresAtMs) return { ok: false, reason: "expired" };
  const request = codeControlRequestSchema.safeParse({ action: command.action, args: command.args });
  if (!request.success) return { ok: false, reason: "invalid_request" };
  const fresh = ctx.replay.accept(command.id, command.expiresAtMs, now);
  if (fresh === "full") return { ok: false, reason: "replay_cache_full" };
  if (!fresh) return { ok: false, reason: "replayed" };
  return { ok: true, command, request: request.data };
}

/** One command's outcome, reported by the agent. */
export interface CodeControlResult {
  commandId: string;
  status: "done" | "refused" | "failed";
  error?: string;
  message?: string;
  data?: unknown;
}

/** AGENT_CODE_RELAY: off (default) does nothing; view publishes snapshots only; on also takes commands. */
export function codeRelayMode(value: string | undefined, remoteControl: boolean): CodeRelayMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "view") return "view";
  if (v === "on" || v === "1" || v === "true" || v === "yes") return remoteControl ? "on" : "view";
  return "off";
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The provider's side of coding sessions driven from the user's phone (the iOS app), modelled on
 * bot-remote.ts. This file is only the Mac's half: no network path reaches it yet.
 *
 *   GET  /v1/ide/code/remote/snapshot?account=<id>          { projects, sessions } for that account
 *   POST /v1/ide/code/remote/command   { requestedBy, action, ...args }   one command from the phone
 *
 * Both sit behind the provider's IDE token and loopback guard like every /v1/ide route. Nothing is
 * answered unless the account signed in on this Mac is the account that asked.
 *
 * What the phone can reach:
 *   - projects: only folders trusted on this Mac or used in its Code view (workspace-trust.ts), named by an opaque projectId
 *     (salted per machine) and folder names. No request carries a path and no answer contains one:
 *     the project folder and the home folder are replaced in every string that leaves.
 *   - sessions: only those owned by that account, in a folder that is still open to the phone, and
 *     started from the phone, published by the Mac, or mirroring a desktop Code view chat
 *     (desktop-chats.ts). A turn the desktop app runs itself shows live; the phone may stop it and
 *     answer its approvals, but only those a phone turn could approve (sessions.ts remoteMayApprove).
 * What a session started or driven from the phone may do is in sessions.ts (remoteDecision): every
 * command that isn't read-only asks, paths outside the project are refused, and approving from the
 * phone never adds an "always allow" rule or turns on auto-edits. Auto and Full access are set on the
 * Mac only; a phone turn in a Full access session runs as Accept edits under the remote rules.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MAX_PAGE_MESSAGES, MAX_RESULT_BYTES, MAX_SNAPSHOT_BYTES, PAGE_MESSAGE_CHARS, SNAPSHOT_MESSAGE_CHARS, SNAPSHOT_TAIL_MESSAGES,
  capMessage, toolCallDetail, toolSteps, type RemoteToolStep,
} from "../../common/bot-relay.js";
import type { CheckpointStore } from "./checkpoints.js";
import { modelIdOf, SessionError, type ClientKind, type ClientRef, type SessionData, type SessionHub, type TranscriptEntry } from "./sessions.js";
import { isProjectOpenToPhone, listTrustedProjects, projectIdOf, trustedRootForId, type TrustedProject } from "./workspace-trust.js";

/** A pending command longer than this is shown cut and must be approved on the Mac. */
export const MAX_APPROVABLE_COMMAND_BYTES = 4 * 1024;
export const MAX_REMOTE_SESSIONS = 50;
const MAX_CHANGE_FILE_CHARS = 32_000;
const MAX_CHANGED_FILES = 50;

export interface RemoteSessionSummary {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  branch: string | null;
  model: string;
  mode: SessionData["mode"];
  origin: ClientKind;
  published: boolean;
  running: boolean;
  pending: number;
  queued: number;
  messages: number;
  cSats: number;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteMessage {
  id: string;
  role: TranscriptEntry["role"];
  content: string;
  at: number;
  by?: ClientKind;
  turnId?: string;
  changedFiles?: string[];
  undone?: boolean;
  plan?: boolean;
  steps?: RemoteToolStep[];
}

export interface RemotePendingApproval {
  callId: string;
  tool: string;
  /** One line: the file, the commit message (the command for run_shell is in `command`). */
  detail: string;
  /** run_shell: the whole command (up to MAX_APPROVABLE_COMMAND_BYTES; cut beyond and `approvable` false). */
  command?: string;
  /** False: the phone shows it but can't approve it ("approve on the Mac"). */
  approvable: boolean;
  message?: string;
}

export interface RemoteSessionSnapshot {
  session: RemoteSessionSummary;
  seq: number;
  running: { turnId: string; text: string; steps: RemoteToolStep[] } | null;
  pending: RemotePendingApproval[];
  queue: Array<{ id: string; text: string; by: ClientKind; label?: string; at: number }>;
  tail: RemoteMessage[];
}

export interface CodeRemoteSnapshot {
  v: 1;
  generatedAtMs: number;
  projects: TrustedProject[];
  sessions: RemoteSessionSummary[];
}

// ---- Keeping paths on the Mac ----

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` with the project folder shown as "<project>" and the home folder as "~". */
export function scrubPaths(text: string, root: string): string {
  let out = text;
  let real = root;
  try {
    real = root ? realpathSync(root) : root;
  } catch {
    // a folder that's gone: its spelling is all there is
  }
  // macOS: /var, /tmp and /etc are /private/... underneath; text may use either spelling.
  const spellings = [root, real, ...[root, real].filter((r) => r.startsWith("/private/")).map((r) => r.slice("/private".length))];
  const roots = [...new Set(spellings.map((r) => r.replace(/\/+$/, "")))].filter((x) => x.length > 1).sort((a, b) => b.length - a.length);
  for (const r of roots) out = out.replace(new RegExp(`${escapeRe(r)}(?=/|\\b|$)`, "g"), "<project>");
  const home = homedir().replace(/\/+$/, "");
  if (home.length > 1) out = out.replace(new RegExp(`${escapeRe(home)}(?=/|\\b|$)`, "g"), "~");
  return out;
}

function cap(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

// ---- What the phone sees ----

function projectName(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? "";
}

/** The sessions `account` may see from its phone: its own, in a folder open to it, phone-started, published or a desktop chat. */
function visible(hub: SessionHub, account: string): SessionData[] {
  const out: SessionData[] = [];
  for (const summary of hub.list()) {
    const s = hub.peek(summary.id);
    if (!s || s.ownerAccount !== account) continue;
    if (s.origin !== "remote" && !s.published && !s.chatId) continue;
    if (!isProjectOpenToPhone(s.projectRoot)) continue;
    out.push(s);
  }
  return out;
}

function summaryOf(hub: SessionHub, s: SessionData, salt: string): RemoteSessionSummary {
  const snap = hub.snapshot(s.id);
  return {
    id: s.id,
    title: scrubPaths(cap(s.title, 120), s.projectRoot),
    projectId: projectIdOf(s.projectRoot, salt),
    projectName: projectName(s.projectRoot),
    branch: s.branch,
    model: modelIdOf(s),
    mode: s.mode,
    origin: s.origin,
    published: s.published,
    running: !!snap.running,
    pending: snap.pending.length,
    queued: snap.queue.length,
    messages: s.transcript.length,
    cSats: s.cSats,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function scrubSteps(steps: RemoteToolStep[], root: string): RemoteToolStep[] {
  return steps.map((st) => ({ ...st, detail: scrubPaths(st.detail, root) }));
}

function messageOf(e: TranscriptEntry, root: string, pendingIds: ReadonlySet<string>, chars: number): RemoteMessage {
  const steps = e.events ? scrubSteps(toolSteps(e.events as never, pendingIds), root) : [];
  return capMessage({
    id: e.id,
    role: e.role,
    content: scrubPaths(e.content ?? "", root),
    at: e.at,
    ...(e.by ? { by: e.by } : {}),
    ...(e.turnId ? { turnId: e.turnId } : {}),
    ...(e.changedFiles?.length ? { changedFiles: e.changedFiles.slice(0, MAX_CHANGED_FILES).map((f) => scrubPaths(f, root)) } : {}),
    ...(e.undone ? { undone: true } : {}),
    ...(e.plan ? { plan: true } : {}),
    ...(steps.length ? { steps } : {}),
  }, chars);
}

const ON_MAC = "This one runs outside what the phone may approve. Approve it on the Mac.";

function pendingOf(p: { id: string; tool: string; args: Record<string, unknown> }, root: string, mayApprove = true): RemotePendingApproval {
  if (!mayApprove) {
    const command = p.tool === "run_shell" && typeof p.args.command === "string" ? { command: scrubPaths(Buffer.from(p.args.command).subarray(0, MAX_APPROVABLE_COMMAND_BYTES).toString("utf8"), root) } : {};
    return { callId: p.id, tool: p.tool, detail: scrubPaths(toolCallDetail(p.tool, p.args), root), ...command, approvable: false, message: ON_MAC };
  }
  if (p.tool === "run_shell") {
    const command = typeof p.args.command === "string" ? p.args.command : "";
    const bytes = Buffer.from(command);
    if (bytes.length > MAX_APPROVABLE_COMMAND_BYTES) {
      return {
        callId: p.id, tool: p.tool, detail: scrubPaths(toolCallDetail(p.tool, p.args), root),
        command: scrubPaths(bytes.subarray(0, MAX_APPROVABLE_COMMAND_BYTES).toString("utf8"), root),
        approvable: false, message: "This command is too long to check on the phone. Approve it on the Mac.",
      };
    }
    return { callId: p.id, tool: p.tool, detail: scrubPaths(toolCallDetail(p.tool, p.args), root), command: scrubPaths(command, root), approvable: true };
  }
  return { callId: p.id, tool: p.tool, detail: scrubPaths(toolCallDetail(p.tool, p.args), root), approvable: true };
}

function tooLongToApprove(p: { tool: string; args: Record<string, unknown> }): boolean {
  return p.tool === "run_shell" && Buffer.byteLength(typeof p.args.command === "string" ? p.args.command : "") > MAX_APPROVABLE_COMMAND_BYTES;
}

export function remoteSessionSnapshot(hub: SessionHub, s: SessionData, salt: string): RemoteSessionSnapshot {
  const snap = hub.snapshot(s.id);
  const root = s.projectRoot;
  const pendingIds = new Set(snap.pending.map((p) => p.id));
  const build = (keep: number, chars: number): RemoteSessionSnapshot => ({
    session: summaryOf(hub, s, salt),
    seq: snap.seq,
    running: snap.running
      ? { turnId: snap.running.turnId, text: scrubPaths(cap(snap.running.text, chars * 2), root), steps: scrubSteps(toolSteps(snap.running.events as never, pendingIds), root) }
      : null,
    pending: snap.pending.map((p) => pendingOf(p, root, hub.remoteMayApprove(s.id, p.id))),
    queue: snap.queue.map((q) => ({ id: q.id, text: scrubPaths(cap(q.text, 2_000), root), by: q.by, ...(q.label ? { label: q.label.slice(0, 80) } : {}), at: q.at })),
    tail: keep ? s.transcript.slice(-keep).map((e) => messageOf(e, root, pendingIds, chars)) : [],
  });
  for (const [keep, chars] of [[SNAPSHOT_TAIL_MESSAGES, SNAPSHOT_MESSAGE_CHARS], [6, 2_000], [3, 1_000], [1, 500], [0, 200]] as const) {
    const out = build(keep, chars);
    if (Buffer.byteLength(JSON.stringify(out)) <= MAX_RESULT_BYTES || keep === 0) return out;
  }
  return build(0, 200);
}

/** The phone's overview: the trusted projects and the sessions `account` may see. */
export function codeRemoteSnapshot(hub: SessionHub, account: string, salt: string, branch?: (root: string) => string | null, now = Date.now()): CodeRemoteSnapshot {
  const projects = listTrustedProjects(salt, branch).slice(0, 200);
  let sessions = visible(hub, account).slice(0, MAX_REMOTE_SESSIONS).map((s) => summaryOf(hub, s, salt));
  const size = () => Buffer.byteLength(JSON.stringify({ projects, sessions }));
  while (sessions.length && size() > MAX_SNAPSHOT_BYTES) sessions = sessions.slice(0, -1);
  return { v: 1, generatedAtMs: now, projects, sessions };
}

/** Keeps a read's data within MAX_RESULT_BYTES (drops the oldest items first). */
function fitList<T>(items: T[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  let list = items;
  while (list.length > 1 && Buffer.byteLength(JSON.stringify({ items: list, ...extra })) > MAX_RESULT_BYTES) list = list.slice(1);
  return { items: list, ...extra, ...(list.length < items.length ? { truncated: true } : {}) };
}

// ---- Commands ----

const account = z.string().min(1).max(160);
const sessionId = z.string().uuid();
const turnId = z.string().uuid();
// "auto" and "full" are accepted by the schema only to be refused with a clear message (both are set on the Mac).
const remoteMode = z.enum(["ask", "auto-edits", "plan", "auto", "full"]);
const model = z.string().min(1).max(200);

/** Every command, flat: { requestedBy, action, ...args }. Strict: no field the action doesn't name (no paths, ever). */
export const codeRemoteCommandSchema = z.discriminatedUnion("action", [
  z.object({ requestedBy: account, action: z.literal("projects") }).strict(),
  z.object({ requestedBy: account, action: z.literal("sessions") }).strict(),
  z.object({ requestedBy: account, action: z.literal("snapshot"), sessionId }).strict(),
  z.object({ requestedBy: account, action: z.literal("changes"), sessionId, turnId }).strict(),
  z.object({ requestedBy: account, action: z.literal("messages"), sessionId, beforeId: z.string().uuid().optional(), limit: z.number().int().min(1).max(MAX_PAGE_MESSAGES).optional() }).strict(),
  z.object({ requestedBy: account, action: z.literal("create"), projectId: z.string().regex(/^[0-9a-f]{16}$/), title: z.string().max(120).optional(), model: model.optional(), mode: remoteMode.default("ask") }).strict(),
  z.object({ requestedBy: account, action: z.literal("message"), sessionId, text: z.string().min(1).max(32_000) }).strict(),
  z.object({ requestedBy: account, action: z.literal("approve"), sessionId, callId: z.string().min(1).max(200), approved: z.boolean() }).strict(),
  z.object({ requestedBy: account, action: z.literal("cancel"), sessionId }).strict(),
  z.object({ requestedBy: account, action: z.literal("undo"), sessionId, turnId: turnId.optional() }).strict(),
  z.object({ requestedBy: account, action: z.literal("plan"), sessionId, mode: z.enum(["ask", "auto-edits"]).default("auto-edits") }).strict(),
  z.object({ requestedBy: account, action: z.literal("settings"), sessionId, title: z.string().max(120).optional(), model: model.optional(), mode: remoteMode.optional() }).strict(),
  z.object({ requestedBy: account, action: z.literal("unqueue"), sessionId, queuedId: z.string().uuid() }).strict(),
]);
export type CodeRemoteCommand = z.infer<typeof codeRemoteCommandSchema>;

export interface CodeRemoteOutcome {
  status: "done" | "refused" | "failed";
  error?: string;
  message?: string;
  data?: unknown;
}

export interface CodeRemoteDeps {
  /** The EdgeCoder account signed in on this computer (null: unknown, so nothing from the phone runs). */
  account: () => Promise<string | null>;
  /** Each turn's file changes (the provider's CheckpointStore). */
  checkpoints: Pick<CheckpointStore, "changes">;
  /** This computer's salt for project ids (workspace-trust.ts loadOrCreateMachineSalt). */
  machineSalt: () => string;
  /** A folder's current branch (null outside git). */
  branch?: (root: string) => string | null;
}

const AUTO_REFUSED: CodeRemoteOutcome = { status: "refused", error: "auto_on_mac", message: "Auto mode is turned on from the Mac." };
const FULL_REFUSED: CodeRemoteOutcome = { status: "refused", error: "full_on_mac", message: "Full access is turned on from the Mac." };
const NO_SESSION: CodeRemoteOutcome = { status: "refused", error: "no_such_session", message: "No such session on this Mac." };

/** The phone's client: every write from it is labelled and judged as remote (sessions.ts). */
export function phoneClient(accountId: string): ClientRef {
  return { clientId: "remote-phone", kind: "remote", label: "iPhone", accountId };
}

/** Carries out one command from `requestedBy` (already checked to be this Mac's account). */
export function runCodeRemoteCommand(hub: SessionHub, cmd: CodeRemoteCommand, deps: Omit<CodeRemoteDeps, "account">): CodeRemoteOutcome {
  const salt = deps.machineSalt();
  const by = cmd.requestedBy;
  const client = phoneClient(by);
  try {
    if (cmd.action === "projects") return { status: "done", data: { projects: listTrustedProjects(salt, deps.branch) } };
    if (cmd.action === "sessions") return { status: "done", data: { sessions: visible(hub, by).slice(0, MAX_REMOTE_SESSIONS).map((s) => summaryOf(hub, s, salt)) } };
    if (cmd.action === "create") return createSession(hub, cmd, salt, client);
    // Every other action names a session the account may see.
    const s = visible(hub, by).find((x) => x.id === cmd.sessionId);
    if (!s) return NO_SESSION;
    const root = s.projectRoot;
    switch (cmd.action) {
      case "snapshot":
        return { status: "done", data: remoteSessionSnapshot(hub, s, salt) };
      case "changes": {
        const running = hub.snapshot(s.id).running?.turnId === cmd.turnId;
        if (!running && !s.transcript.some((e) => e.turnId === cmd.turnId)) return { status: "refused", error: "no_such_turn" };
        const changes = deps.checkpoints.changes(cmd.turnId);
        if (!changes) return { status: "refused", error: "checkpoint_gone", message: "That turn's checkpoint is gone (the provider restarted)." };
        const files = changes.slice(0, MAX_CHANGED_FILES).map((c) => ({
          path: scrubPaths(c.path, root),
          before: c.before === null ? null : cap(c.before, MAX_CHANGE_FILE_CHARS),
          after: c.after === null ? null : cap(c.after, MAX_CHANGE_FILE_CHARS),
          ...((c.before?.length ?? 0) > MAX_CHANGE_FILE_CHARS || (c.after?.length ?? 0) > MAX_CHANGE_FILE_CHARS ? { cut: true } : {}),
        }));
        return { status: "done", data: fitList(files, { total: changes.length }) };
      }
      case "messages": {
        const all = s.transcript;
        const cut = cmd.beforeId === undefined ? -1 : all.findIndex((m) => m.id === cmd.beforeId);
        const older = cut >= 0 ? all.slice(0, cut) : cmd.beforeId === undefined ? all : [];
        const page = older.slice(-(cmd.limit ?? 20));
        const pendingIds = new Set(hub.snapshot(s.id).pending.map((p) => p.id));
        return { status: "done", data: fitList(page.map((m) => messageOf(m, root, pendingIds, PAGE_MESSAGE_CHARS)), { more: older.length > page.length, total: all.length }) };
      }
      case "message": {
        const r = hub.send(s.id, cmd.text, client);
        return { status: "done", data: { turnId: r.turnId, ...(r.queued ? { queuedId: r.queued.id } : {}) } };
      }
      case "approve": {
        const p = hub.snapshot(s.id).pending.find((x) => x.id === cmd.callId);
        if (!p) return { status: "refused", error: "no_pending_approval", message: "That approval was already answered or the turn ended." };
        if (cmd.approved && tooLongToApprove(p)) return { status: "refused", error: "approve_on_mac", message: "This command is too long to check on the phone. Approve it on the Mac." };
        if (cmd.approved && !hub.remoteMayApprove(s.id, p.id)) return { status: "refused", error: "approve_on_mac", message: ON_MAC };
        // One call only: the phone never answers "always" (and SessionHub ignores it for remote clients).
        return hub.approve(s.id, cmd.callId, cmd.approved, client) ? { status: "done" } : { status: "refused", error: "no_pending_approval" };
      }
      case "cancel":
        return { status: "done", data: { cancelled: hub.cancel(s.id, client) } };
      case "undo": {
        const r = hub.undo(s.id, client, cmd.turnId);
        return { status: "done", data: { turnId: r.turnId, reverted: r.reverted.slice(0, MAX_CHANGED_FILES).map((f) => scrubPaths(f, root)) } };
      }
      case "plan":
        return { status: "done", data: hub.approvePlan(s.id, client, cmd.mode) };
      case "settings": {
        if (cmd.mode === "auto") return AUTO_REFUSED;
        if (cmd.mode === "full") return FULL_REFUSED;
        hub.update(s.id, { ...(cmd.title !== undefined ? { title: cmd.title } : {}), ...(cmd.model ? { model: cmd.model } : {}), ...(cmd.mode ? { mode: cmd.mode } : {}) }, client);
        return { status: "done", data: { session: summaryOf(hub, hub.peek(s.id) ?? s, salt) } };
      }
      case "unqueue":
        return { status: "done", data: { removed: hub.unqueue(s.id, cmd.queuedId, client) } };
    }
    return { status: "refused", error: "invalid_request" };
  } catch (err) {
    if (err instanceof SessionError) {
      if (err.code === "not_found") return NO_SESSION;
      return { status: "refused", error: err.code, message: scrubPaths(err.message, "").slice(0, 300) };
    }
    return { status: "failed", error: "session_error", message: scrubPaths(String((err as Error)?.message ?? err), "").slice(0, 300) };
  }
}

/** "create": a session in a trusted folder named by its projectId, owned by the phone's account. */
function createSession(hub: SessionHub, cmd: Extract<CodeRemoteCommand, { action: "create" }>, salt: string, client: ClientRef): CodeRemoteOutcome {
  if (cmd.mode === "auto") return AUTO_REFUSED;
  if (cmd.mode === "full") return FULL_REFUSED;
  // The id is looked up over the trusted list as it is now, then trust and the folder are checked
  // again right before use (the list may have changed since the phone fetched it).
  const root = trustedRootForId(cmd.projectId, salt);
  if (!root) return { status: "refused", error: "no_such_project", message: "That project isn't trusted on this Mac." };
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isProjectOpenToPhone(root) || !isDir) return { status: "refused", error: "no_such_project", message: "That project isn't trusted on this Mac." };
  const s = hub.create({ projectRoot: root, ...(cmd.title ? { title: cmd.title } : {}), ...(cmd.model ? { model: cmd.model } : {}), mode: cmd.mode, client, ownerAccount: client.accountId });
  hub.publish(s.id, true, client);
  hub.recordNote(s.id, { content: "Started from iPhone" });
  return { status: "done", data: { sessionId: s.id, projectId: cmd.projectId } };
}

export function registerCodeRemoteRoutes(app: FastifyInstance, hub: SessionHub, deps: CodeRemoteDeps): void {
  app.get("/v1/ide/code/remote/snapshot", async (req, reply) => {
    const q = z.object({ account }).safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ status: "refused", error: "malformed" });
    const signedIn = await deps.account().catch(() => null);
    if (!signedIn || signedIn !== q.data.account) return reply.status(403).send({ status: "refused", error: "not_this_account", message: "The account signed in on this Mac didn't ask for this." });
    return codeRemoteSnapshot(hub, signedIn, deps.machineSalt(), deps.branch);
  });
  app.post("/v1/ide/code/remote/command", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    // Defense in depth: whoever relays this checked ownership; the Mac checks its own signed-in account first.
    const requestedBy = typeof body.requestedBy === "string" ? body.requestedBy : "";
    const signedIn = await deps.account().catch(() => null);
    if (!signedIn || !requestedBy || signedIn !== requestedBy) return reply.status(403).send({ status: "refused", error: "not_this_account", message: "The account signed in on this Mac didn't ask for this." });
    const cmd = codeRemoteCommandSchema.safeParse(body);
    if (!cmd.success) return reply.status(400).send({ status: "refused", error: "invalid_request", message: cmd.error.issues[0]?.message });
    return runCodeRemoteCommand(hub, cmd.data, deps);
  });
}

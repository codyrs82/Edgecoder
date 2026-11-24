// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coding sessions as a shared object, owned by this machine's IDE provider: the conversation, the
 * project folder and branch, the model and where it runs, the tool calls waiting for approval and
 * each turn's checkpoint. Clients (the `edgecoder code` terminal, the desktop app's Code view) read
 * a snapshot, follow the session's events and act on it through the provider; the agent turn runs
 * here, so it does not depend on any one client staying connected.
 *
 * Co-editing: every attached client may send, answer approvals and change settings at any time.
 * A message sent while a turn runs waits in the session's queue (labelled with its client) and the
 * next turn starts with the queued messages; stopping the turn lets them run now. The first answer
 * to an approval wins and every client sees who gave it. Sessions persist as one JSON file each in
 * EDGECODER_SESSIONS_DIR (default ~/.edgecoder/sessions, files 0600); what a running turn is doing
 * and its approvals live in memory and end with the provider.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ALWAYS_ASK_TOOLS, makeToolRunner, runAgentLoop, type ChatFn, type ToolRunnerDeps, type ToolSchema } from "./agent-loop.js";
import { toolchainFailureHint } from "./toolchain.js";
import type { CheckpointStore } from "./checkpoints.js";
import { defaultMode, defaultPermissionsFile, editsApply, EXECUTION_MODES, PermissionStore, riskOf, type PermissionMode } from "./permissions.js";
import { classifyCommand, decideToolCall, suggestToolRule, type Decision } from "./permission-policy.js";
import { isWithin } from "./tool-executor.js";
import { redactApiKeys } from "../../common/redaction.js";
import { parseFrontierModelId } from "../../inference-api/frontier-models.js";
import type { IdeStreamEvent, ToolName } from "./tool-types.js";

/**
 * "remote": the user's phone driving this Mac (code-remote.ts). Its turns ask before any command
 * that isn't read-only, are refused outside the project, and its approvals never add "always" rules.
 */
export type ClientKind = "terminal" | "desktop" | "api" | "remote";

export interface ClientRef {
  clientId: string;
  kind: ClientKind;
  /** Shown to the other clients ("Terminal on cody-mbp"). */
  label?: string;
  /**
   * The EdgeCoder account behind this client, when the provider authenticated one (remote attach).
   * Unset for this computer's own clients, which act for the account signed in here.
   */
  accountId?: string;
}

export interface ComputeSetting {
  target: "local" | "mine" | "network" | "reserved" | "auto" | "frontier";
  computeClass?: string;
  reservationId?: string;
  /** target "frontier": the provider of the user's own key (docs/frontier-keys.md). */
  provider?: string;
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "note";
  content: string;
  at: number;
  /** Which kind of client sent a user message. */
  by?: ClientKind;
  /** Assistant: the turn's agent events (long tool output shortened), for rendering tool calls. */
  events?: IdeStreamEvent[];
  turnId?: string;
  changedFiles?: string[];
  usage?: TurnUsage;
  /** The turn's file changes were undone. */
  undone?: boolean;
  /** A note recorded by a tentacle (tentacles.ts): what ran where, its outcome and patch. */
  tentacle?: Record<string, unknown>;
  /** Assistant: a reply written in plan mode (the plan the user approves or revises). */
  plan?: boolean;
}

/** What a turn's model calls cost, where the last ran, and each call (model, machine, timings). */
export interface TurnUsage {
  cSats: number;
  where?: string;
  calls?: Array<{ cSats: number; where?: string; model?: string; served?: Extract<IdeStreamEvent, { type: "usage" }>["served"]; usd?: number }>;
  /** Estimated USD of the turn's frontier calls (the user's own key; billed by the provider). */
  usd?: number;
}

export interface SessionData {
  id: string;
  title: string;
  projectRoot: string;
  branch: string | null;
  /** The model name (no placement prefix); "auto" when compute is auto. */
  model: string;
  compute: ComputeSetting;
  /** How much the session asks before it acts (permissions.ts). */
  mode: PermissionMode;
  /** Older clients' view of mode: "edits" for auto-edits and auto. */
  autoApprove: "none" | "edits";
  /**
   * "Always allow" answers given in this session: rules (`npm test:*`, permission-policy.ts) and,
   * from older sessions, command names (`npm`). The project keeps them too (PermissionStore).
   */
  alwaysShell: string[];
  origin: ClientKind;
  /** Shown live in the desktop app (remote control). */
  published: boolean;
  createdAt: number;
  updatedAt: number;
  /** cSats spent by this session's model calls. */
  cSats: number;
  transcript: TranscriptEntry[];
  /**
   * The lead is `model` + `compute` (it runs the main agent loop). The worker (tentacle/default)
   * model runs helpers (summaries, compaction) and what a `delegate` tool spawns; default "auto".
   */
  workerModel?: string;
  /** The account signed in on this computer when the session was created; frontier leads serve only it. */
  ownerAccount?: string;
  /** Estimated USD of this session's frontier calls (the user's own key; billed by the provider). */
  frontierUsd?: number;
}

export interface SessionEvent {
  seq: number;
  at: number;
  type: string;
  [key: string]: unknown;
}

export interface PendingApproval {
  id: string;
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  title: string;
  projectRoot: string;
  branch: string | null;
  model: string;
  compute: ComputeSetting;
  workerModel: string;
  frontierUsd: number;
  origin: ClientKind;
  published: boolean;
  createdAt: number;
  updatedAt: number;
  messages: number;
  running: boolean;
  /** Published and a client is attached or a turn is running. */
  live: boolean;
  controller: ClientRef | null;
  clients: ClientRef[];
  pending: number;
}

/** A message sent while a turn ran: it starts the next turn. */
export interface QueuedMessage {
  id: string;
  text: string;
  by: ClientKind;
  label?: string;
  at: number;
  /** The client that sent it, and that client's authenticated account (remote attach); unset = this computer's own. */
  clientId?: string;
  accountId?: string;
}

export interface SessionSnapshot {
  session: SessionData;
  /** The last event so far; follow from here. */
  seq: number;
  /** Always null: sessions are co-edited (kept for older clients). */
  controller: ClientRef | null;
  clients: ClientRef[];
  running: { turnId: string; text: string; events: IdeStreamEvent[] } | null;
  pending: PendingApproval[];
  queue: QueuedMessage[];
}

/**
 * What a turn needs from the provider: model calls, prompt, tools and checkpoints. This is the
 * extension point for orchestration (docs/terminal.md, "For builders"): a `delegate` tool belongs in
 * `executor` and can run its sub-job as a child session (create / send / idle) on a cheaper model.
 */
export interface TurnEnv {
  /**
   * Model calls for a turn. `ctx.role` is "lead" for the main agent loop and "worker" for helpers
   * (compaction, summaries, delegated sub-jobs: workerModelOf(s)); `ctx.client` sent the message.
   */
  chat: (s: SessionData, emit: (e: IdeStreamEvent) => void, signal: AbortSignal, ctx?: { client: ClientRef | null; role: "lead" | "worker" }) => ChatFn;
  systemPrompt: (s: SessionData) => Promise<(format: "native" | "text") => string>;
  executor: (s: SessionData) => { execute: ToolRunnerDeps["execute"]; prepare?: ToolRunnerDeps["prepare"] };
  tools?: (s: SessionData) => ToolSchema[] | undefined;
  checkpoints: CheckpointStore;
  /** The project's current branch (null outside git). */
  branch?: (projectRoot: string) => string | null;
  /** The session model's context window in tokens (the loop compacts to fit it); undefined: a conservative default. */
  contextWindow?: (s: SessionData) => Promise<number | undefined>;
  /** A cheap model call that summarizes older messages when the loop compacts. */
  summarize?: (s: SessionData, emit: (e: IdeStreamEvent) => void, signal: AbortSignal, ctx?: { client: ClientRef | null }) => (text: string) => Promise<string | null>;
  /** The EdgeCoder account signed in on this computer (last known), recorded as a new session's owner. */
  owner?: () => string | undefined;
  /** Tentacles hook: the session was stopped, deleted or the provider is shutting down (cancel its helpers). */
  onSessionStop?: (sessionId: string) => void;
}

export class SessionError extends Error {
  constructor(readonly code: "not_found" | "busy" | "invalid" | "checkpoint_gone" | "nothing_to_undo" | "forbidden", message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

interface Running {
  turnId: string;
  /** The client whose message started the turn. */
  by?: ClientRef;
  abort: AbortController;
  text: string;
  events: IdeStreamEvent[];
  changed: string[];
  usage?: TurnUsage;
  done: Promise<void>;
}

interface Live {
  seq: number;
  buffer: SessionEvent[];
  listeners: Map<number, { client: ClientRef; fn: (e: SessionEvent) => void }>;
  controller: ClientRef | null;
  running: Running | null;
  pending: Map<string, PendingApproval & { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>;
  queue: QueuedMessage[];
}

const BUFFER = 1000;
const MAX_RESULT_CHARS = 2000;
const SHELL_META = /[;&|`$<>(){}\\\n]/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The message that starts carrying out an approved plan. */
export const PLAN_APPROVED = "The plan is approved. Carry it out now, step by step, using the tools. When you're done, reply with a short summary of what changed and how you checked it.";

export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EDGECODER_SESSIONS_DIR || join(homedir(), ".edgecoder", "sessions");
}

/** The model id clients show ("network/qwen3-coder:30b@gpu", "auto", a local tag, "frontier/anthropic/<model>"). */
export function modelIdOf(s: Pick<SessionData, "model" | "compute">): string {
  const c = s.compute;
  if (c.target === "auto") return "auto";
  if (c.target === "frontier") return `frontier/${c.provider ?? ""}/${s.model}`;
  if (c.target === "local") return s.model;
  if (c.target === "mine") return `mine/${s.model}`;
  if (c.target === "reserved") return `reserved/${c.reservationId ?? ""}/${s.model}`;
  return `network/${s.model}${c.computeClass && c.computeClass !== "any" ? `@${c.computeClass}` : ""}`;
}

/** A model id from a picker or `--model` as the session keeps it. */
export function parseModelId(id: string): { model: string; compute: ComputeSetting } {
  if (id === "auto") return { model: "auto", compute: { target: "auto" } };
  // Only the provider and model are kept (never a key): "frontier/anthropic/claude-opus-5-5".
  const frontier = parseFrontierModelId(id);
  if (frontier) return { model: frontier.model, compute: { target: "frontier", provider: frontier.provider } };
  if (id.startsWith("mine/")) return { model: id.slice(5), compute: { target: "mine" } };
  const reserved = /^reserved\/([^/]+)\/(.+)$/.exec(id);
  if (reserved) return { model: reserved[2], compute: { target: "reserved", reservationId: reserved[1] } };
  if (id.startsWith("network/")) {
    const rest = id.slice(8);
    const at = rest.lastIndexOf("@");
    const cls = at > 0 ? rest.slice(at + 1) : "";
    return ["cpu", "apple", "gpu", "gpu.dc", "cloud"].includes(cls)
      ? { model: rest.slice(0, at), compute: { target: "network", computeClass: cls } }
      : { model: rest, compute: { target: "network", computeClass: "any" } };
  }
  return { model: id, compute: { target: "local" } };
}

/** The worker (tentacle/default) model: helpers and delegated work. Never a frontier model. */
export function workerModelOf(s: Pick<SessionData, "workerModel">): string {
  const w = s.workerModel;
  return w && !parseFrontierModelId(w) ? w : "auto";
}

/**
 * The model compaction's summary call runs on: the worker, never a frontier lead, unless the user
 * opted in (frontier setting compactWithLead); the lead's account check still applies then.
 */
export function compactionModelOf(s: Pick<SessionData, "model" | "compute" | "workerModel">, compactWithLead = false): { id: string; role: "lead" | "worker" } {
  const lead = modelIdOf(s);
  if (parseFrontierModelId(lead) && compactWithLead) return { id: lead, role: "lead" };
  return { id: workerModelOf(s), role: "worker" };
}

/** The command's program name when "always" may cover it: a plain command with no shell syntax. */
export function shellPrefix(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const c = command.trim();
  if (!c || SHELL_META.test(c)) return null;
  const first = c.split(/\s+/)[0];
  return /^[A-Za-z0-9._\-/]{1,64}$/.test(first) ? first : null;
}

/** An event as kept for later: long tool output shortened. */
function storable(e: IdeStreamEvent): IdeStreamEvent {
  const cut = (s: string | undefined, n = MAX_RESULT_CHARS) => (s && s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
  if (e.type === "tool_result") return { ...e, result: cut(e.result), error: cut(e.error) };
  if (e.type === "shell_output") return { ...e, stdout: cut(e.stdout, 4000) ?? "", stderr: cut(e.stderr, 4000) ?? "" };
  return e;
}

function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class SessionHub {
  private readonly sessions = new Map<string, SessionData>();
  private readonly live = new Map<string, Live>();
  private listenerSeq = 0;
  private readonly dir: string | null;
  private readonly approvalTimeoutMs: number;
  readonly permissions: PermissionStore;

  constructor(private readonly env: TurnEnv, opts: { dir?: string | null; approvalTimeoutMs?: number; permissionsFile?: string | null; permissions?: PermissionStore } = {}) {
    this.dir = opts.dir === undefined ? defaultSessionsDir() : opts.dir;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 30 * 60_000;
    // The default sessions folder keeps "always" answers in ~/.edgecoder/permissions.json; any
    // other setup (tests) keeps them in memory unless given a file.
    this.permissions = opts.permissions ?? new PermissionStore(opts.permissionsFile !== undefined ? opts.permissionsFile : opts.dir === undefined ? defaultPermissionsFile() : null);
  }

  /** Read the saved sessions (once, at startup). */
  load(): void {
    if (!this.dir || !existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as SessionData;
        if (!ID_RE.test(s.id) || typeof s.projectRoot !== "string" || !Array.isArray(s.transcript)) continue;
        s.alwaysShell ??= [];
        s.cSats ??= 0;
        s.mode ??= s.autoApprove === "edits" ? "auto-edits" : "ask";
        this.sessions.set(s.id, s);
      } catch {
        // a damaged file is skipped, not fatal
      }
    }
  }

  private save(s: SessionData): void {
    s.updatedAt = Date.now();
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${s.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    // A provider key pasted into a message never reaches the disk (docs/frontier-keys.md).
    writeFileSync(tmp, redactApiKeys(JSON.stringify(s)), { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600); // whatever the umask (and a file that existed with looser bits)
    } catch {
      // no POSIX modes here (Windows)
    }
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      l = { seq: 0, buffer: [], listeners: new Map(), controller: null, running: null, pending: new Map(), queue: [] };
      this.live.set(id, l);
    }
    return l;
  }

  private need(id: string): SessionData {
    const s = this.sessions.get(id);
    if (!s) throw new SessionError("not_found", "No session with that id.");
    return s;
  }

  private emit(id: string, ev: Record<string, unknown> & { type: string }): void {
    const l = this.liveOf(id);
    const e: SessionEvent = { ...ev, seq: ++l.seq, at: Date.now() };
    l.buffer.push(e);
    if (l.buffer.length > BUFFER) l.buffer.splice(0, l.buffer.length - BUFFER);
    for (const { fn } of l.listeners.values()) {
      try {
        fn(e);
      } catch {
        // a broken listener is removed by its own close handler
      }
    }
  }

  private clientsOf(l: Live): ClientRef[] {
    const seen = new Map<string, ClientRef>();
    for (const { client } of l.listeners.values()) seen.set(client.clientId, client);
    return [...seen.values()];
  }

  /** Any attached client may write (co-editing); kept as one place to look up the live state. */
  private requireControl(id: string, _client: ClientRef): Live {
    return this.liveOf(id);
  }

  create(input: { projectRoot: string; model?: string; workerModel?: string; title?: string; autoApprove?: "none" | "edits"; mode?: PermissionMode; client: ClientRef; ownerAccount?: string }): SessionData {
    const now = Date.now();
    const parsed = parseModelId(input.model || "auto");
    const mode: PermissionMode = input.mode ?? (input.autoApprove === "edits" ? "auto-edits" : input.autoApprove === "none" ? "ask" : defaultMode(input.projectRoot, this.permissions.get(input.projectRoot)));
    if (mode === "full") this.assertMaySetFull(input.client, input.ownerAccount ?? this.env.owner?.());
    const s: SessionData = {
      id: randomUUID(),
      title: input.title?.trim() || "New session",
      projectRoot: input.projectRoot,
      branch: this.env.branch?.(input.projectRoot) ?? null,
      model: parsed.model,
      compute: parsed.compute,
      mode,
      autoApprove: editsApply(mode) ? "edits" : "none",
      alwaysShell: [],
      origin: input.client.kind,
      published: false,
      createdAt: now,
      updatedAt: now,
      cSats: 0,
      transcript: [],
      workerModel: input.workerModel && !parseFrontierModelId(input.workerModel) ? input.workerModel : "auto",
      ...((input.ownerAccount ?? this.env.owner?.()) ? { ownerAccount: input.ownerAccount ?? this.env.owner?.() } : {}),
    };
    this.sessions.set(s.id, s);
    this.liveOf(s.id);
    this.save(s);
    return plain(s);
  }

  list(filter: { projectRoot?: string; published?: boolean } = {}): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => (filter.projectRoot ? s.projectRoot === filter.projectRoot : true))
      .filter((s) => (filter.published !== undefined ? s.published === filter.published : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => {
        const l = this.liveOf(s.id);
        const clients = this.clientsOf(l);
        return {
          id: s.id,
          title: s.title,
          projectRoot: s.projectRoot,
          branch: s.branch,
          model: modelIdOf(s),
          compute: s.compute,
          workerModel: workerModelOf(s),
          frontierUsd: s.frontierUsd ?? 0,
          origin: s.origin,
          published: s.published,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messages: s.transcript.length,
          running: !!l.running,
          live: s.published && (clients.length > 0 || !!l.running),
          controller: null,
          clients,
          pending: l.pending.size,
        };
      });
  }

  snapshot(id: string): SessionSnapshot {
    const s = this.need(id);
    const l = this.liveOf(id);
    return {
      session: plain(s),
      seq: l.seq,
      controller: null,
      clients: this.clientsOf(l),
      running: l.running ? { turnId: l.running.turnId, text: l.running.text, events: plain(l.running.events) } : null,
      pending: [...l.pending.values()].map((p) => ({ id: p.id, tool: p.tool, args: plain(p.args) })),
      queue: plain(l.queue),
    };
  }

  /**
   * Follow a session: events after `since` are replayed, then each new one as it happens. When the
   * replay can't cover the gap a single `resync` event says to fetch the snapshot again.
   */
  subscribe(id: string, client: ClientRef, since: number, fn: (e: SessionEvent) => void): () => void {
    this.need(id);
    const l = this.liveOf(id);
    const oldest = l.buffer[0]?.seq ?? l.seq + 1;
    if (since < l.seq && since < oldest - 1) fn({ seq: l.seq, at: Date.now(), type: "resync" });
    else for (const e of l.buffer) if (e.seq > since) fn(e);
    const key = ++this.listenerSeq;
    l.listeners.set(key, { client: { ...client }, fn });
    this.emit(id, { type: "presence", clients: this.clientsOf(l) });
    return () => {
      if (!l.listeners.delete(key)) return;
      this.emit(id, { type: "presence", clients: this.clientsOf(l) });
    };
  }

  /** Kept for older clients: every attached client may write, so this only checks the session exists. */
  assertControl(id: string, _client: ClientRef): void {
    this.need(id);
  }

  /** No-op (co-editing has no exclusive control); kept for older clients. */
  takeControl(id: string, client: ClientRef): ClientRef {
    this.need(id);
    return { ...client };
  }

  /** No-op, see takeControl. */
  release(id: string, _client: ClientRef): void {
    this.need(id);
  }

  /**
   * A message from any attached client. With no turn running it starts one; while one runs it
   * waits in the queue (in order, labelled with its client) and starts the next turn.
   */
  send(id: string, text: string, client: ClientRef): { turnId: string | null; queued?: QueuedMessage } {
    this.need(id);
    const l = this.liveOf(id);
    if (!text.trim()) throw new SessionError("invalid", "The message is empty.");
    // A provider key pasted into a message goes nowhere: not to the model, the events or the disk.
    const q: QueuedMessage = { id: randomUUID(), text: redactApiKeys(text), by: client.kind, ...(client.label ? { label: client.label } : {}), at: Date.now(), clientId: client.clientId, ...(client.accountId ? { accountId: client.accountId } : {}) };
    if (l.running || l.queue.length) {
      l.queue.push(q);
      this.emit(id, { type: "queued", entry: q, queue: plain(l.queue) });
      return { turnId: null, queued: q };
    }
    return { turnId: this.startTurn(id, [q]) };
  }

  /** Remove a queued message before it starts (any client). */
  unqueue(id: string, queuedId: string, _client: ClientRef): boolean {
    this.need(id);
    const l = this.liveOf(id);
    const i = l.queue.findIndex((q) => q.id === queuedId);
    if (i < 0) return false;
    l.queue.splice(i, 1);
    this.emit(id, { type: "unqueued", id: queuedId, queue: plain(l.queue) });
    return true;
  }

  /** Start a turn with these messages (each kept in the transcript with the client that sent it). */
  private startTurn(id: string, msgs: QueuedMessage[]): string {
    const s = this.need(id);
    const l = this.liveOf(id);
    for (const q of msgs) {
      const entry: TranscriptEntry = { id: q.id, role: "user", content: q.text, at: Date.now(), by: q.by };
      s.transcript.push(entry);
      if (s.title === "New session") s.title = q.text.trim().split("\n")[0].slice(0, 60) + (q.text.length > 60 ? "…" : "");
      this.emit(id, { type: "message", entry, ...(q.label ? { label: q.label } : {}) });
    }
    this.save(s);
    const turnId = randomUUID();
    // The turn acts for the account behind its messages (startTurn never mixes accounts).
    const first = msgs[0];
    // A batch with a remote message runs under the remote rules (decide), whoever sent the first one.
    const kind: ClientKind = msgs.some((q) => q.by === "remote") ? "remote" : first?.by ?? "api";
    const by: ClientRef = { clientId: first?.clientId ?? "unknown", kind, ...(first?.label ? { label: first.label } : {}), ...(first?.accountId ? { accountId: first.accountId } : {}) };
    const running: Running = { turnId, by, abort: new AbortController(), text: "", events: [], changed: [], done: Promise.resolve() };
    l.running = running;
    running.done = this.runTurn(s, l, running);
    return turnId;
  }

  private async runTurn(s: SessionData, l: Live, r: Running): Promise<void> {
    const id = s.id;
    const sendEvent = (e: IdeStreamEvent) => {
      if (e.type === "text") r.text += e.content;
      if (e.type === "file_change" && !r.changed.includes(e.path)) r.changed.push(e.path);
      if (e.type === "usage") {
        const cSats = Number.isFinite(e.cSats) ? e.cSats : 0;
        const usd = typeof e.usd === "number" && Number.isFinite(e.usd) ? e.usd : 0;
        const call = { cSats, where: e.where, ...(e.model ? { model: e.model } : {}), ...(e.served ? { served: e.served } : {}), ...(usd ? { usd } : {}) };
        const turnUsd = Number(((r.usage?.usd ?? 0) + usd).toFixed(6));
        r.usage = { cSats: Number(((r.usage?.cSats ?? 0) + cSats).toFixed(6)), where: e.where, calls: [...(r.usage?.calls ?? []), call].slice(-50), ...(turnUsd ? { usd: turnUsd } : {}) };
        s.cSats = Number((s.cSats + cSats).toFixed(6));
        if (usd) s.frontierUsd = Number(((s.frontierUsd ?? 0) + usd).toFixed(6));
      }
      if (e.type === "status" && e.message.startsWith("Auto: ")) r.usage = { ...r.usage, cSats: r.usage?.cSats ?? 0, where: e.message.slice(6) };
      if (e.type !== "done") r.events.push(storable(e));
      this.emit(id, { type: "agent", turnId: r.turnId, event: e });
    };
    try {
      this.env.checkpoints.begin(r.turnId, s.projectRoot);
      sendEvent({ type: "turn", id: r.turnId });
      const exec = this.env.executor(s);
      const messages = s.transcript.filter((t) => t.role === "user" || t.role === "assistant").map((t) => ({ role: t.role, content: t.content }));
      await runAgentLoop({
        chat: this.env.chat(s, sendEvent, r.abort.signal, { client: r.by ?? null, role: "lead" }),
        systemPrompt: await this.env.systemPrompt(s),
        messages,
        sendEvent,
        isCancelled: () => r.abort.signal.aborted,
        tools: this.env.tools?.(s),
        ...(this.env.contextWindow ? { contextWindow: () => this.env.contextWindow!(s) } : {}),
        ...(this.env.summarize ? { summarize: this.env.summarize(s, (e) => e.type === "usage" && sendEvent(e), r.abort.signal, { client: r.by ?? null }) } : {}),
        // Plan mode is read when the turn starts: approving the plan starts the next turn.
        plan: s.mode === "plan",
        runTool: makeToolRunner({
          prepare: exec.prepare,
          execute: exec.execute,
          sendEvent,
          waitForApproval: (callId, tool, args) => this.waitForApproval(s, l, r, callId, tool, args),
          captureBeforeWrite: (path) => this.env.checkpoints.capture(r.turnId, path),
          turnId: r.turnId,
          decide: (tool, args) => this.decide(s, tool, args, r.by ?? null),
          // A Node version mismatch in a command's output: the diagnosis and the command to retry (toolchain.ts).
          shellHint: (command, output) => toolchainFailureHint(s.projectRoot, command, output),
        }),
      });
    } catch (err) {
      sendEvent({ type: "text", content: `\n\nError: ${(err as Error).message}` });
    } finally {
      for (const p of l.pending.values()) {
        clearTimeout(p.timer);
        p.resolve(false);
      }
      l.pending.clear();
      const stopped = r.abort.signal.aborted;
      const planned = s.mode === "plan" && !stopped && r.text.trim().length > 0;
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "assistant",
        content: stopped ? `${r.text}\n\n_(stopped)_` : r.text,
        at: Date.now(),
        events: r.events,
        turnId: r.turnId,
        ...(r.changed.length ? { changedFiles: [...r.changed] } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
        ...(planned ? { plan: true } : {}),
      };
      s.transcript.push(entry);
      try {
        s.branch = this.env.branch?.(s.projectRoot) ?? s.branch;
      } catch {
        // keep the last known branch
      }
      l.running = null;
      this.save(s);
      this.emit(id, { type: "turn_end", entry, stopped, cSats: s.cSats, branch: s.branch });
      if (planned) this.emit(id, { type: "plan_ready", entryId: entry.id });
      // Messages queued meanwhile start the next turn (together, in order).
      if (l.queue.length && this.sessions.has(id)) {
        // One turn per requesting account: a run of messages from the same account starts the
        // next turn, so another account's message never rides on a frontier lead (frontier-access.ts).
        const acct = l.queue[0].accountId;
        let n = 0;
        while (n < l.queue.length && l.queue[n].accountId === acct) n++;
        const next = l.queue.splice(0, n);
        this.emit(id, { type: "unqueued", ids: next.map((q) => q.id), queue: plain(l.queue) });
        this.startTurn(id, next);
      }
    }
  }

  /**
   * The session's verdict on a call (permission-policy.ts): its mode, then the project's and
   * session's "always" answers. `by` is the client whose message started the turn (default: the
   * running turn's); a remote turn gets the stricter remoteDecision.
   */
  decide(s: SessionData, tool: ToolName, args: Record<string, unknown>, by: ClientRef | null = this.live.get(s.id)?.running?.by ?? null): Decision {
    if (by?.kind === "remote") return this.remoteDecision(s, tool, args);
    const project = this.permissions.get(s.projectRoot);
    return decideToolCall(
      tool,
      args,
      {
        mode: this.modeFor(s, by),
        root: s.projectRoot,
        rules: [...(project.rules ?? []), ...s.alwaysShell],
        legacyNames: [...project.shell, ...s.alwaysShell],
        branch: () => this.env.branch?.(s.projectRoot) ?? s.branch,
      },
      (c) => riskOf(c, s.projectRoot),
    );
  }

  /**
   * A turn started from the phone: no "always allow" rule (project or session) and no Auto safe
   * class runs a command without asking; only read-only commands run. A command or edit that
   * reaches outside the project, or one the classifier refuses, is refused rather than asked (the
   * Mac can still run it). Edits inside the project follow the session's mode.
   */
  private remoteDecision(s: SessionData, tool: ToolName, args: Record<string, unknown>): Decision {
    const branch = () => this.env.branch?.(s.projectRoot) ?? s.branch;
    // Full access is for this computer's own clients: a phone turn in a Full access session runs
    // under the remote rules as Accept edits (edits inside the project apply, commands ask).
    const mode: PermissionMode = s.mode === "full" ? "auto-edits" : s.mode;
    const base = decideToolCall(tool, args, { mode, root: s.projectRoot, branch });
    if (tool === "run_shell") {
      if (mode === "plan") return base;
      const cls = classifyCommand(args.command, { root: s.projectRoot, branch: branch() });
      if (cls.category === "outside") return { action: "refuse", reason: `Refused from the phone: ${cls.reason}. Run it from the Mac.` };
      if (cls.action === "refuse") return { action: "refuse", reason: `Refused from the phone: ${cls.reason}.` };
      if (cls.action === "run" && cls.category === "read") return { action: "run", reason: cls.reason };
      return { action: "ask", reason: cls.reason };
    }
    if (tool === "write_file" || tool === "edit_file") {
      const path = args.path;
      if (typeof path === "string" && (path.startsWith("~") || !isWithin(s.projectRoot, resolve(s.projectRoot, path)))) {
        return { action: "refuse", reason: "Refused from the phone: a file outside the project." };
      }
    }
    // Never offer the phone an "always allow" rule.
    return { action: base.action, reason: base.reason };
  }

  /** The session's owner: the account recorded when it was created, else the one signed in here. */
  private ownerOf(s: Pick<SessionData, "ownerAccount">): string | undefined {
    return s.ownerAccount ?? this.env.owner?.();
  }

  /**
   * True when `by` acts for another account than the session's owner (a shared session's attached
   * client signed in elsewhere). A client with no account is this computer's own (the IDE token),
   * like frontier-access.ts's requester check.
   */
  private otherAccount(s: Pick<SessionData, "ownerAccount">, by: ClientRef | null): boolean {
    if (!by?.accountId) return false;
    const owner = this.ownerOf(s);
    return !owner || by.accountId !== owner;
  }

  /**
   * The mode a turn started by `by` runs in. Full access serves only this computer's own clients
   * and the owner's account (like a frontier lead); another account's message, or a phone/web turn,
   * runs as Accept edits.
   */
  modeFor(s: SessionData, by: ClientRef | null): PermissionMode {
    if (s.mode === "full" && (by?.kind === "remote" || this.otherAccount(s, by))) return "auto-edits";
    return s.mode;
  }

  /** Full access is turned on from this computer only: never from the phone or web, never by another account. */
  private assertMaySetFull(client: ClientRef, owner: string | undefined): void {
    if (client.kind === "remote") throw new SessionError("forbidden", "Full access is turned on from the Mac, not from the phone or the web.");
    if (client.accountId && (!owner || client.accountId !== owner)) throw new SessionError("forbidden", "Only the session's owner can turn on Full access.");
  }

  /** A call that runs without asking in the session's mode (kept for callers that only need yes/no). */
  allowedWithoutAsking(s: SessionData, tool: ToolName, args: Record<string, unknown>): boolean {
    return this.decide(s, tool, args).action === "run";
  }

  private waitForApproval(s: SessionData, l: Live, r: Running, callId: string, tool: ToolName, args: Record<string, unknown>): Promise<boolean> {
    // The mode or an "always" answer given meanwhile (never for the tools that always ask).
    if ((!ALWAYS_ASK_TOOLS.has(tool) || this.modeFor(s, r.by ?? null) === "full") && this.decide(s, tool, args, r.by ?? null).action === "run") {
      this.emit(s.id, { type: "approval", id: callId, approved: true, by: "always" });
      return Promise.resolve(true);
    }
    if (r.abort.signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!l.pending.delete(callId)) return;
        this.emit(s.id, { type: "approval", id: callId, approved: false, by: "timeout" });
        resolve(false);
      }, this.approvalTimeoutMs);
      l.pending.set(callId, { id: callId, tool, args, resolve, timer });
    });
  }

  /**
   * An answer from any attached client. The first answer wins: a later one (the call was answered
   * elsewhere, or it timed out) returns false and changes nothing.
   */
  approve(id: string, callId: string, approved: boolean, client: ClientRef, alwaysAsked = false): boolean {
    const s = this.need(id);
    // An answer from the phone approves this one call only: it never adds a rule or turns on auto-edits.
    const always = alwaysAsked && client.kind !== "remote";
    const l = this.liveOf(id);
    const p = l.pending.get(callId);
    if (!p) return false;
    l.pending.delete(callId);
    clearTimeout(p.timer);
    if (approved && always && !ALWAYS_ASK_TOOLS.has(p.tool)) {
      if (p.tool === "write_file" || p.tool === "edit_file") {
        if (s.mode === "ask") s.mode = "auto-edits";
        this.permissions.allowEdits(s.projectRoot);
      }
      if (p.tool === "run_shell" || p.tool === "git_pull" || p.tool === "git_fetch") {
        // "Always allow" keeps a rule (`npm test:*`, `git pull:*`) for the project; never for a
        // refused or always-ask command (suggestToolRule returns null for those).
        const rule = suggestToolRule(p.tool, p.args, { root: s.projectRoot });
        if (rule && !s.alwaysShell.includes(rule)) s.alwaysShell.push(rule);
        if (rule) this.permissions.addRule(s.projectRoot, rule);
      }
      s.autoApprove = editsApply(s.mode) ? "edits" : "none";
      this.save(s);
      this.emit(id, { type: "settings", mode: s.mode, autoApprove: s.autoApprove, alwaysShell: [...s.alwaysShell], by: client.kind, ...(client.label ? { label: client.label } : {}) });
    }
    this.emit(id, { type: "approval", id: callId, approved, by: client.kind, ...(client.label ? { label: client.label } : {}), ...(always ? { always: true } : {}) });
    p.resolve(approved);
    return true;
  }

  /**
   * Stop the running turn (any client; pending approvals are rejected; what was written stays,
   * undoable). Queued messages then start the next turn.
   */
  cancel(id: string, client: ClientRef): boolean {
    this.need(id);
    const l = this.liveOf(id);
    this.env.onSessionStop?.(id); // tentacles hook: stop means its helpers too
    if (!l.running) return false;
    l.running.abort.abort();
    this.emit(id, { type: "stopping", by: client.kind, ...(client.label ? { label: client.label } : {}) });
    for (const [callId, p] of l.pending) {
      clearTimeout(p.timer);
      l.pending.delete(callId);
      this.emit(id, { type: "approval", id: callId, approved: false, by: "stopped" });
      p.resolve(false);
    }
    return true;
  }

  /** Settings from any client; every client hears the change and who made it. */
  update(id: string, patch: { model?: string; leadModel?: string; workerModel?: string; title?: string; autoApprove?: "none" | "edits"; mode?: PermissionMode }, client: ClientRef): SessionData {
    const s = this.need(id);
    if (patch.mode === "full" && s.mode !== "full") this.assertMaySetFull(client, this.ownerOf(s));
    const lead = patch.leadModel ?? patch.model;
    if (lead) {
      const p = parseModelId(lead);
      s.model = p.model;
      s.compute = p.compute;
    }
    if (patch.workerModel) {
      if (parseFrontierModelId(patch.workerModel)) throw new SessionError("invalid", "The worker model runs helpers and delegated work: use auto or a network/local model, not a frontier one.");
      s.workerModel = patch.workerModel;
    }
    if (patch.title?.trim()) s.title = patch.title.trim().slice(0, 120);
    if (patch.mode) s.mode = patch.mode;
    else if (patch.autoApprove) s.mode = patch.autoApprove === "edits" ? (s.mode === "auto" || s.mode === "full" ? s.mode : "auto-edits") : "ask";
    s.autoApprove = editsApply(s.mode) ? "edits" : "none";
    this.save(s);
    // Calls waiting for an answer that the new mode runs without asking go ahead now.
    if (patch.mode) {
      const l = this.liveOf(id);
      for (const [callId, p] of [...l.pending]) {
        if ((ALWAYS_ASK_TOOLS.has(p.tool) && this.modeFor(s, l.running?.by ?? null) !== "full") || this.decide(s, p.tool, p.args).action !== "run") continue;
        l.pending.delete(callId);
        clearTimeout(p.timer);
        this.emit(id, { type: "approval", id: callId, approved: true, by: "always" });
        p.resolve(true);
      }
    }
    this.emit(id, {
      type: "settings",
      model: modelIdOf(s),
      workerModel: workerModelOf(s),
      title: s.title,
      mode: s.mode,
      autoApprove: s.autoApprove,
      alwaysShell: [...s.alwaysShell],
      changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined),
      by: client.kind,
      byClient: client.clientId,
      ...(client.label ? { label: client.label } : {}),
    });
    return plain(s);
  }

  /**
   * Approve the plan the last plan-mode turn wrote: the session switches to `mode` (default
   * auto-edits) and a message starts the turn that carries the plan out.
   */
  approvePlan(id: string, client: ClientRef, mode: PermissionMode = "auto-edits"): { turnId: string | null } {
    const s = this.need(id);
    const l = this.liveOf(id);
    if (s.mode !== "plan") throw new SessionError("invalid", "The session isn't in plan mode.");
    if (l.running) throw new SessionError("busy", "Wait for the plan to finish first.");
    if (!EXECUTION_MODES.includes(mode)) throw new SessionError("invalid", "Approve the plan into ask, auto-edits or auto.");
    const last = [...s.transcript].reverse().find((t) => t.role === "assistant");
    if (!last?.plan) throw new SessionError("invalid", "There's no plan to approve yet.");
    this.update(id, { mode }, client);
    return this.send(id, PLAN_APPROVED, client);
  }

  publish(id: string, published: boolean, client: ClientRef): void {
    const s = this.need(id);
    this.requireControl(id, client);
    s.published = published;
    this.save(s);
    this.emit(id, { type: "published", published });
  }

  /** Undo a turn's file changes (default: the last turn that changed files and wasn't undone). */
  undo(id: string, client: ClientRef, turnId?: string): { turnId: string; reverted: string[] } {
    const s = this.need(id);
    const l = this.requireControl(id, client);
    if (l.running) throw new SessionError("busy", "Wait for the reply to finish before undoing.");
    const entry = turnId
      ? s.transcript.find((t) => t.turnId === turnId && (t.role === "assistant" || t.role === "note"))
      : [...s.transcript].reverse().find((t) => (t.role === "assistant" || t.role === "note") && t.changedFiles?.length && !t.undone);
    if (!entry?.turnId) throw new SessionError("nothing_to_undo", "No changes to undo in this session.");
    const reverted = this.env.checkpoints.revert(entry.turnId);
    if (!reverted) throw new SessionError("checkpoint_gone", "That turn's checkpoint is gone (the provider restarted). Use git to undo it.");
    entry.undone = true;
    this.save(s);
    this.emit(id, { type: "undo", turnId: entry.turnId, reverted });
    return { turnId: entry.turnId, reverted };
  }

  /** Start the conversation over (same session, project and settings). */
  clear(id: string, client: ClientRef): void {
    const s = this.need(id);
    const l = this.requireControl(id, client);
    if (l.running) throw new SessionError("busy", "Wait for the reply to finish before clearing.");
    s.transcript = [];
    s.title = "New session";
    this.save(s);
    this.emit(id, { type: "cleared" });
  }

  remove(id: string, client: ClientRef): void {
    this.need(id);
    const l = this.requireControl(id, client);
    l.running?.abort.abort();
    this.env.onSessionStop?.(id); // tentacles hook
    this.emit(id, { type: "deleted" });
    this.sessions.delete(id);
    this.live.delete(id);
    if (this.dir) rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  /** Resolves when no turn is running and nothing is queued (tests, shutdown). */
  async idle(id: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const r = this.live.get(id)?.running;
      if (!r) return;
      await r.done;
    }
  }

  /** Stop every running turn (provider shutdown). */
  shutdown(): void {
    for (const l of this.live.values()) l.running?.abort.abort();
    for (const id of this.sessions.keys()) this.env.onSessionStop?.(id); // tentacles hook
  }

  // --- Tentacles hooks (tentacles.ts): extra session events and transcript notes ---

  /** A session's data (a copy), or null. */
  peek(id: string): SessionData | null {
    const s = this.sessions.get(id);
    return s ? plain(s) : null;
  }

  /** Send a session event of a kind this file doesn't know (`tentacle_started`, ...) to every client. */
  publishEvent(id: string, ev: Record<string, unknown> & { type: string }): void {
    if (!this.sessions.has(id)) return;
    this.emit(id, ev);
  }

  /**
   * Add a note to the transcript (not sent to the model). Its `usage.cSats` counts toward the
   * session's spend; a `turnId` with `changedFiles` makes it undoable like a turn.
   */
  recordNote(id: string, note: Omit<TranscriptEntry, "id" | "role" | "at">): TranscriptEntry | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const entry: TranscriptEntry = { ...note, id: randomUUID(), role: "note", at: Date.now() };
    s.transcript.push(entry);
    const cSats = Number(note.usage?.cSats);
    if (Number.isFinite(cSats) && cSats > 0) s.cSats = Number((s.cSats + cSats).toFixed(6));
    this.save(s);
    this.emit(id, { type: "note", entry, cSats: s.cSats });
    return entry;
  }
}

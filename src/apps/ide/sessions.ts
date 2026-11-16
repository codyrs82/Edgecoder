// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coding sessions as a shared object, owned by this machine's IDE provider: the conversation, the
 * project folder and branch, the model and where it runs, the tool calls waiting for approval and
 * each turn's checkpoint. Clients (the `edgecoder code` terminal, the desktop app's Code view) read
 * a snapshot, follow the session's events and act on it through the provider; the agent turn runs
 * here, so it does not depend on any one client staying connected.
 *
 * One writer at a time: the client in control sends messages, answers approvals and changes
 * settings; the others observe. Taking control hands the turn over (an approval that is waiting
 * can then be answered by the new controller). Sessions persist as one JSON file each in
 * EDGECODER_SESSIONS_DIR (default ~/.edgecoder/sessions, files 0600); what a running turn is doing
 * and its approvals live in memory and end with the provider.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALWAYS_ASK_TOOLS, makeToolRunner, runAgentLoop, type ChatFn, type ToolRunnerDeps, type ToolSchema } from "./agent-loop.js";
import type { CheckpointStore } from "./checkpoints.js";
import { protectedToolPath } from "./tool-executor.js";
import type { IdeStreamEvent, ToolName } from "./tool-types.js";

export type ClientKind = "terminal" | "desktop" | "api";

export interface ClientRef {
  clientId: string;
  kind: ClientKind;
  /** Shown to the other clients ("Terminal on cody-mbp"). */
  label?: string;
}

export interface ComputeSetting {
  target: "local" | "mine" | "network" | "reserved" | "auto";
  computeClass?: string;
  reservationId?: string;
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
  usage?: { cSats: number; where?: string };
  /** The turn's file changes were undone. */
  undone?: boolean;
}

export interface SessionData {
  id: string;
  title: string;
  projectRoot: string;
  branch: string | null;
  /** The model name (no placement prefix); "auto" when compute is auto. */
  model: string;
  compute: ComputeSetting;
  /** "edits": file edits apply without asking (undoable); commands still ask. */
  autoApprove: "none" | "edits";
  /** Command names the user approved "always" for this session (`npm`, `git`); no shell metacharacters. */
  alwaysShell: string[];
  origin: ClientKind;
  /** Shown live in the desktop app (remote control). */
  published: boolean;
  createdAt: number;
  updatedAt: number;
  /** cSats spent by this session's model calls. */
  cSats: number;
  transcript: TranscriptEntry[];
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

export interface SessionSnapshot {
  session: SessionData;
  /** The last event so far; follow from here. */
  seq: number;
  controller: ClientRef | null;
  clients: ClientRef[];
  running: { turnId: string; text: string; events: IdeStreamEvent[] } | null;
  pending: PendingApproval[];
}

/**
 * What a turn needs from the provider: model calls, prompt, tools and checkpoints. This is the
 * extension point for orchestration (docs/terminal.md, "For builders"): a `delegate` tool belongs in
 * `executor` and can run its sub-job as a child session (create / send / idle) on a cheaper model.
 */
export interface TurnEnv {
  chat: (s: SessionData, emit: (e: IdeStreamEvent) => void, signal: AbortSignal) => ChatFn;
  systemPrompt: (s: SessionData) => Promise<(format: "native" | "text") => string>;
  executor: (s: SessionData) => { execute: ToolRunnerDeps["execute"]; prepare?: ToolRunnerDeps["prepare"] };
  tools?: (s: SessionData) => ToolSchema[] | undefined;
  checkpoints: CheckpointStore;
  /** The project's current branch (null outside git). */
  branch?: (projectRoot: string) => string | null;
  /** The session model's context window in tokens (the loop compacts to fit it); undefined: a conservative default. */
  contextWindow?: (s: SessionData) => Promise<number | undefined>;
  /** A cheap model call that summarizes older messages when the loop compacts. */
  summarize?: (s: SessionData, emit: (e: IdeStreamEvent) => void, signal: AbortSignal) => (text: string) => Promise<string | null>;
}

export class SessionError extends Error {
  constructor(readonly code: "not_found" | "busy" | "not_in_control" | "invalid" | "checkpoint_gone" | "nothing_to_undo", message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

interface Running {
  turnId: string;
  abort: AbortController;
  text: string;
  events: IdeStreamEvent[];
  changed: string[];
  usage?: { cSats: number; where?: string };
  done: Promise<void>;
}

interface Live {
  seq: number;
  buffer: SessionEvent[];
  listeners: Map<number, { client: ClientRef; fn: (e: SessionEvent) => void }>;
  controller: ClientRef | null;
  running: Running | null;
  pending: Map<string, PendingApproval & { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>;
}

const BUFFER = 1000;
const MAX_RESULT_CHARS = 2000;
const SHELL_META = /[;&|`$<>(){}\\\n]/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EDGECODER_SESSIONS_DIR || join(homedir(), ".edgecoder", "sessions");
}

/** The model id clients show ("network/qwen3-coder:30b@gpu", "auto", a local tag). */
export function modelIdOf(s: Pick<SessionData, "model" | "compute">): string {
  const c = s.compute;
  if (c.target === "auto") return "auto";
  if (c.target === "local") return s.model;
  if (c.target === "mine") return `mine/${s.model}`;
  if (c.target === "reserved") return `reserved/${c.reservationId ?? ""}/${s.model}`;
  return `network/${s.model}${c.computeClass && c.computeClass !== "any" ? `@${c.computeClass}` : ""}`;
}

/** A model id from a picker or `--model` as the session keeps it. */
export function parseModelId(id: string): { model: string; compute: ComputeSetting } {
  if (id === "auto") return { model: "auto", compute: { target: "auto" } };
  if (id.startsWith("mine/")) return { model: id.slice(5), compute: { target: "mine" } };
  const reserved = /^reserved\/([^/]+)\/(.+)$/.exec(id);
  if (reserved) return { model: reserved[2], compute: { target: "reserved", reservationId: reserved[1] } };
  if (id.startsWith("network/")) {
    const rest = id.slice(8);
    const at = rest.lastIndexOf("@");
    const cls = at > 0 ? rest.slice(at + 1) : "";
    return ["cpu", "apple", "gpu", "gpu.dc"].includes(cls)
      ? { model: rest.slice(0, at), compute: { target: "network", computeClass: cls } }
      : { model: rest, compute: { target: "network", computeClass: "any" } };
  }
  return { model: id, compute: { target: "local" } };
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

  constructor(private readonly env: TurnEnv, opts: { dir?: string | null; approvalTimeoutMs?: number } = {}) {
    this.dir = opts.dir === undefined ? defaultSessionsDir() : opts.dir;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 30 * 60_000;
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
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
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
      l = { seq: 0, buffer: [], listeners: new Map(), controller: null, running: null, pending: new Map() };
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

  /** Writes come from the client in control; with nobody in control, the first writer takes it. */
  private requireControl(id: string, client: ClientRef): Live {
    const l = this.liveOf(id);
    if (!l.controller) {
      l.controller = { ...client };
      this.emit(id, { type: "control", controller: l.controller });
    }
    if (l.controller.clientId !== client.clientId) {
      throw new SessionError("not_in_control", `${l.controller.label ?? `The ${l.controller.kind}`} is in control of this session. Take control to send.`, { controller: l.controller });
    }
    return l;
  }

  create(input: { projectRoot: string; model?: string; title?: string; autoApprove?: "none" | "edits"; client: ClientRef }): SessionData {
    const now = Date.now();
    const parsed = parseModelId(input.model || "auto");
    const s: SessionData = {
      id: randomUUID(),
      title: input.title?.trim() || "New session",
      projectRoot: input.projectRoot,
      branch: this.env.branch?.(input.projectRoot) ?? null,
      model: parsed.model,
      compute: parsed.compute,
      autoApprove: input.autoApprove ?? "none",
      alwaysShell: [],
      origin: input.client.kind,
      published: false,
      createdAt: now,
      updatedAt: now,
      cSats: 0,
      transcript: [],
    };
    this.sessions.set(s.id, s);
    this.liveOf(s.id).controller = { ...input.client };
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
          origin: s.origin,
          published: s.published,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messages: s.transcript.length,
          running: !!l.running,
          live: s.published && (clients.length > 0 || !!l.running),
          controller: l.controller,
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
      controller: l.controller,
      clients: this.clientsOf(l),
      running: l.running ? { turnId: l.running.turnId, text: l.running.text, events: plain(l.running.events) } : null,
      pending: [...l.pending.values()].map((p) => ({ id: p.id, tool: p.tool, args: plain(p.args) })),
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

  /** Throws unless `client` may write (taking control when nobody has it). */
  assertControl(id: string, client: ClientRef): void {
    this.need(id);
    this.requireControl(id, client);
  }

  takeControl(id: string, client: ClientRef): ClientRef {
    this.need(id);
    const l = this.liveOf(id);
    l.controller = { ...client };
    this.emit(id, { type: "control", controller: l.controller });
    return l.controller;
  }

  release(id: string, client: ClientRef): void {
    this.need(id);
    const l = this.liveOf(id);
    if (l.controller?.clientId !== client.clientId) return;
    l.controller = null;
    this.emit(id, { type: "control", controller: null });
  }

  /** Start a turn with the controller's message; resolves with the turn id once it has started. */
  send(id: string, text: string, client: ClientRef): string {
    const s = this.need(id);
    const l = this.requireControl(id, client);
    if (l.running) throw new SessionError("busy", "A reply is still running. Wait for it or stop it first.");
    if (!text.trim()) throw new SessionError("invalid", "The message is empty.");
    const entry: TranscriptEntry = { id: randomUUID(), role: "user", content: text, at: Date.now(), by: client.kind };
    s.transcript.push(entry);
    if (s.title === "New session") s.title = text.trim().split("\n")[0].slice(0, 60) + (text.length > 60 ? "…" : "");
    this.save(s);
    this.emit(id, { type: "message", entry });
    const turnId = randomUUID();
    const running: Running = { turnId, abort: new AbortController(), text: "", events: [], changed: [], done: Promise.resolve() };
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
        r.usage = { cSats: Number(((r.usage?.cSats ?? 0) + cSats).toFixed(6)), where: e.where };
        s.cSats = Number((s.cSats + cSats).toFixed(6));
      }
      if (e.type === "status" && e.message.startsWith("Auto: ")) r.usage = { cSats: r.usage?.cSats ?? 0, where: e.message.slice(6) };
      if (e.type !== "done") r.events.push(storable(e));
      this.emit(id, { type: "agent", turnId: r.turnId, event: e });
    };
    try {
      this.env.checkpoints.begin(r.turnId, s.projectRoot);
      sendEvent({ type: "turn", id: r.turnId });
      const exec = this.env.executor(s);
      const messages = s.transcript.filter((t) => t.role === "user" || t.role === "assistant").map((t) => ({ role: t.role, content: t.content }));
      await runAgentLoop({
        chat: this.env.chat(s, sendEvent, r.abort.signal),
        systemPrompt: await this.env.systemPrompt(s),
        messages,
        sendEvent,
        isCancelled: () => r.abort.signal.aborted,
        tools: this.env.tools?.(s),
        ...(this.env.contextWindow ? { contextWindow: () => this.env.contextWindow!(s) } : {}),
        ...(this.env.summarize ? { summarize: this.env.summarize(s, (e) => e.type === "usage" && sendEvent(e), r.abort.signal) } : {}),
        runTool: makeToolRunner({
          prepare: exec.prepare,
          execute: exec.execute,
          sendEvent,
          waitForApproval: (callId, tool, args) => this.waitForApproval(s, l, r, callId, tool, args),
          captureBeforeWrite: (path) => this.env.checkpoints.capture(r.turnId, path),
          turnId: r.turnId,
          autoApproveEdits: () => s.autoApprove === "edits",
          alwaysAllowed: (tool, args) => tool === "run_shell" && s.alwaysShell.includes(shellPrefix(args.command) ?? "\0"),
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
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "assistant",
        content: stopped ? `${r.text}\n\n_(stopped)_` : r.text,
        at: Date.now(),
        events: r.events,
        turnId: r.turnId,
        ...(r.changed.length ? { changedFiles: [...r.changed] } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
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
    }
  }

  private waitForApproval(s: SessionData, l: Live, r: Running, callId: string, tool: ToolName, args: Record<string, unknown>): Promise<boolean> {
    // "Always" answers from earlier in this session (never for the tools that always ask).
    if (!ALWAYS_ASK_TOOLS.has(tool)) {
      const prefix = tool === "run_shell" ? shellPrefix(args.command) : null;
      const always =
        (prefix !== null && s.alwaysShell.includes(prefix)) ||
        ((tool === "write_file" || tool === "edit_file") && s.autoApprove === "edits" && protectedToolPath(args.path) === null);
      if (always) {
        this.emit(s.id, { type: "approval", id: callId, approved: true, by: "always" });
        return Promise.resolve(true);
      }
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

  approve(id: string, callId: string, approved: boolean, client: ClientRef, always = false): void {
    const s = this.need(id);
    const l = this.requireControl(id, client);
    const p = l.pending.get(callId);
    if (!p) throw new SessionError("not_found", "No tool call is waiting with that id.");
    if (approved && always && !ALWAYS_ASK_TOOLS.has(p.tool)) {
      if (p.tool === "write_file" || p.tool === "edit_file") s.autoApprove = "edits";
      if (p.tool === "run_shell") {
        const prefix = shellPrefix(p.args.command);
        if (prefix && !s.alwaysShell.includes(prefix)) s.alwaysShell.push(prefix);
      }
      this.save(s);
      this.emit(id, { type: "settings", autoApprove: s.autoApprove, alwaysShell: [...s.alwaysShell] });
    }
    l.pending.delete(callId);
    clearTimeout(p.timer);
    this.emit(id, { type: "approval", id: callId, approved, by: client.kind });
    p.resolve(approved);
  }

  /** Stop the running turn (pending approvals are rejected; what was written stays, undoable). */
  cancel(id: string, client: ClientRef): boolean {
    this.need(id);
    const l = this.requireControl(id, client);
    if (!l.running) return false;
    l.running.abort.abort();
    for (const [callId, p] of l.pending) {
      clearTimeout(p.timer);
      l.pending.delete(callId);
      this.emit(id, { type: "approval", id: callId, approved: false, by: "stopped" });
      p.resolve(false);
    }
    return true;
  }

  update(id: string, patch: { model?: string; title?: string; autoApprove?: "none" | "edits" }, client: ClientRef): SessionData {
    const s = this.need(id);
    this.requireControl(id, client);
    if (patch.model) {
      const p = parseModelId(patch.model);
      s.model = p.model;
      s.compute = p.compute;
    }
    if (patch.title?.trim()) s.title = patch.title.trim().slice(0, 120);
    if (patch.autoApprove) s.autoApprove = patch.autoApprove;
    this.save(s);
    this.emit(id, { type: "settings", model: modelIdOf(s), title: s.title, autoApprove: s.autoApprove, alwaysShell: [...s.alwaysShell] });
    return plain(s);
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
      ? s.transcript.find((t) => t.turnId === turnId && t.role === "assistant")
      : [...s.transcript].reverse().find((t) => t.role === "assistant" && t.changedFiles?.length && !t.undone);
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
    this.emit(id, { type: "deleted" });
    this.sessions.delete(id);
    this.live.delete(id);
    if (this.dir) rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  /** Resolves when no turn is running (tests, shutdown). */
  async idle(id: string): Promise<void> {
    await this.live.get(id)?.running?.done;
  }

  /** Stop every running turn (provider shutdown). */
  shutdown(): void {
    for (const l of this.live.values()) l.running?.abort.abort();
  }
}

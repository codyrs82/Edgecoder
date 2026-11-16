// A shared session (one published from `edgecoder code`) as the Code view shows it: the transcript
// with each reply's tool calls, the reply streaming now, the messages queued for the next turn and
// who is connected. Sessions are co-edited: every attached client may send, approve and change
// settings; notes say what the other client did ("Approved in the terminal").
// Built from the provider's snapshot, then kept up to date by its events (GET /v1/ide/sessions/:id/events).
import { applyAgentEvent, markApproval, type AgentTurn } from "./agent-events";
import type { IdeStreamEvent, SessionClientRef, SessionEntry, SessionEvent, SessionSnapshotView } from "./api";
import type { ToolEvent } from "./types";

export interface LiveMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Which client sent a user message ("terminal", "desktop"). */
  by?: string;
  toolEvents?: ToolEvent[];
  turnId?: string;
  changedFiles?: string[];
  usage?: { cSats: number; where?: string; calls?: import("./served").CallUsage[] };
}

export interface QueuedView {
  id: string;
  text: string;
  /** "the terminal", "the EdgeCoder app". */
  from: string;
}

export interface LiveView {
  id: string;
  title: string;
  projectRoot: string;
  model: string;
  /** ask | auto-edits | auto. */
  mode: string;
  seq: number;
  /** Always null now (co-editing); kept for older providers' snapshots. */
  controller: SessionClientRef | null;
  clients: SessionClientRef[];
  messages: LiveMessage[];
  /** The reply streaming now (null when idle). */
  streaming: AgentTurn | null;
  /** Messages waiting for the next turn, in order. */
  queue: QueuedView[];
  /** The last few things another client did, newest last. */
  notes: string[];
  /** The provider can't replay what was missed: fetch the snapshot again. */
  needsResync: boolean;
  deleted: boolean;
}

const FROM: Record<string, string> = { terminal: "the terminal", desktop: "the EdgeCoder app", api: "a script" };
/** "the terminal" for a session event's client (kind and label). */
export function fromWhom(by: unknown, label?: unknown): string {
  if (by === "desktop") return "the EdgeCoder app";
  if (by === "terminal") return "the terminal";
  return typeof label === "string" && label ? label : FROM[String(by)] ?? "another client";
}

function queuedOf(q: { id: string; text: string; by?: string; label?: string }): QueuedView {
  return { id: q.id, text: q.text, from: fromWhom(q.by, q.label) };
}

const note = (v: LiveView, text: string): string[] => [...v.notes, text].slice(-4);

/** Fold a turn's agent events; calls that asked and got a result were approved (approvals are session events, not kept per turn). */
export function foldTurn(events: IdeStreamEvent[]): AgentTurn {
  let turn: AgentTurn = { text: "", toolEvents: [] };
  for (const e of events) turn = applyAgentEvent(turn, e).turn;
  return turn;
}

function settle(events: ToolEvent[]): ToolEvent[] {
  return events.map((e) =>
    e.type === "tool_call" && e.approval_status === "pending" && (e.result !== undefined || e.error !== undefined)
      ? { ...e, approval_status: /rejected/i.test(e.error ?? "") ? "rejected" : "approved" }
      : e,
  );
}

function messageOf(t: SessionEntry): LiveMessage | null {
  if (t.role === "user") return { id: t.id, role: "user", content: t.content, by: t.by };
  if (t.role !== "assistant") return null;
  const turn = foldTurn(t.events ?? []);
  return {
    id: t.id,
    role: "assistant",
    content: t.content,
    toolEvents: settle(turn.toolEvents),
    ...(t.turnId && t.changedFiles?.length && !t.undone ? { turnId: t.turnId, changedFiles: t.changedFiles } : {}),
    ...(t.usage ? { usage: t.usage } : {}),
  };
}

export function viewFromSnapshot(s: SessionSnapshotView): LiveView {
  let streaming: AgentTurn | null = null;
  if (s.running) {
    streaming = foldTurn(s.running.events);
    const pending = new Set(s.pending.map((p) => p.id));
    streaming = { ...streaming, toolEvents: streaming.toolEvents.map((e) => (e.type === "tool_call" && e.approval_status === "pending" && !pending.has(e.id ?? "") ? { ...e, approval_status: "approved" } : e)) };
  }
  return {
    id: s.session.id,
    title: s.session.title,
    projectRoot: s.session.projectRoot,
    model: s.session.model,
    mode: s.session.mode ?? (s.session.autoApprove === "edits" ? "auto-edits" : "ask"),
    seq: s.seq,
    controller: null,
    clients: s.clients,
    messages: s.session.transcript.map(messageOf).filter((m): m is LiveMessage => m !== null),
    streaming,
    queue: (s.queue ?? []).map(queuedOf),
    notes: [],
    needsResync: false,
    deleted: false,
  };
}

export function applySessionEvent(v: LiveView, e: SessionEvent): LiveView {
  const next = { ...v, seq: typeof e.seq === "number" ? Math.max(v.seq, e.seq) : v.seq };
  switch (e.type) {
    case "message": {
      const m = messageOf(e.entry as SessionEntry);
      const queue = v.queue.filter((q) => q.id !== (e.entry as SessionEntry).id);
      return m ? { ...next, queue, messages: [...v.messages, m], title: v.messages.length === 0 && v.title === "New session" ? m.content.slice(0, 60) : v.title } : { ...next, queue };
    }
    case "queued": {
      const q = e.entry as { id: string; text: string; by?: string; label?: string };
      return v.queue.some((x) => x.id === q.id) ? next : { ...next, queue: [...v.queue, queuedOf(q)] };
    }
    case "unqueued":
      return { ...next, queue: Array.isArray(e.queue) ? (e.queue as Array<{ id: string; text: string; by?: string; label?: string }>).map(queuedOf) : v.queue.filter((q) => q.id !== e.id) };
    case "stopping":
      return e.by === "desktop" ? next : { ...next, notes: note(v, `Stopped in ${fromWhom(e.by, e.label)}.`) };
    case "agent": {
      const ev = e.event as IdeStreamEvent;
      const base = ev.type === "turn" || !v.streaming ? { text: "", toolEvents: [] } : v.streaming;
      return { ...next, streaming: applyAgentEvent(base, ev).turn };
    }
    case "approval": {
      // Answered elsewhere: say where (the card here closes either way; the first answer won).
      const elsewhere = e.by === "terminal" || e.by === "api";
      const notes = elsewhere ? note(v, `${e.approved ? "Approved" : "Rejected"} in ${fromWhom(e.by, e.label)}.`) : v.notes;
      return v.streaming ? { ...next, notes, streaming: { ...v.streaming, toolEvents: markApproval(v.streaming.toolEvents, String(e.id), Boolean(e.approved)) } } : { ...next, notes };
    }
    case "turn_end": {
      const m = messageOf(e.entry as SessionEntry);
      return { ...next, streaming: null, messages: m ? [...v.messages, m] : v.messages };
    }
    case "control":
      return next;
    case "presence":
      return { ...next, clients: (e.clients as SessionClientRef[]) ?? [] };
    case "settings": {
      const changed = Array.isArray(e.changed) ? (e.changed as string[]) : [];
      const what = [changed.includes("model") && typeof e.model === "string" ? `model to ${e.model}` : "", (changed.includes("mode") || changed.includes("autoApprove")) && typeof e.mode === "string" ? `mode to ${e.mode}` : ""].filter(Boolean).join(" and ");
      const notes = e.by && e.by !== "desktop" && what ? note(v, `${fromWhom(e.by, e.label).replace(/^the t/, "The t").replace(/^the E/, "The E")} changed the ${what}.`) : v.notes;
      return { ...next, notes, ...(typeof e.model === "string" ? { model: e.model } : {}), ...(typeof e.title === "string" ? { title: e.title } : {}), ...(typeof e.mode === "string" ? { mode: e.mode } : {}) };
    }
    case "undo": {
      const turnId = String(e.turnId);
      return { ...next, messages: v.messages.map((m) => (m.turnId === turnId ? { ...m, turnId: undefined, changedFiles: undefined } : m)) };
    }
    case "cleared":
      return { ...next, messages: [], title: "New session" };
    case "resync":
      return { ...next, needsResync: true };
    case "deleted":
      return { ...next, deleted: true, streaming: null };
    default:
      return next;
  }
}

/** "Terminal and EdgeCoder app connected": who else is on the session, for the header. */
export function presenceText(v: LiveView, me: SessionClientRef): string {
  const others = v.clients.filter((c) => c.clientId !== me.clientId);
  const terminal = others.some((c) => c.kind === "terminal");
  if (terminal) return "Terminal and EdgeCoder app connected";
  if (others.length) return `${others.map((c) => c.label ?? c.kind).join(", ")} and this app connected`;
  return "Only this app is connected";
}

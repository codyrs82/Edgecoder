// A shared session (one published from `edgecoder code`) as the Code view shows it: the transcript
// with each reply's tool calls, the reply streaming now, who is in control and who is watching.
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
  usage?: { cSats: number; where?: string };
}

export interface LiveView {
  id: string;
  title: string;
  projectRoot: string;
  model: string;
  seq: number;
  controller: SessionClientRef | null;
  clients: SessionClientRef[];
  messages: LiveMessage[];
  /** The reply streaming now (null when idle). */
  streaming: AgentTurn | null;
  /** The provider can't replay what was missed: fetch the snapshot again. */
  needsResync: boolean;
  deleted: boolean;
}

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
    seq: s.seq,
    controller: s.controller,
    clients: s.clients,
    messages: s.session.transcript.map(messageOf).filter((m): m is LiveMessage => m !== null),
    streaming,
    needsResync: false,
    deleted: false,
  };
}

export function applySessionEvent(v: LiveView, e: SessionEvent): LiveView {
  const next = { ...v, seq: typeof e.seq === "number" ? Math.max(v.seq, e.seq) : v.seq };
  switch (e.type) {
    case "message": {
      const m = messageOf(e.entry as SessionEntry);
      return m ? { ...next, messages: [...v.messages, m], title: v.messages.length === 0 && v.title === "New session" ? m.content.slice(0, 60) : v.title } : next;
    }
    case "agent": {
      const ev = e.event as IdeStreamEvent;
      const base = ev.type === "turn" || !v.streaming ? { text: "", toolEvents: [] } : v.streaming;
      return { ...next, streaming: applyAgentEvent(base, ev).turn };
    }
    case "approval":
      return v.streaming ? { ...next, streaming: { ...v.streaming, toolEvents: markApproval(v.streaming.toolEvents, String(e.id), Boolean(e.approved)) } } : next;
    case "turn_end": {
      const m = messageOf(e.entry as SessionEntry);
      return { ...next, streaming: null, messages: m ? [...v.messages, m] : v.messages };
    }
    case "control":
      return { ...next, controller: (e.controller as SessionClientRef | null) ?? null };
    case "presence":
      return { ...next, clients: (e.clients as SessionClientRef[]) ?? [] };
    case "settings":
      return { ...next, ...(typeof e.model === "string" ? { model: e.model } : {}), ...(typeof e.title === "string" ? { title: e.title } : {}) };
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

/** Whether `me` may write (send, approve); with nobody in control the first writer takes it. */
export function canWrite(v: LiveView, me: SessionClientRef): boolean {
  return !v.controller || v.controller.clientId === me.clientId;
}

// A Code view chat's mirror on the provider (src/apps/ide/desktop-chats.ts), so your phone and the
// web Code page can read and continue it while the Mac runs the work.
//
// The chat stays in this app (chat-store.ts) and its turns still go over /v1/ide/chat. The mirror
// gets the chat's messages (sync: when the chat opens and around each turn) and shows this app's
// running turn live to the phone. What the phone does comes back here: its messages, the replies
// to them and the turn running now (followed from the mirror's events), added to the chat by id.
import { applyAgentEvent, markApproval, type AgentTurn } from "./agent-events";
import type { CodeChatSync, IdeStreamEvent, SessionEntry, SessionEvent, SessionSnapshotView } from "./api";
import { foldTurn, viewFromSnapshot } from "./live-session";
import type { EngineMode } from "./permission-modes";
import type { ChatMessage, Conversation } from "./types";

/** The most messages one sync sends (the provider takes up to 2,000). */
export const MAX_SYNC = 1_000;
const MAX_CONTENT = 400_000;

/** The chat's messages the mirror doesn't have yet (not in `synced`), as a sync sends them. */
export function syncMessages(convo: Conversation, synced: ReadonlySet<string> = new Set()): CodeChatSync["messages"] {
  return convo.messages
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => (m.role === "user" || m.role === "assistant") && !synced.has(m.id))
    .slice(-MAX_SYNC)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content.length > MAX_CONTENT ? `${m.content.slice(0, MAX_CONTENT)}…` : m.content,
      at: m.timestamp,
      ...(m.turnId ? { turnId: m.turnId } : {}),
      ...(m.changedFiles?.length ? { changedFiles: m.changedFiles.slice(0, 500) } : {}),
      ...(m.plan ? { plan: true } : {}),
    }));
}

/** A message from the mirror (the phone's, or the reply to it) as the chat keeps it. */
export function messageFromEntry(e: SessionEntry): ChatMessage | null {
  if (e.role === "user") return { id: e.id, role: "user", content: e.content, timestamp: e.at };
  if (e.role !== "assistant") return null;
  const turn = foldTurn(e.events ?? []);
  const toolEvents = turn.toolEvents.map((t) =>
    t.type === "tool_call" && t.approval_status === "pending" && (t.result !== undefined || t.error !== undefined)
      ? { ...t, approval_status: /rejected/i.test(t.error ?? "") ? ("rejected" as const) : ("approved" as const) }
      : t,
  );
  return {
    id: e.id,
    role: "assistant",
    content: e.content,
    timestamp: e.at,
    ...(toolEvents.length ? { toolEvents } : {}),
    ...(e.turnId ? { turnId: e.turnId } : {}),
    ...(e.changedFiles?.length && !e.undone ? { changedFiles: e.changedFiles } : {}),
    ...(e.usage ? { usage: { cSats: e.usage.cSats, ...(e.usage.where ? { where: e.usage.where } : {}), ...(e.usage.usd ? { usd: e.usage.usd } : {}) } } : {}),
    ...(e.plan ? { plan: true } : {}),
  };
}

/**
 * Adds to `convo` the mirror's messages that came from elsewhere (the phone) and it doesn't have:
 * not by this app, not already there by id, and no reply to a turn it already shows. Returns how
 * many were added.
 */
export function mergeEntries(convo: Conversation, entries: SessionEntry[]): number {
  const ids = new Set(convo.messages.map((m) => m.id));
  const turns = new Set(convo.messages.map((m) => m.turnId).filter(Boolean));
  let added = 0;
  for (const e of entries) {
    if (e.by === "desktop" || ids.has(e.id) || (e.role === "assistant" && e.turnId && turns.has(e.turnId))) continue;
    const m = messageFromEntry(e);
    if (!m) continue;
    convo.messages.push(m);
    ids.add(m.id);
    if (m.turnId) turns.add(m.turnId);
    added++;
  }
  if (added) convo.updatedAt = Date.now();
  return added;
}

export interface MirrorDeps {
  sync: (body: CodeChatSync) => Promise<{ sessionId: string }>;
  snapshot: (sessionId: string) => Promise<SessionSnapshotView>;
  follow: (sessionId: string, since: number, onEvent: (e: SessionEvent) => void, signal: AbortSignal) => Promise<void>;
}

export interface MirrorHandlers {
  /** This app is streaming its own turn now (the mirror's running turn is that one). */
  ownTurn: () => boolean;
  /** Messages from the phone to add to the chat. */
  onEntries: (entries: SessionEntry[]) => void;
  /** A turn the phone started is running (null: none now). */
  onRemoteTurn: (turn: AgentTurn | null, turnId: string | null) => void;
}

/** One open Code view chat's mirror: sync, then follow its events. */
export class CodeChatMirror {
  chatId: string | null = null;
  sessionId: string | null = null;
  remoteTurnId: string | null = null;
  private remote: AgentTurn | null = null;
  private synced = new Set<string>();
  private settingsKey = "";
  private follow: AbortController | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MirrorDeps, private readonly on: MirrorHandlers) {}

  /**
   * Sync `convo` (the first sync makes the mirror and starts following it). Syncs run one at a
   * time; a failure (an older provider) leaves the chat as it was. Resolves with the mirror's id.
   */
  sync(convo: Conversation, settings: { mode?: EngineMode; model?: string } = {}): Promise<string | null> {
    const run = this.queue.then(() => this.syncNow(convo, settings)).catch(() => null);
    this.queue = run;
    return run;
  }

  private async syncNow(convo: Conversation, settings: { mode?: EngineMode; model?: string }): Promise<string | null> {
    if (!convo.projectRoot) return null;
    if (this.chatId !== convo.id) this.detach();
    this.chatId = convo.id;
    const messages = syncMessages(convo, this.synced);
    const key = `${settings.mode ?? ""}|${settings.model ?? ""}`;
    if (this.sessionId && messages.length === 0 && (key === "|" || key === this.settingsKey)) return this.sessionId;
    this.settingsKey = key === "|" ? this.settingsKey : key;
    const r = await this.deps.sync({ chatId: convo.id, projectRoot: convo.projectRoot, title: convo.title, messages, ...(settings.mode ? { mode: settings.mode } : {}), ...(settings.model ? { model: settings.model } : {}) });
    if (this.chatId !== convo.id) return null;
    for (const m of messages) this.synced.add(m.id);
    if (this.sessionId !== r.sessionId) {
      this.sessionId = r.sessionId;
      await this.refresh();
    }
    return r.sessionId;
  }

  /** Fetch the mirror again: add what the phone did and show its running turn, then follow from there. */
  async refresh(): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    const snap = await this.deps.snapshot(id).catch(() => null);
    if (!snap || this.sessionId !== id) return;
    for (const e of snap.session.transcript) this.synced.add(e.id);
    this.on.onEntries(snap.session.transcript);
    const view = viewFromSnapshot(snap);
    this.setRemote(snap.running && !this.on.ownTurn() ? view.streaming : null, snap.running?.turnId ?? null);
    this.follow?.abort();
    const ctl = new AbortController();
    this.follow = ctl;
    void this.deps.follow(id, snap.seq, (e) => this.onEvent(e), ctl.signal);
  }

  /** Stop following (another chat opened, or the panel closed). */
  detach(): void {
    this.follow?.abort();
    this.follow = null;
    this.chatId = null;
    this.sessionId = null;
    this.synced = new Set();
    this.settingsKey = "";
    this.setRemote(null, null);
  }

  private setRemote(turn: AgentTurn | null, turnId: string | null): void {
    const had = this.remote !== null;
    this.remote = turn;
    this.remoteTurnId = turn ? turnId : null;
    if (turn || had) this.on.onRemoteTurn(turn, this.remoteTurnId);
  }

  onEvent(e: SessionEvent): void {
    switch (e.type) {
      case "message": {
        const entry = e.entry as SessionEntry;
        this.synced.add(entry.id);
        if (entry.by !== "desktop") this.on.onEntries([entry]);
        return;
      }
      case "agent": {
        // This app's own turn shows from its own stream.
        if (this.on.ownTurn() && !this.remote) return;
        const ev = e.event as IdeStreamEvent;
        const base = ev.type === "turn" || !this.remote ? { text: "", toolEvents: [] } : this.remote;
        this.setRemote(applyAgentEvent(base, ev).turn, String(e.turnId ?? ""));
        return;
      }
      case "approval":
        if (this.remote) this.setRemote({ ...this.remote, toolEvents: markApproval(this.remote.toolEvents, String(e.id), Boolean(e.approved)) }, this.remoteTurnId);
        return;
      case "turn_end": {
        const entry = e.entry as SessionEntry;
        this.synced.add(entry.id);
        if (entry.by !== "desktop") this.on.onEntries([entry]);
        if (this.remote) this.setRemote(null, null);
        return;
      }
      case "resync":
        void this.refresh();
        return;
      case "deleted":
        this.detach();
        return;
    }
  }
}

const BACKFILL_KEY = "edgecoder-code-chats-mirrored";
/** How many of the most recent Code view chats the backfill keeps mirrored. */
export const MAX_BACKFILL = 100;

/**
 * Sync every recent Code view chat that changed since it was last synced, so chats made before the
 * mirror existed (or changed while the provider was down) reach the phone without being opened.
 * Returns how many were synced; failures are retried next time.
 */
export async function backfillCodeChats(convos: Conversation[], sync: MirrorDeps["sync"], storage: Pick<Storage, "getItem" | "setItem"> | null = globalThis.localStorage ?? null): Promise<number> {
  let done: Record<string, number> = {};
  try {
    done = JSON.parse(storage?.getItem(BACKFILL_KEY) ?? "{}") as Record<string, number>;
  } catch {
    done = {};
  }
  const due = convos
    .filter((c) => (c.source ?? "chat") === "editor" && c.projectRoot && c.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_BACKFILL);
  const next: Record<string, number> = {};
  let synced = 0;
  for (const c of due) {
    if (done[c.id] === c.updatedAt) {
      next[c.id] = c.updatedAt;
      continue;
    }
    try {
      await sync({ chatId: c.id, projectRoot: c.projectRoot!, title: c.title, messages: syncMessages(c), ...(c.permissionMode ? { mode: c.permissionMode } : {}) });
      next[c.id] = c.updatedAt;
      synced++;
    } catch {
      // the provider is down or older: try again next time
    }
  }
  try {
    storage?.setItem(BACKFILL_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the next run syncs again (the provider adds nothing twice)
  }
  return synced;
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * What this computer is doing right now, for the desktop's Settings → Active work, and the recent
 * requests that no other store keeps (calls to the OpenAI / Anthropic endpoints), for Settings → Tasks.
 *
 *  - ActivityTracker: the owner's own requests through this provider while they run (chat turns,
 *    Code turns, API calls), with the served line of each model call, then a short in-memory history.
 *  - agentView: this machine's agent from the local forwarder's /forward/health (coordinator,
 *    paused / draining, slots, the jobs it serves). A served job is "you" only when its task id is
 *    one this provider sent; anything else is "someone on the network". No other account, prompt
 *    or machine of anyone else is ever exposed.
 */

import type { IdeStreamEvent } from "./tool-types.js";
import { memoryView, type MemoryOverview } from "./network-inference.js";

export type ActivityKind = "chat" | "code" | "bot" | "tentacle" | "api";
export type ActivityStatus = "running" | "done" | "failed" | "cancelled";

type UsageEvent = Extract<IdeStreamEvent, { type: "usage" }>;

/** One model call of a request: what it cost and where it ran (the coordinator's served-by). */
export interface ActivityCall {
  cSats: number;
  where?: string;
  model?: string;
  served?: UsageEvent["served"];
  usd?: number;
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  /** First line of the request (or the bot / helper task). */
  title: string;
  /** Where it came from: "EdgeCoder chat", a bot's name, a session title, an API client. */
  source?: string;
  model?: string;
  startedAtMs: number;
  endedAtMs?: number;
  status: ActivityStatus;
  error?: string;
  cSats: number;
  calls: ActivityCall[];
  /** Tool calls so far ("read_file src/a.ts"), newest last, capped. */
  steps: string[];
  /** The latest status line while it runs. */
  progress?: string;
}

export interface ActivityHandle {
  readonly id: string;
  /** Feed the request's stream events (usage, tool calls, errors). */
  event(e: IdeStreamEvent | { type: string; [k: string]: unknown }): void;
  end(status?: Exclude<ActivityStatus, "running">, error?: string): void;
}

const MAX_RECENT = 200;
const MAX_STEPS = 40;
const MAX_CALLS = 50;

/** First non-empty line, trimmed to `n` characters. */
export function firstLine(text: unknown, n = 140): string {
  const s = typeof text === "string" ? text : "";
  const line = s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

/** "read_file src/a.ts", "run_command npm test": a tool call as one short line. */
export function stepText(tool: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const hint = ["path", "file", "command", "query", "pattern", "url", "branch", "title"].map((k) => a[k]).find((v) => typeof v === "string" && v);
  return firstLine(hint ? `${tool} ${hint}` : tool, 120);
}

export class ActivityTracker {
  private readonly live = new Map<string, ActivityItem>();
  private readonly finished: ActivityItem[] = [];
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  begin(input: { kind: ActivityKind; title: string; source?: string; model?: string }): ActivityHandle {
    const id = `act-${this.now().toString(36)}-${(++this.seq).toString(36)}`;
    const item: ActivityItem = {
      id,
      kind: input.kind,
      title: firstLine(input.title) || "(no text)",
      ...(input.source ? { source: input.source.slice(0, 80) } : {}),
      ...(input.model ? { model: input.model.slice(0, 120) } : {}),
      startedAtMs: this.now(),
      status: "running",
      cSats: 0,
      calls: [],
      steps: [],
    };
    this.live.set(id, item);
    let ended = false;
    return {
      id,
      event: (e) => {
        if (ended) return;
        const ev = e as Record<string, unknown> & { type: string };
        if (ev.type === "usage") {
          const u = ev as unknown as UsageEvent;
          const cSats = Number.isFinite(u.cSats) ? u.cSats : 0;
          item.cSats += cSats;
          if (item.calls.length < MAX_CALLS) item.calls.push({ cSats, ...(u.where ? { where: u.where } : {}), ...(u.model ? { model: u.model } : {}), ...(u.served ? { served: u.served } : {}), ...(u.usd ? { usd: u.usd } : {}) });
          if (u.model) item.model = u.model;
        } else if (ev.type === "tool_call" && typeof ev.tool === "string") {
          item.steps.push(stepText(ev.tool, ev.args));
          if (item.steps.length > MAX_STEPS) item.steps.shift();
        } else if (ev.type === "status" && typeof ev.message === "string") {
          item.progress = firstLine(ev.message, 160);
        } else if (ev.type === "error" && typeof ev.message === "string") {
          item.error = firstLine(ev.message, 300);
        }
      },
      end: (status, error) => {
        if (ended) return;
        ended = true;
        this.live.delete(id);
        item.status = status ?? (item.error ? "failed" : "done");
        if (error) item.error = firstLine(error, 300);
        item.endedAtMs = this.now();
        delete item.progress;
        this.finished.unshift(item);
        if (this.finished.length > MAX_RECENT) this.finished.length = MAX_RECENT;
      },
    };
  }

  /** Requests running now, oldest first. */
  running(): ActivityItem[] {
    return [...this.live.values()].map(copy).sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  /** Finished requests since the provider started, newest first. */
  recent(kinds?: ActivityKind[]): ActivityItem[] {
    return this.finished.filter((i) => !kinds || kinds.includes(i.kind)).map(copy);
  }
}

const copy = (i: ActivityItem): ActivityItem => ({ ...i, calls: i.calls.map((c) => ({ ...c })), steps: [...i.steps] });

// ---------------------------------------------------------------------------
// This machine's agent, from /forward/health
// ---------------------------------------------------------------------------

export interface ServedJobView {
  id: string;
  kind: "inference" | "code";
  model: string | null;
  startedAtMs: number;
  elapsedMs: number;
  outputTokens: number;
  /** "you": a request this computer sent; "network": someone else's (never who). */
  requester: "you" | "network";
}

export interface AgentView {
  /** The forwarder answered. */
  reachable: boolean;
  agentId: string | null;
  coordinatorUrl: string | null;
  registered: boolean;
  region: string | null;
  paused: { reason: string; sinceMs: number } | null;
  draining: boolean;
  claims: number;
  slots: { total: number; busy: number } | null;
  computeClass: string | null;
  tier: string | null;
  jobs: ServedJobView[];
  /** An older agent that does not report the jobs it serves. */
  jobsUnknown: boolean;
  /** The host memory guard: pressure, paused for memory, loaded and served models (memory-manager.ts). */
  memory: MemoryOverview | null;
}

const str = (v: unknown, n = 200): string | null => (typeof v === "string" && v ? v.slice(0, n) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The forwarder's /forward/health as Active work shows it; `ownTaskIds` marks the owner's own jobs. */
export function agentView(raw: Record<string, unknown> | null, ownTaskIds: ReadonlySet<string>, now: number): AgentView {
  if (!raw) {
    return { reachable: false, agentId: null, coordinatorUrl: null, registered: false, region: null, paused: null, draining: false, claims: 0, slots: null, computeClass: null, tier: null, jobs: [], jobsUnknown: true, memory: null };
  }
  const p = raw.paused as { reason?: unknown; sinceMs?: unknown } | null | undefined;
  const steering = raw.steering && typeof raw.steering === "object" ? (raw.steering as Record<string, unknown>) : null;
  const serving = raw.serving && typeof raw.serving === "object" ? (raw.serving as Record<string, unknown>) : null;
  const slotsRaw = serving?.slots && typeof serving.slots === "object" ? (serving.slots as Record<string, unknown>) : null;
  const jobs: ServedJobView[] = Array.isArray(serving?.jobs)
    ? (serving!.jobs as Array<Record<string, unknown>>).filter((j) => j && typeof j === "object").slice(0, 32).map((j) => {
        const startedAtMs = num(j.startedAtMs) ?? now;
        const taskId = typeof j.taskId === "string" ? j.taskId : "";
        return {
          id: (str(j.id, 80) ?? "job").slice(0, 12),
          kind: j.kind === "inference" ? "inference" : "code",
          model: str(j.model, 120),
          startedAtMs,
          elapsedMs: Math.max(0, now - startedAtMs),
          outputTokens: num(j.outputTokens) ?? 0,
          requester: taskId && ownTaskIds.has(taskId) ? "you" : "network",
        };
      })
    : [];
  return {
    reachable: true,
    agentId: str(raw.agentId, 120),
    coordinatorUrl: str(raw.coordinatorUrl, 300),
    registered: raw.registered === true,
    region: steering ? str(steering.region, 40) : null,
    paused: p && typeof p === "object" && typeof p.reason === "string" ? { reason: p.reason.slice(0, 500), sinceMs: num(p.sinceMs) ?? 0 } : null,
    draining: raw.draining === true,
    claims: num(raw.claims) ?? 0,
    slots: slotsRaw ? { total: num(slotsRaw.total) ?? 0, busy: num(slotsRaw.busy) ?? 0 } : null,
    computeClass: serving ? str(serving.computeClass, 40) : null,
    tier: serving ? str(serving.tier, 40) : null,
    jobs,
    jobsUnknown: !serving,
    memory: memoryView(raw.memory) ?? null,
  };
}

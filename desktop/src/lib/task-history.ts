// Settings → Tasks: everything you ran from this computer, from the stores that already keep it:
// chat and Code turns (the app's conversations), sessions from `edgecoder code`, bot runs, helper
// (tentacle) jobs, and calls to the OpenAI / Anthropic endpoints (the IDE server's recent requests
// and the network's usage records). Pure: merged, filtered and exported here, drawn by TaskQueue.svelte.
import type { ChatMessage, Conversation, ToolEvent } from "./types";
import type { BotRun } from "./bots";
import type { CallUsage } from "./served";
import { servedLine } from "./served";
import type { TentacleItem } from "./tentacles";
import type { SessionEntry, UsageRecord, ActivityItem } from "./api";

export type TaskKind = "chat" | "code" | "bot" | "tentacle" | "api";
export type TaskStatus = "done" | "failed" | "cancelled" | "running";

export interface TaskRow {
  id: string;
  kind: TaskKind;
  atMs: number;
  /** First line of what was asked. */
  title: string;
  /** The conversation, bot, session or client it belongs to. */
  context?: string;
  /** The served line: model · machine/class · region (and tokens, cost). */
  where: string | null;
  model?: string;
  promptTokens: number | null;
  outputTokens: number | null;
  cSats: number | null;
  usd?: number;
  status: TaskStatus;
  error?: string;
  durationMs: number | null;
  /** Tool calls and other steps, in order. */
  steps: string[];
  /** Where this row came from (for the "couldn't read" note and debugging). */
  store: "conversations" | "sessions" | "bots" | "tentacles" | "recent" | "usage";
}

export const KIND_LABEL: Record<TaskKind, string> = { chat: "Chat", code: "Code", bot: "Bot", tentacle: "Helper", api: "API" };
export const STATUS_LABEL: Record<TaskStatus, string> = { done: "Done", failed: "Failed", cancelled: "Cancelled", running: "Running" };

const firstLine = (s: string | undefined, n = 140) => {
  const l = (s ?? "").split("\n").map((x) => x.trim()).find(Boolean) ?? "";
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

function tokensOf(calls: CallUsage[] | undefined): { promptTokens: number | null; outputTokens: number | null } {
  const served = (calls ?? []).filter((c) => c.served);
  if (!served.length) return { promptTokens: null, outputTokens: null };
  const sum = (k: "promptTokens" | "outputTokens") => served.reduce((n, c) => n + (c.served?.[k] ?? 0), 0);
  return { promptTokens: sum("promptTokens") || null, outputTokens: sum("outputTokens") || null };
}

function stepLines(events: Array<Pick<ToolEvent, "type" | "tool" | "args" | "error" | "command" | "exit_code">> | undefined): { steps: string[] } {
  const steps: string[] = [];
  for (const e of events ?? []) {
    if (e.type === "tool_call" && e.tool) {
      const a = (e.args ?? {}) as Record<string, unknown>;
      const hint = ["path", "file", "command", "query", "pattern", "url", "branch", "title"].map((k) => a[k]).find((v) => typeof v === "string" && v);
      steps.push(firstLine(hint ? `${e.tool} ${hint}` : e.tool, 120));
    } else if (e.type === "tool_result" && e.error) {
      steps.push(`  error: ${firstLine(e.error, 160)}`);
    } else if (e.type === "shell_output" && typeof e.exit_code === "number" && e.exit_code !== 0) {
      steps.push(`  exit ${e.exit_code}${e.command ? `: ${firstLine(e.command, 80)}` : ""}`);
    }
  }
  return { steps };
}

/** A chat or Code view conversation as one row per turn (your message and the reply to it). */
export function conversationTasks(c: Conversation): TaskRow[] {
  const kind: TaskKind = (c.source ?? "chat") === "editor" ? "code" : "chat";
  const rows: TaskRow[] = [];
  const msgs = c.messages ?? [];
  for (let i = 0; i < msgs.length; i++) {
    const u = msgs[i];
    if (u.role !== "user") continue;
    const a: ChatMessage | undefined = msgs[i + 1]?.role === "assistant" ? msgs[i + 1] : undefined;
    const text = a?.content ?? "";
    const failed = /^Error: /.test(text);
    const cancelled = /_\(stopped\)_\s*$/.test(text);
    const { steps } = stepLines(a?.toolEvents);
    rows.push({
      id: `${kind}:${c.id}:${u.id}`,
      kind,
      atMs: u.timestamp,
      title: firstLine(u.content) || "(no text)",
      context: c.title,
      where: a?.usage?.where ?? null,
      promptTokens: null,
      outputTokens: null,
      cSats: a?.usage ? a.usage.cSats : null,
      ...(a?.usage?.usd ? { usd: a.usage.usd } : {}),
      status: !a ? "failed" : failed ? "failed" : cancelled ? "cancelled" : "done",
      ...(!a ? { error: "No reply was saved" } : failed ? { error: firstLine(text.slice(7), 300) } : {}),
      durationMs: a && a.timestamp >= u.timestamp ? a.timestamp - u.timestamp : null,
      steps,
      store: "conversations",
    });
  }
  return rows;
}

/** A session (`edgecoder code`, or another session client) as one row per turn. */
export function sessionTasks(s: { id: string; title: string; model?: string; transcript: SessionEntry[] }): TaskRow[] {
  const rows: TaskRow[] = [];
  const t = s.transcript ?? [];
  for (let i = 0; i < t.length; i++) {
    const u = t[i];
    if (u.role !== "user") continue;
    let j = i + 1;
    while (j < t.length && t[j].role === "note") j++;
    const a = t[j]?.role === "assistant" ? t[j] : undefined;
    const calls = a?.usage?.calls;
    const errEvent = ((a?.events ?? []) as Array<{ type: string; message?: string }>).find((e) => e.type === "error");
    const { steps } = stepLines(a?.events as ToolEvent[] | undefined);
    rows.push({
      id: `session:${s.id}:${u.id}`,
      kind: "code",
      atMs: u.at,
      title: firstLine(u.content) || "(no text)",
      context: `edgecoder code · ${s.title}`,
      where: servedLine(calls) ?? a?.usage?.where ?? null,
      ...(calls?.length ? { model: calls[calls.length - 1].model } : s.model ? { model: s.model } : {}),
      ...tokensOf(calls),
      cSats: a?.usage ? a.usage.cSats : null,
      ...(a?.usage?.usd ? { usd: a.usage.usd } : {}),
      status: !a ? "cancelled" : errEvent ? "failed" : a.undone ? "cancelled" : "done",
      ...(errEvent?.message ? { error: firstLine(errEvent.message, 300) } : !a ? { error: "No reply (stopped or still running)" } : {}),
      durationMs: a && a.at >= u.at ? a.at - u.at : null,
      steps,
      store: "sessions",
    });
  }
  return rows;
}

const BOT_STATUS: Record<string, TaskStatus> = { done: "done", failed: "failed", budget: "failed", cancelled: "cancelled", interrupted: "cancelled", running: "running", needs_approval: "running" };

export function botTasks(bot: { id: string; name: string }, runs: BotRun[]): TaskRow[] {
  return runs.map((r) => ({
    id: `bot:${bot.id}:${r.id}`,
    kind: "bot" as const,
    atMs: r.startedAtMs,
    title: firstLine(r.summary) || `${r.trigger} run${r.source ? `: ${r.source}` : ""}`,
    context: bot.name,
    where: r.where ?? null,
    promptTokens: null,
    outputTokens: null,
    cSats: r.cSats,
    status: BOT_STATUS[r.status] ?? "done",
    ...(r.error ? { error: firstLine(r.error, 300) } : r.status === "budget" ? { error: "Stopped at the bot's daily budget" } : {}),
    durationMs: r.endedAtMs !== undefined ? r.endedAtMs - r.startedAtMs : null,
    steps: [
      `trigger: ${r.trigger}${r.source ? ` (${r.source})` : ""}`,
      ...(r.pullRequests ?? []).map((p) => `opened ${p.url}`),
      ...(r.note ? [r.note] : []),
    ],
    store: "bots" as const,
  }));
}

const TENTACLE_STATUS: Record<TentacleItem["status"], TaskStatus> = { queued: "running", running: "running", verifying: "running", passed: "done", failed: "failed", error: "failed", cancelled: "cancelled" };

export function tentacleTasks(sessionTitle: string, items: Array<TentacleItem & { startedAt?: number; finishedAt?: number }>): TaskRow[] {
  return items.map((t) => {
    const calls = t.result?.calls ?? t.calls ?? [];
    const start = t.startedAt ?? t.createdAt;
    return {
      id: `tentacle:${t.id}`,
      kind: "tentacle" as const,
      atMs: t.createdAt,
      title: firstLine(t.task) || "(helper)",
      context: sessionTitle,
      where: servedLine(calls) ?? (t.result ? `${t.result.model} · ${t.result.class}` : t.model ?? null),
      ...(t.result?.model ?? t.model ? { model: t.result?.model ?? t.model } : {}),
      ...tokensOf(calls),
      cSats: t.cSats,
      status: TENTACLE_STATUS[t.status] ?? "done",
      ...(t.result?.error ? { error: firstLine(t.result.error, 300) } : t.merge?.error ? { error: firstLine(t.merge.error, 300) } : {}),
      durationMs: t.finishedAt !== undefined ? t.finishedAt - start : null,
      steps: [
        ...(t.result?.summary ? [firstLine(t.result.summary, 200)] : []),
        ...(t.result?.filesTouched ?? []).map((f) => `changed ${f}`),
        ...(t.merge ? [`merge: ${t.merge.state}`] : []),
      ],
      store: "tentacles" as const,
    };
  });
}

/** A finished request the IDE server kept (calls to its OpenAI / Anthropic endpoints, mostly). */
export function recentTasks(items: ActivityItem[]): TaskRow[] {
  return items.map((i) => ({
    id: `recent:${i.id}`,
    kind: i.kind,
    atMs: i.startedAtMs,
    title: i.title,
    ...(i.source ? { context: i.source } : {}),
    where: servedLine(i.calls) ?? i.calls.at(-1)?.where ?? null,
    ...(i.model ? { model: i.model } : {}),
    ...tokensOf(i.calls),
    cSats: i.cSats,
    status: i.status,
    ...(i.error ? { error: i.error } : {}),
    durationMs: i.endedAtMs !== undefined ? i.endedAtMs - i.startedAtMs : null,
    steps: i.steps,
    store: "recent" as const,
  }));
}

/** Usage sources the app's own views write (already listed from their own stores). */
const APP_SOURCES = /^(EdgeCoder chat|edgecoder code|edgecoder tentacle|edgecoder compaction|bot .+|desktop)$/i;

/** Network usage records from other tools (connections, scripts on the API): one row each. */
export function usageTasks(records: UsageRecord[]): TaskRow[] {
  return records
    .filter((r) => !r.source || !APP_SOURCES.test(r.source))
    .map((r) => ({
      id: `usage:${r.id}`,
      kind: "api" as const,
      atMs: r.atMs,
      title: r.kind === "reservation" ? "Reservation" : r.kind === "job" ? "Code job" : r.model ?? "Model call",
      context: r.source ?? "API",
      where: [r.model, r.placement === "mine" ? "your machine" : r.placement === "reserved" ? "reserved machine" : "network", r.computeClass].filter(Boolean).join(" · "),
      ...(r.model ? { model: r.model } : {}),
      promptTokens: r.promptTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      cSats: r.costMsat / 1000,
      status: r.ok ? ("done" as const) : ("failed" as const),
      ...(r.ok ? {} : { error: "The network reported this request failed" }),
      durationMs: r.durationMs,
      steps: r.routing ? [`Auto: ${r.routing}`] : [],
      store: "usage" as const,
    }));
}

export interface HistorySources {
  conversations?: Conversation[];
  sessions?: Array<{ id: string; title: string; model?: string; transcript: SessionEntry[]; tentacles?: Array<TentacleItem & { startedAt?: number; finishedAt?: number }> }>;
  bots?: Array<{ bot: { id: string; name: string }; runs: BotRun[] }>;
  recent?: ActivityItem[];
  usage?: UsageRecord[];
}

/** Every source as one list, newest first; the same request is never listed twice. */
export function mergeTaskHistory(src: HistorySources): TaskRow[] {
  const rows: TaskRow[] = [
    ...(src.conversations ?? []).flatMap(conversationTasks),
    ...(src.sessions ?? []).flatMap((s) => [...sessionTasks(s), ...tentacleTasks(s.title, s.tentacles ?? [])]),
    ...(src.bots ?? []).flatMap((b) => botTasks(b.bot, b.runs)),
    // Chat and Code turns are in the conversations; the server's own list adds the API calls.
    ...recentTasks((src.recent ?? []).filter((i) => i.kind === "api")),
    ...usageTasks(src.usage ?? []),
  ];
  const seen = new Set<string>();
  return rows
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => b.atMs - a.atMs);
}

export interface TaskFilter {
  kind: TaskKind | "all";
  status: TaskStatus | "all";
  /** Only rows at or after this time (0: any time). */
  sinceMs: number;
  query: string;
}

export function filterTasks(rows: TaskRow[], f: TaskFilter): TaskRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (f.kind === "all" || r.kind === f.kind) &&
      (f.status === "all" || r.status === f.status) &&
      r.atMs >= f.sinceMs &&
      (!q || [r.title, r.context, r.where, r.model, r.error].some((v) => v && v.toLowerCase().includes(q))),
  );
}

const esc = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function tasksCsv(rows: TaskRow[]): string {
  const head = ["time", "kind", "what", "context", "where", "model", "prompt_tokens", "output_tokens", "csats", "status", "error", "seconds"];
  const body = rows.map((r) => [new Date(r.atMs).toISOString(), r.kind, r.title, r.context, r.where, r.model, r.promptTokens, r.outputTokens, r.cSats === null ? "" : r.cSats.toFixed(3), r.status, r.error, r.durationMs === null ? "" : (r.durationMs / 1000).toFixed(1)]);
  return [head, ...body].map((row) => row.map(esc).join(",")).join("\n") + "\n";
}

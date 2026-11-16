// Settings → Logs: the app's log (~/.edgecoder/agent.log) as readable rows. The services write pino
// JSON lines (a request is two lines, "incoming request" and "request completed", joined here by
// requestId); the agent and the BLE / gossip code write plain lines ("[agent:…] …").
import { redactText } from "./redact";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogRequest {
  method: string;
  url: string;
  status?: number;
  ms?: number;
}

export interface LogRow {
  seq: number;
  /** ms since epoch, when the line says. */
  time: number | null;
  service: string;
  level: LogLevel;
  message: string;
  request?: LogRequest;
  /** Polling the app does all the time (hidden by "Hide routine requests"). */
  routine: boolean;
  /** A plain text line (not JSON): shown highlighted when it is a warning or an error. */
  plain: boolean;
}

const PINO_LEVEL = (n: unknown): LogLevel => (typeof n !== "number" ? "info" : n >= 50 ? "error" : n >= 40 ? "warn" : n >= 30 ? "info" : "debug");

/** Paths the app and the services poll every few seconds. */
const ROUTINE_PATHS: RegExp[] = [
  /^\/model\/pull\/progress$/,
  /^\/v1\/ide\/bots$/,
  /^\/v1\/ide\/(activity|activity\/recent|logs|compute|project|sessions|connections|reservations|network\/world|frontier)$/,
  /^\/v1\/ide\/bots\/[^/]+\/(messages|history)$/,
  /^\/v1\/ide\/git\/state$/,
  /^\/v1\/ide\/fs\/git-status$/,
  /^\/v1\/ide\/index\/status$/,
  /^\/(health|status|metrics|identity|capacity|models)(\/runtime)?$/,
  /^\/mesh\/(peers|reputation)$/,
  /^\/dashboard\/api\/overview$/,
  /^\/model\/(list|status)$/,
  /^\/api\/(tags|ps|version)$/,
  /^\/v1\/models$/,
];

/** A successful GET / OPTIONS (or HEAD) to a polled path. */
export function isRoutineRequest(r: LogRequest): boolean {
  if (r.status !== undefined && r.status >= 400) return false;
  const m = r.method.toUpperCase();
  if (m === "OPTIONS") return true;
  if (m !== "GET" && m !== "HEAD") return false;
  const path = r.url.split("?")[0];
  return ROUTINE_PATHS.some((re) => re.test(path));
}

const ERROR_RE = /\b(error|errors|failed|failure|fatal|exception|crash(ed)?|refused|denied|blacklisted|unauthori[sz]ed|forbidden|panic)\b|\((4|5)\d\d\)/i;
const WARN_RE = /\b(warn(ing)?|unavailable|timed out|timeout|retry(ing)?|could ?n[o']t|cannot|can't|skipp(ed|ing)|offline|degraded|not found|missing|stale|slow)\b/i;

/** The level of a plain line, from what it says. */
export function plainLevel(line: string): LogLevel {
  if (ERROR_RE.test(line)) return "error";
  if (WARN_RE.test(line)) return "warn";
  return "info";
}

/** "agent", "ble", "gossip", … from a plain line's "[agent:desktop-1] …" prefix. */
function plainService(line: string): { service: string; rest: string } {
  const m = /^\[([A-Za-z][\w-]*)(?::[^\]]*)?\]\s*/.exec(line);
  if (!m) return { service: "app", rest: line };
  return { service: m[1].toLowerCase(), rest: line.slice(m[0].length) };
}

function reqSummary(r: LogRequest): string {
  return `${r.method} ${r.url}${r.status !== undefined ? ` → ${r.status}` : ""}${r.ms !== undefined ? ` · ${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms` : ""}`;
}

/** Extra fields of a pino line worth showing next to its message (an error's message, a reason). */
function extras(o: Record<string, unknown>): string {
  const bits: string[] = [];
  const err = o.err as { message?: unknown; type?: unknown } | undefined;
  if (err && typeof err.message === "string") bits.push(`${typeof err.type === "string" ? `${err.type}: ` : ""}${err.message}`);
  for (const k of ["error", "reason", "detail", "url", "status"]) {
    const v = o[k];
    if (typeof v === "string" || typeof v === "number") bits.push(`${k}=${v}`);
  }
  return bits.join(" · ");
}

/**
 * Turns appended log lines into rows. Stateful: an "incoming request" line waits for its
 * "request completed" line and the two become one row. Every message is redacted.
 */
export class LogParser {
  private seq = 0;
  private pending = new Map<string, { req: LogRequest; time: number | null; service: string }>();

  reset(): void {
    this.pending.clear();
  }

  push(lines: string[]): LogRow[] {
    const out: LogRow[] = [];
    for (const raw of lines) {
      const row = this.parse(raw);
      if (row) out.push(row);
    }
    return out;
  }

  private row(r: Omit<LogRow, "seq">): LogRow {
    return { ...r, seq: ++this.seq, message: redactText(r.message) };
  }

  private parse(raw: string): LogRow | null {
    const line = raw.replace(/\s+$/, "");
    if (!line) return null;
    if (line.startsWith("{")) {
      let o: Record<string, unknown> | null = null;
      try {
        const v = JSON.parse(line);
        o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
      } catch {
        o = null;
      }
      if (o) return this.json(o);
    }
    const { service, rest } = plainService(line);
    const level = plainLevel(line);
    return this.row({ time: null, service, level, message: rest || line, plain: true, routine: service === "gossip" && level === "info" });
  }

  private json(o: Record<string, unknown>): LogRow | null {
    const time = typeof o.time === "number" ? o.time : typeof o.time === "string" ? Date.parse(o.time) || null : null;
    const service = typeof o.service === "string" ? o.service : typeof o.name === "string" ? o.name : "app";
    const msg = typeof o.msg === "string" ? o.msg : typeof o.message === "string" ? o.message : "";
    const id = typeof o.requestId === "string" ? o.requestId : typeof o.reqId === "string" ? o.reqId : null;
    const req = o.req as { method?: unknown; url?: unknown } | undefined;
    const res = o.res as { statusCode?: unknown } | undefined;

    if (msg === "incoming request" && req && id) {
      this.pending.set(id, { req: { method: String(req.method ?? "?"), url: String(req.url ?? "?") }, time, service });
      if (this.pending.size > 2000) this.pending.delete(this.pending.keys().next().value as string);
      return null;
    }
    if (msg === "request completed" && res) {
      const start = id ? this.pending.get(id) : undefined;
      if (id) this.pending.delete(id);
      const status = typeof res.statusCode === "number" ? res.statusCode : undefined;
      const ms = typeof o.responseTime === "number" ? o.responseTime : undefined;
      const r: LogRequest = { method: start?.req.method ?? "?", url: start?.req.url ?? "(request)", ...(status !== undefined ? { status } : {}), ...(ms !== undefined ? { ms } : {}) };
      const level: LogLevel = status !== undefined && status >= 500 ? "error" : status !== undefined && status >= 400 ? "warn" : PINO_LEVEL(o.level);
      return this.row({ time: start?.time ?? time, service, level, message: reqSummary(r), request: r, plain: false, routine: start ? isRoutineRequest(r) : false });
    }
    const extra = extras(o);
    return this.row({ time, service, level: PINO_LEVEL(o.level), message: [msg || "(no message)", extra].filter(Boolean).join(" · "), plain: false, routine: false });
  }
}

export interface LogFilter {
  levels: Set<LogLevel>;
  service: string; // "" = all
  query: string;
  hideRoutine: boolean;
}

export function filterRows(rows: LogRow[], f: LogFilter): LogRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      f.levels.has(r.level === "debug" ? "info" : r.level) &&
      (!f.service || r.service === f.service) &&
      (!f.hideRoutine || !r.routine) &&
      (!q || r.message.toLowerCase().includes(q) || r.service.toLowerCase().includes(q)),
  );
}

export function rowTime(r: LogRow): string {
  if (r.time === null) return "";
  const d = new Date(r.time);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** "time · service · level · message" */
export function rowText(r: LogRow): string {
  return [r.time === null ? "--:--:--" : new Date(r.time).toISOString(), r.service, r.level.toUpperCase(), r.message].join(" · ");
}

/**
 * "Copy for support": the last `max` relevant lines (routine polling left out), strictly redacted
 * (tokens, keys, Authorization headers, invoices, long opaque strings; emails when asked).
 */
export function supportText(rows: LogRow[], opts: { max?: number; emails?: boolean; source?: string; now?: Date } = {}): string {
  const relevant = rows.filter((r) => !r.routine).slice(-(opts.max ?? 200));
  const head = [
    `EdgeCoder log excerpt (${opts.source ?? "agent.log"}), ${relevant.length} lines, copied ${(opts.now ?? new Date()).toISOString()}`,
    "Credentials are masked as [redacted].",
    "",
  ];
  return redactText([...head, ...relevant.map(rowText)].join("\n"), { strict: true, emails: opts.emails }) + "\n";
}

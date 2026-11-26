// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * When a worker should POST /register.
 *
 * The loop used to register on every tick (~1.2 s). The coordinator's behavioural
 * rule BHV008 ("registration storm": 10 registrations in 10 min) then auto-blacklisted
 * every healthy worker about 12 s after it joined. A worker now registers once per
 * coordinator session and re-registers only when the coordinator says it doesn't know
 * the agent (401 agent_not_registered), after a failover/offline recovery, or on a slow
 * refresh that stays well under the storm threshold.
 */

export const DEFAULT_REGISTER_REFRESH_MS = 4 * 60_000;

export interface RegistrationState {
  /** Coordinator URL the last successful /register went to, or null when (re)registration is needed. */
  registeredWithUrl: string | null;
  lastRegisteredAtMs: number;
}

export function registerRefreshMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENT_REGISTER_REFRESH_MS);
  // Never refresh faster than once a minute: 10 registrations in 10 minutes is the blacklist threshold.
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : DEFAULT_REGISTER_REFRESH_MS;
}

/** True when this tick should (re)register with `url`. */
export function shouldRegister(state: RegistrationState, url: string, nowMs: number, refreshMs = DEFAULT_REGISTER_REFRESH_MS): boolean {
  if (state.registeredWithUrl !== url) return true;
  return nowMs - state.lastRegisteredAtMs >= refreshMs;
}

/**
 * A 401 that means the coordinator holds no key for us: the coordinator restarted or evicted us.
 * Either the body says agent_not_registered, or it is the request gate's bare mesh_unauthorized
 * (coordinators before the gate gave a reason): a signed agent request only fails the gate when
 * the coordinator cannot check its signature, and registering again is the answer to that.
 */
export function isAgentNotRegisteredError(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string } | null;
  if (e?.statusCode !== 401 || typeof e.message !== "string") return false;
  if (e.message.includes("agent_not_registered")) return true;
  return /\{"error":"mesh_unauthorized"\}\s*$/.test(e.message);
}

/**
 * Re-registering at once (rather than after counting failures into offline mode) is limited to
 * once per this long, so a coordinator that keeps refusing us cannot drive a registration storm
 * (BHV008: 10 registrations in 10 minutes); past it the usual failure counting and backoff apply.
 */
export const QUICK_REREGISTER_MIN_INTERVAL_MS = 2 * 60_000;

/** Allows one immediate re-registration per QUICK_REREGISTER_MIN_INTERVAL_MS. */
export class QuickReregisterGate {
  private lastAtMs = Number.NEGATIVE_INFINITY;
  constructor(private readonly minIntervalMs = QUICK_REREGISTER_MIN_INTERVAL_MS) {}
  tryTake(nowMs = Date.now()): boolean {
    if (nowMs - this.lastAtMs < this.minIntervalMs) return false;
    this.lastAtMs = nowMs;
    return true;
  }
}

/**
 * Close codes by which the coordinator says it does not know this agent's key: 4005 (a connection
 * held for a registration that never came) and 4001 mesh_unauthorized (coordinators that refuse a
 * connection from an unregistered agent outright).
 */
export function isNotRegisteredWsClose(code: number, reason: string): boolean {
  return code === 4005 || (code === 4001 && reason === "mesh_unauthorized");
}

/** Client close code the agent uses to reopen its socket after registering again (a fresh bind). */
export const MESH_WS_REBIND_CLOSE_CODE = 4000;

/** The parts of a WebSocket closeForRebind uses (the `ws` client in the worker). */
export interface RebindableSocket {
  readyState: number;
  close(code: number, reason: string): void;
  terminate(): void;
}

/**
 * Close the mesh socket to bind again after registering, and drop it after `terminateAfterMs` if
 * its close has not completed by then (network run 12: the graceful close took ~5 s, and the socket
 * to the new coordinator waited for it). `closedState` is WebSocket.CLOSED.
 */
export function closeForRebind(ws: RebindableSocket, opts: { closedState: number; terminateAfterMs: number; setTimer?: (fn: () => void, ms: number) => void }): void {
  try {
    ws.close(MESH_WS_REBIND_CLOSE_CODE, "rebind_after_register");
  } catch {
    /* the close handler reconnects either way */
  }
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref?.());
  setTimer(() => {
    if (ws.readyState !== opts.closedState) ws.terminate();
  }, opts.terminateAfterMs);
}

/** Longest a worker waits on one 429 before trying again (a bad Retry-After must not park it). */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** Wait used when a 429 carries no usable Retry-After. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;

/** Retry-After (delta seconds or an HTTP date) in ms, or null when absent or unreadable. */
export function parseRetryAfterMs(value: unknown, nowMs = Date.now()): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (text === "") return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * A 429 from the coordinator: the agent is over its request rate. The answer is to wait the
 * Retry-After and carry on, never to re-register (a 401-style reaction): registering again on
 * every refusal is what trips the registration-storm rule (BHV008). Returns the wait in ms, or
 * null when the error is not a rate limit.
 */
export function rateLimitWaitMs(err: unknown): number | null {
  const e = err as { statusCode?: number; retryAfterMs?: number } | null;
  if (e?.statusCode !== 429) return null;
  const wait = typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : DEFAULT_RATE_LIMIT_WAIT_MS;
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(1_000, wait));
}

/** The parts of a /register reply the "registered" log line reports. */
export interface RegisterReply {
  accepted?: boolean;
  hardwareVerification?: { status?: unknown; grantedClass?: unknown; grantedTier?: unknown } | null;
}

/**
 * The line a worker logs after each successful /register: hosting guides use it as evidence that
 * the agent joined (agent id, coordinator, and the class and tier the coordinator granted).
 */
export function registeredLogLine(agentId: string, coordinatorUrl: string, reply: RegisterReply | undefined): string {
  const hv = reply?.hardwareVerification;
  const parts: string[] = [];
  if (hv && typeof hv.grantedClass === "string") parts.push(`class=${hv.grantedClass}`);
  if (hv && typeof hv.grantedTier === "string") parts.push(`tier=${hv.grantedTier}`);
  if (hv && typeof hv.status === "string") parts.push(`verification=${hv.status}`);
  return `[agent:${agentId}] registered with ${coordinatorUrl}${parts.length ? ` (${parts.join(" ")})` : ""}`;
}

/**
 * Refusals of /register that only the machine's owner can fix (enrolment): retrying every few
 * seconds changes nothing and only trips the coordinator's failed-registration limit.
 */
export const ENROLLMENT_REFUSAL_REASONS = ["node_not_enrolled", "registration_token_required", "registration_token_invalid", "node_kind_mismatch"] as const;
export type EnrollmentRefusalReason = (typeof ENROLLMENT_REFUSAL_REASONS)[number];

export interface EnrollmentRefusal {
  reason: EnrollmentRefusalReason;
  /** The node id the agent's registration token was issued for, when the coordinator said. */
  tokenNodeId?: string;
}

/** A 403 node_not_activated from /register whose reason is an enrolment problem, else null. */
export function enrollmentRefusalFromError(err: unknown): EnrollmentRefusal | null {
  const e = err as { statusCode?: number; message?: string } | null;
  if (e?.statusCode !== 403 || typeof e.message !== "string" || !e.message.includes("node_not_activated")) return null;
  const json = e.message.slice(e.message.indexOf("{"));
  let body: { reason?: unknown; tokenNodeId?: unknown } = {};
  try {
    body = JSON.parse(json) as typeof body;
  } catch {
    return null;
  }
  const reason = ENROLLMENT_REFUSAL_REASONS.find((r) => r === body.reason);
  if (!reason) return null;
  const tokenNodeId = typeof body.tokenNodeId === "string" && /^[A-Za-z0-9._-]{3,128}$/.test(body.tokenNodeId) ? body.tokenNodeId : undefined;
  return { reason, ...(tokenNodeId ? { tokenNodeId } : {}) };
}

/** The one line an agent logs when its enrolment is refused: what is wrong and how to fix it. */
/** The portal's host for log lines ("edgecoder.io" from https://edgecoder.io), or "the portal". */
export function portalLabel(portalUrl: string | undefined): string {
  try {
    return portalUrl ? new URL(portalUrl).host || "the portal" : "the portal";
  } catch {
    return "the portal";
  }
}

export function enrollmentRefusalMessage(agentId: string, refusal: EnrollmentRefusal, retryMs: number, portal = "the portal"): string {
  const retry = `Retrying in ${Math.round(retryMs / 1000)}s.`;
  const fix = "re-run the installer with an install key (EDGECODER_API_KEY), which enrols the right name";
  if (refusal.reason === "node_not_enrolled") {
    const tokenHint = refusal.tokenNodeId && refusal.tokenNodeId !== agentId
      ? ` Its registration token was issued for "${refusal.tokenNodeId}": re-run the installer with that token and it uses that name.`
      : "";
    return `[agent:${agentId}] This machine's id "${agentId}" isn't enrolled. Enroll it on ${portal} → Settings → Nodes with exactly this name, or ${fix}.${tokenHint} ${retry}`;
  }
  if (refusal.reason === "registration_token_required") {
    return `[agent:${agentId}] This machine ("${agentId}") has no registration token (AGENT_REGISTRATION_TOKEN). Enroll "${agentId}" on ${portal} → Settings → Nodes and re-run the installer with --token ${agentId}=<token>, or ${fix}. ${retry}`;
  }
  if (refusal.reason === "registration_token_invalid") {
    return `[agent:${agentId}] The registration token doesn't match the enrolment of "${agentId}" (it was re-enrolled, or the token is for another node). Generate a new token for "${agentId}" on ${portal} → Settings → Nodes and re-run the installer with --token ${agentId}=<token>, or ${fix}. ${retry}`;
  }
  return `[agent:${agentId}] "${agentId}" is enrolled as a different node type. Enroll it as an Agent on ${portal} → Settings → Nodes. ${retry}`;
}

export const ENROLLMENT_BACKOFF_BASE_MS = 60_000;
/** Network run 14: at most 30 minutes (was 15); an enrolment problem only the owner can fix. */
export const ENROLLMENT_BACKOFF_MAX_MS = 30 * 60_000;
/** Wait after the n-th consecutive enrolment refusal (1-based): 1, 2, 4, 8, 16 ... minutes, at most 30. */
export function enrollmentBackoffMs(refusals: number): number {
  return Math.min(ENROLLMENT_BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(refusals - 1, 10)), ENROLLMENT_BACKOFF_MAX_MS);
}

/** How often the same refusal is logged again while it lasts. */
export const ENROLLMENT_LOG_REPEAT_MS = 60 * 60_000;
/** Whether to log this refusal: the first, a changed one, or the same one an hour later. */
export function shouldLogEnrollmentRefusal(last: { key: string; atMs: number } | null, refusal: EnrollmentRefusal, nowMs: number): boolean {
  const key = enrollmentRefusalKey(refusal);
  return !last || last.key !== key || nowMs - last.atMs >= ENROLLMENT_LOG_REPEAT_MS;
}
export function enrollmentRefusalKey(refusal: EnrollmentRefusal): string {
  return `${refusal.reason}:${refusal.tokenNodeId ?? ""}`;
}

/**
 * Network run 14: the coordinator logged ~709 register_denied lines per 10 min (2,601 node_not_enrolled
 * from one legacy iOS id, CRS-NODE-001, every ~0.7 s). A denial is logged once per agent and reason
 * per REGISTER_DENIED_LOG_INTERVAL_MS, with how many were left out since; the 403 is unchanged.
 */
export const REGISTER_DENIED_LOG_INTERVAL_MS = 10 * 60_000;
export class RegisterDeniedLog {
  private readonly seen = new Map<string, { atMs: number; suppressed: number }>();
  constructor(private readonly intervalMs = REGISTER_DENIED_LOG_INTERVAL_MS, private readonly maxKeys = 10_000) {}

  /** Whether to log this denial now, and how many of the same were not logged since the last line; null: skip it. */
  take(agentId: string, reason: string, nowMs: number): { suppressed: number } | null {
    const key = `${agentId}\u0000${reason}`;
    const e = this.seen.get(key);
    if (e && nowMs - e.atMs < this.intervalMs) {
      e.suppressed++;
      return null;
    }
    if (!e && this.seen.size >= this.maxKeys) {
      for (const [k, v] of this.seen) if (nowMs - v.atMs >= this.intervalMs) this.seen.delete(k);
      if (this.seen.size >= this.maxKeys) this.seen.clear();
    }
    const suppressed = e?.suppressed ?? 0;
    this.seen.set(key, { atMs: nowMs, suppressed: 0 });
    return { suppressed };
  }
}

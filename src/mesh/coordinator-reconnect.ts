// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The "reconnect" frame a coordinator sends down each agent's mesh WebSocket as it stops for a
 * deploy or restart (src/swarm/coordinator/drain.ts), and the agent's side of it.
 *
 * The frame is signed with the coordinator's identity key and names one agent, so only the
 * coordinator the agent proved (its pinned key) can make it reconnect, and a frame cannot be
 * replayed to another agent. It carries a short delay plus jitter: agents come back spread out,
 * not all in the same second, once the new instance is up.
 *
 * On a verified frame the agent waits the delay, registers again (so the new instance knows it
 * before anything else), then opens the WebSocket, whose open republishes the bot and code relay
 * snapshots and the model state (worker-runner.ts connectMeshWebSocket).
 */
import { randomUUID } from "node:crypto";
import { signPayload, verifyPayload } from "./peer.js";

export const COORDINATOR_RECONNECT_FRAME_TYPE = "coordinator_reconnect";
const VERSION = 1;
/** A frame is good for this long after it was signed. */
export const RECONNECT_FRAME_LIFETIME_MS = 60_000;
/** The longest delay (plus jitter) an agent honours. */
export const RECONNECT_MAX_DELAY_MS = 60_000;
/** The agent gives up waiting for the re-registration after this and connects as usual. */
export const RECONNECT_PENDING_MAX_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;

export interface CoordinatorReconnectCommand {
  v: typeof VERSION;
  id: string;
  agentId: string;
  coordinatorId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** Wait at least this long before registering again ... */
  delayMs: number;
  /** ... plus a random share of this. */
  jitterMs: number;
  /** "draining": the coordinator is stopping (a deploy or restart). */
  reason: string;
}

export interface CoordinatorReconnectFrame {
  type: typeof COORDINATOR_RECONNECT_FRAME_TYPE;
  command: CoordinatorReconnectCommand;
  signature: string;
}

const signingPayload = (c: CoordinatorReconnectCommand) =>
  `edgecoder-coordinator-reconnect-v1\n${[c.v, c.id, c.agentId, c.coordinatorId, c.issuedAtMs, c.expiresAtMs, c.delayMs, c.jitterMs, c.reason].join("\n")}`;

export function createCoordinatorReconnectFrame(input: {
  agentId: string;
  coordinatorId: string;
  privateKeyPem: string;
  delayMs: number;
  jitterMs: number;
  reason?: string;
  nowMs?: number;
}): CoordinatorReconnectFrame {
  const issuedAtMs = input.nowMs ?? Date.now();
  const command: CoordinatorReconnectCommand = {
    v: VERSION,
    id: randomUUID(),
    agentId: input.agentId,
    coordinatorId: input.coordinatorId,
    issuedAtMs,
    expiresAtMs: issuedAtMs + RECONNECT_FRAME_LIFETIME_MS,
    delayMs: Math.max(0, Math.floor(input.delayMs)),
    jitterMs: Math.max(0, Math.floor(input.jitterMs)),
    reason: (input.reason ?? "draining").slice(0, 40)
  };
  return { type: COORDINATOR_RECONNECT_FRAME_TYPE, command, signature: signPayload(signingPayload(command), input.privateKeyPem) };
}

/**
 * The drain notice: sent by a coordinator to each connected agent the moment its drain starts (not
 * at the end, as the reconnect frame is). It says "serve through a peer meanwhile": the agent
 * registers with another coordinator at once for new work, finishes the claims it holds here, and
 * comes home once the restarted instance answers (src/mesh/drain-failover.ts). It is signed like
 * the reconnect frame, names one agent, and may name a peer coordinator (a hint only: the agent
 * still proves that coordinator's key before it sends it anything). Agents without this change
 * ignore the type and still get the reconnect frame at the end.
 */
export const COORDINATOR_DRAIN_NOTICE_FRAME_TYPE = "coordinator_drain_notice";

export interface CoordinatorDrainNoticeCommand {
  v: typeof VERSION;
  id: string;
  agentId: string;
  coordinatorId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** A peer coordinator's URL ("" when none is known). */
  peerUrl: string;
}

export interface CoordinatorDrainNoticeFrame {
  type: typeof COORDINATOR_DRAIN_NOTICE_FRAME_TYPE;
  command: CoordinatorDrainNoticeCommand;
  signature: string;
}

const noticeSigningPayload = (c: CoordinatorDrainNoticeCommand) =>
  `edgecoder-coordinator-drain-notice-v1\n${[c.v, c.id, c.agentId, c.coordinatorId, c.issuedAtMs, c.expiresAtMs, c.peerUrl].join("\n")}`;

export function createCoordinatorDrainNoticeFrame(input: { agentId: string; coordinatorId: string; privateKeyPem: string; peerUrl?: string | null; nowMs?: number }): CoordinatorDrainNoticeFrame {
  const issuedAtMs = input.nowMs ?? Date.now();
  const command: CoordinatorDrainNoticeCommand = {
    v: VERSION,
    id: randomUUID(),
    agentId: input.agentId,
    coordinatorId: input.coordinatorId,
    issuedAtMs,
    expiresAtMs: issuedAtMs + RECONNECT_FRAME_LIFETIME_MS,
    peerUrl: (input.peerUrl ?? "").slice(0, 300)
  };
  return { type: COORDINATOR_DRAIN_NOTICE_FRAME_TYPE, command, signature: signPayload(noticeSigningPayload(command), input.privateKeyPem) };
}

export function verifyCoordinatorDrainNoticeFrame(
  frame: unknown,
  ctx: { agentId: string; coordinator: { peerId: string; publicKeyPem: string } | null; nowMs?: number }
): { ok: true; command: CoordinatorDrainNoticeCommand } | { ok: false; reason: ReconnectFailure } {
  const f = frame as Partial<CoordinatorDrainNoticeFrame> | null;
  if (!f || typeof f !== "object" || f.type !== COORDINATOR_DRAIN_NOTICE_FRAME_TYPE || typeof f.signature !== "string") return { ok: false, reason: "malformed" };
  const c = f.command as Partial<CoordinatorDrainNoticeCommand> | undefined;
  if (
    !c || typeof c !== "object" || c.v !== VERSION || typeof c.id !== "string" || c.id.length > 64 || typeof c.agentId !== "string" ||
    typeof c.coordinatorId !== "string" || typeof c.peerUrl !== "string" || c.peerUrl.length > 300 || !isInt(c.issuedAtMs) || !isInt(c.expiresAtMs)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const command = c as CoordinatorDrainNoticeCommand;
  if (!ctx.coordinator) return { ok: false, reason: "no_verified_coordinator" };
  if (command.coordinatorId !== ctx.coordinator.peerId) return { ok: false, reason: "wrong_coordinator" };
  if (!verifyPayload(noticeSigningPayload(command), f.signature, ctx.coordinator.publicKeyPem)) return { ok: false, reason: "invalid_signature" };
  if (command.agentId !== ctx.agentId) return { ok: false, reason: "wrong_agent" };
  const now = ctx.nowMs ?? Date.now();
  if (command.issuedAtMs > now + MAX_FUTURE_SKEW_MS) return { ok: false, reason: "from_future" };
  if (now > command.expiresAtMs || command.expiresAtMs - command.issuedAtMs > RECONNECT_FRAME_LIFETIME_MS) return { ok: false, reason: "expired" };
  return { ok: true, command };
}

type ReconnectFailure = "malformed" | "no_verified_coordinator" | "wrong_coordinator" | "invalid_signature" | "wrong_agent" | "expired" | "from_future";

export type ReconnectVerdict =
  | { ok: true; command: CoordinatorReconnectCommand }
  | { ok: false; reason: ReconnectFailure };

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function verifyCoordinatorReconnectFrame(
  frame: unknown,
  ctx: { agentId: string; coordinator: { peerId: string; publicKeyPem: string } | null; nowMs?: number }
): ReconnectVerdict {
  const f = frame as Partial<CoordinatorReconnectFrame> | null;
  if (!f || typeof f !== "object" || f.type !== COORDINATOR_RECONNECT_FRAME_TYPE || typeof f.signature !== "string") return { ok: false, reason: "malformed" };
  const c = f.command as Partial<CoordinatorReconnectCommand> | undefined;
  if (
    !c || typeof c !== "object" || c.v !== VERSION || typeof c.id !== "string" || c.id.length > 64 || typeof c.agentId !== "string" ||
    typeof c.coordinatorId !== "string" || typeof c.reason !== "string" || !isInt(c.issuedAtMs) || !isInt(c.expiresAtMs) || !isInt(c.delayMs) || !isInt(c.jitterMs)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const command = c as CoordinatorReconnectCommand;
  if (!ctx.coordinator) return { ok: false, reason: "no_verified_coordinator" };
  if (command.coordinatorId !== ctx.coordinator.peerId) return { ok: false, reason: "wrong_coordinator" };
  if (!verifyPayload(signingPayload(command), f.signature, ctx.coordinator.publicKeyPem)) return { ok: false, reason: "invalid_signature" };
  if (command.agentId !== ctx.agentId) return { ok: false, reason: "wrong_agent" };
  const now = ctx.nowMs ?? Date.now();
  if (command.issuedAtMs > now + MAX_FUTURE_SKEW_MS) return { ok: false, reason: "from_future" };
  if (now > command.expiresAtMs || command.expiresAtMs - command.issuedAtMs > RECONNECT_FRAME_LIFETIME_MS) return { ok: false, reason: "expired" };
  return { ok: true, command };
}

/**
 * The agent's state for one reconnect: when it may register again, and whether the mesh
 * WebSocket should wait for that registration before opening (re-register first, then open).
 */
export class CoordinatorReconnectState {
  private registerAtMs = 0;
  private pendingSinceMs: number | null = null;
  private lastId: string | null = null;
  constructor(private readonly random: () => number = Math.random) {}

  /** A verified command: returns the wait before registering again (null for a repeat of the same frame). */
  accept(command: CoordinatorReconnectCommand, nowMs = Date.now()): number | null {
    if (command.id === this.lastId) return null;
    this.lastId = command.id;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, command.delayMs + Math.floor(this.random() * command.jitterMs));
    this.registerAtMs = nowMs + delay;
    this.pendingSinceMs = nowMs;
    return delay;
  }

  /** How long the agent still waits before registering again (0: go ahead). */
  holdMs(nowMs = Date.now()): number {
    return this.pending(nowMs) ? Math.max(0, this.registerAtMs - nowMs) : 0;
  }

  /** True from the frame until the agent has registered again (bounded): the WebSocket waits. */
  pending(nowMs = Date.now()): boolean {
    if (this.pendingSinceMs === null) return false;
    if (nowMs - this.pendingSinceMs > RECONNECT_PENDING_MAX_MS) this.pendingSinceMs = null;
    return this.pendingSinceMs !== null;
  }

  /**
   * The agent is serving through a peer coordinator for the drain (drain-failover.ts): the wait was
   * for registering with the restarted home, so it does not hold the registration with the peer.
   */
  clear(): void {
    this.pendingSinceMs = null;
    this.registerAtMs = 0;
  }

  /** The agent registered: the WebSocket may open now (a registration before the wait was up does not count). */
  registered(nowMs = Date.now()): void {
    if (nowMs >= this.registerAtMs) this.pendingSinceMs = null;
  }
}

/**
 * A coordinator restart in progress, from the agent's side: opened by a verified reconnect frame,
 * a mesh WebSocket closed with 1012 ("service restart"), or a /register refused with
 * `coordinator_draining`; closed once the agent has registered again.
 *
 * While it is open, a failed register or heartbeat is the restart, not the coordinator being
 * gone: the agent retries every RESTART_RETRY_MS (plus jitter) instead of the exponential backoff
 * (3, 6, 12 s, then offline mode with a 15 s probe), which kept agents away for 10-20 s after
 * the new instance was already up. The window is bounded: after RESTART_WINDOW_MS the usual
 * backoff and offline mode apply again, and after RESTART_FAILOVER_AFTER_MS the agent may move
 * to another coordinator (steering / registry) if its own is still not back.
 */
export const RESTART_WINDOW_MS = 90_000;
export const RESTART_RETRY_MS = 1_000;
export const RESTART_RETRY_JITTER_MS = 1_000;
export const RESTART_FAILOVER_AFTER_MS = 30_000;
/** A register or heartbeat during the restart answers fast or is retried (a held connection must not stall the agent). */
export const RESTART_REQUEST_TIMEOUT_MS = 5_000;
/** The mesh WebSocket's longest wait between attempts while a restart is in progress. */
export const RESTART_WS_MAX_DELAY_MS = 2_000;
/**
 * Network run 12: after the agent registered somewhere new (a drain failover's move to the peer,
 * the return home, a restarted coordinator) it reopens its mesh socket for a fresh bind. The old
 * socket's graceful close took ~5 s to complete, and only then did the new one open: agents were
 * registered with the peer ~2 s after the drain notice but had no socket there for another ~6 s
 * (no work_available nudges, shown as "polling"). The old socket is now dropped after
 * MESH_WS_REBIND_TERMINATE_MS if its close has not completed, and the new one opens after this.
 */
export const MESH_WS_REBIND_RECONNECT_MS = 100;
export const MESH_WS_REBIND_TERMINATE_MS = 250;

/** 1012 "service restart" (the coordinator's drain), or the agent's own close on a reconnect frame. */
export function isRestartClose(code: number, reason: string): boolean {
  return code === 1012 || reason === "coordinator_restart" || reason === "coordinator_reconnect";
}

/** A /register or new-work refusal from a draining coordinator. */
export function isDrainingError(error: unknown): boolean {
  const e = error as { statusCode?: number; message?: string } | null;
  return Boolean(e && e.statusCode === 503 && typeof e.message === "string" && e.message.includes("coordinator_draining"));
}

/**
 * A failure the restart explains: no answer at all (refused, reset, timed out) or a 5xx from the
 * proxy or the draining instance. A 4xx comes from a running coordinator and takes the usual path
 * (retrying it every second would only add to the registration-storm count).
 */
export function isRestartTransientError(error: unknown): boolean {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code !== "number" || code >= 500;
}

export class CoordinatorRestartWindow {
  private openedAtMs: number | null = null;
  private planned = false;
  constructor(private readonly random: () => number = Math.random) {}

  /**
   * Start (or keep) the window; a second signal during the same restart does not extend it.
   * `planned`: the coordinator said it is stopping (a drain notice, a reconnect frame, a 1012 close,
   * a `coordinator_draining` refusal), so the agent may serve through a peer at once (mayFailOver).
   * A planned signal upgrades an open window; nothing downgrades one.
   */
  open(nowMs = Date.now(), planned = false): void {
    if (!this.active(nowMs)) {
      this.openedAtMs = nowMs;
      this.planned = planned;
    } else if (planned) {
      this.planned = true;
    }
  }

  /** The agent registered with a coordinator again. */
  close(): void {
    this.openedAtMs = null;
    this.planned = false;
  }

  /** The window was opened (or upgraded) by a planned drain signal. */
  isPlanned(nowMs = Date.now()): boolean {
    return this.active(nowMs) && this.planned;
  }

  active(nowMs = Date.now()): boolean {
    if (this.openedAtMs === null) return false;
    if (nowMs - this.openedAtMs > RESTART_WINDOW_MS) this.openedAtMs = null;
    return this.openedAtMs !== null;
  }

  /** The wait before the next try while the window is open. */
  retryMs(): number {
    return RESTART_RETRY_MS + Math.floor(this.random() * RESTART_RETRY_JITTER_MS);
  }

  /**
   * True at once for a planned drain (the agent serves through a peer meanwhile and comes home
   * afterwards, drain-failover.ts); otherwise once the home coordinator has had
   * RESTART_FAILOVER_AFTER_MS to come back, so a blip does not bounce agents between coordinators.
   */
  mayFailOver(nowMs = Date.now()): boolean {
    if (this.openedAtMs === null) return true;
    if (this.isPlanned(nowMs)) return true;
    return nowMs - this.openedAtMs >= RESTART_FAILOVER_AFTER_MS;
  }
}

/**
 * The mesh WebSocket's next reconnect wait. Waiting for the agent's own registration is a local
 * check, so it polls quickly and does not grow; a socket the agent closed to bind again reopens at
 * once (MESH_WS_REBIND_RECONNECT_MS); during a restart failed opens are capped at
 * RESTART_WS_MAX_DELAY_MS; otherwise the wait doubles up to maxMs as before.
 */
export function nextMeshWsDelay(current: number, opts: { waitingForRegistration: boolean; restarting: boolean; maxMs: number; rebind?: boolean }): { waitMs: number; next: number } {
  if (opts.waitingForRegistration) return { waitMs: 500, next: current };
  // The agent closed it itself to bind again (already registered): open the new one now.
  if (opts.rebind) return { waitMs: MESH_WS_REBIND_RECONNECT_MS, next: current };
  if (opts.restarting) {
    const waitMs = Math.min(current, RESTART_WS_MAX_DELAY_MS);
    return { waitMs, next: Math.min(waitMs * 2, RESTART_WS_MAX_DELAY_MS) };
  }
  return { waitMs: current, next: Math.min(current * 2, opts.maxMs) };
}

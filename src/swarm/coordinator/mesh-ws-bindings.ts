// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { MESH_WS_BIND_MAX_SKEW_MS, decideMeshWsBind } from "../../mesh/ws-auth.js";

/*
 * Which /mesh/ws connection speaks for which peer (src/mesh/ws-auth.ts has the bind rules).
 *
 * A coordinator restart loses every agent registration while the agents still believe they are
 * registered: their WebSocket reconnects about a second after the old process goes away, before
 * the HTTP loop has noticed (401 agent_not_registered) and registered again. The signed bind of
 * that early connection cannot be checked yet (no key on file), so it used to be refused (4001)
 * or, for a mesh-token holder, admitted unauthenticated for good: either way the coordinator
 * reported the agent as not connected (model control, bots and code on the web, fast dispatch)
 * although the agent's socket looked open.
 *
 * Now such a connection is *held*: it keeps its bind signature and timestamp, receives nothing and
 * is listened to for nothing, and when the agent registers its key the signature is checked
 * against that key exactly as at connect time (same payload, same skew window measured at connect
 * time). A valid one promotes the connection to authenticated; anything else closes it. A held
 * connection that is not claimed by a registration within MESH_WS_HELD_BIND_TTL_MS is closed with
 * 4005 agent_not_registered so the agent reconnects after registering.
 */

/** A held connection waits this long for its agent to register before it is closed (4005). */
export const MESH_WS_HELD_BIND_TTL_MS = 3 * 60_000;
/** At most this many held connections at once; more are refused as before (4001). */
export const MESH_WS_MAX_HELD_BINDS = 2_000;
/** Close code for a held connection whose agent never registered (the agent re-registers, then reconnects). */
export const MESH_WS_CLOSE_NOT_REGISTERED = 4005;

export interface BindableSocket {
  readyState?: number;
  close(code: number, reason: string): void;
}

export interface PendingBind {
  signature: string;
  issuedAtMs: number;
  /** When the connection arrived: the skew window is checked against this, as it was at connect. */
  connectedAtMs: number;
}

export interface MeshWsBinding<S extends BindableSocket = BindableSocket> {
  socket: S;
  authenticated: boolean;
  /** A signed bind whose key was not on file yet; checked when the agent registers. */
  pending?: PendingBind;
  /** Admitted only by that pending bind (no mesh token): no gossip in or out until promoted. */
  held?: boolean;
}

export type PromoteOutcome = "promoted" | "none" | "rejected";

export class MeshWsBindingTable<S extends BindableSocket = BindableSocket> {
  private readonly bindings = new Map<string, MeshWsBinding<S>>();

  get(peerId: string): MeshWsBinding<S> | undefined {
    return this.bindings.get(peerId);
  }

  /** Bind `peerId` to a connection; an earlier, different connection for it is closed (4004). */
  bind(peerId: string, binding: MeshWsBinding<S>): void {
    const previous = this.bindings.get(peerId);
    this.bindings.set(peerId, binding);
    if (previous && previous.socket !== binding.socket) {
      try {
        previous.socket.close(4004, "replaced_by_new_connection");
      } catch {
        /* already closed */
      }
    }
  }

  /** Only the connection that currently holds the binding may release it. */
  release(peerId: string, socket: S): boolean {
    if (this.bindings.get(peerId)?.socket !== socket) return false;
    this.bindings.delete(peerId);
    return true;
  }

  /** An open connection whose bind proved the peer's key. */
  authenticatedOpen(peerId: string): S | null {
    const b = this.bindings.get(peerId);
    return b && b.authenticated && b.socket.readyState === 1 ? b.socket : null;
  }

  /** Every binding (the graceful stop tells each agent to reconnect, then closes each connection). */
  entries(): IterableIterator<[string, MeshWsBinding<S>]> {
    return this.bindings.entries();
  }

  heldCount(): number {
    let n = 0;
    for (const b of this.bindings.values()) if (b.held) n++;
    return n;
  }

  /**
   * The agent just registered `publicKeyPem`: a connection that arrived before, with a bind signed
   * for this peerId, is checked against that key now. "promoted": it is authenticated from here
   * on. "rejected": the signature does not match (a held connection is closed and released).
   * "none": nothing was waiting.
   */
  promote(peerId: string, publicKeyPem: string | undefined): PromoteOutcome {
    const b = this.bindings.get(peerId);
    if (!b || b.authenticated || !b.pending || !publicKeyPem) return "none";
    if (b.socket.readyState !== undefined && b.socket.readyState !== 1) return "none";
    const decision = decideMeshWsBind({
      peerId,
      signature: b.pending.signature,
      issuedAtMs: String(b.pending.issuedAtMs),
      knownPublicKeyPem: publicKeyPem,
      existingAuthenticated: false,
      requireSigned: true,
      nowMs: b.pending.connectedAtMs
    });
    if (!decision.ok || !decision.authenticated) {
      if (b.held) {
        this.bindings.delete(peerId);
        try {
          b.socket.close(4003, decision.ok ? "signature_required" : decision.reason);
        } catch {
          /* already closed */
        }
      } else {
        // A mesh-token connection stays as it was (unauthenticated); it just cannot be promoted.
        b.pending = undefined;
      }
      return "rejected";
    }
    b.authenticated = true;
    b.held = false;
    b.pending = undefined;
    return "promoted";
  }
}

/** A pending bind is worth keeping only when it carries a usable signature and timestamp. */
export function pendingBindFrom(signature: string | null, issuedAtMs: string | null, nowMs = Date.now()): PendingBind | null {
  if (!signature || !issuedAtMs) return null;
  const ts = Number(issuedAtMs);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > MESH_WS_BIND_MAX_SKEW_MS) return null;
  return { signature, issuedAtMs: ts, connectedAtMs: nowMs };
}

// The /mesh/ws route (routes/mesh.ts) owns the table; /register (routes/agents.ts) tells it an agent
// registered a key, without either importing the other.
let agentRegisteredHook: ((agentId: string, publicKeyPem: string | undefined) => void) | null = null;

export function setMeshWsAgentRegisteredHook(hook: ((agentId: string, publicKeyPem: string | undefined) => void) | null): void {
  agentRegisteredHook = hook;
}

/** Called after a successful /register: a connection that arrived first is checked and promoted. */
export function meshWsAgentRegistered(agentId: string, publicKeyPem: string | undefined): void {
  try {
    agentRegisteredHook?.(agentId, publicKeyPem);
  } catch {
    /* never fails a registration */
  }
}

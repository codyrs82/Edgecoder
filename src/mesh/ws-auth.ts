// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { signPayload, verifyPayload } from "./peer.js";

/*
 * /mesh/ws connection binding (pentest LOW). The mesh token only says "member of the mesh"; it
 * does not say which peer. A connection binds a peerId, and:
 *
 *   - a signed bind (x-mesh-ws-ts + x-mesh-ws-signature over meshWsBindPayload, made with the key
 *     the coordinator holds for that peerId: the agent's registered key or the mesh peer key)
 *     is "authenticated" and replaces any earlier connection for the peerId;
 *   - an unsigned bind (agents built before this change) is accepted only while
 *     MESH_WS_REQUIRE_SIGNED is off, and can never displace an authenticated connection;
 *   - every message on the connection must carry fromPeerId === the bound peerId, so a peer
 *     cannot speak as another over its socket.
 *
 * The token itself moves to the x-mesh-token header (query `token` is still read for old agents).
 */

export const MESH_WS_BIND_MAX_SKEW_MS = 5 * 60_000;

export function meshWsBindPayload(peerId: string, issuedAtMs: number): string {
  return ["edgecoder-mesh-ws-bind-v1", peerId, issuedAtMs].join("\n");
}

/** Headers a peer sends when it opens /mesh/ws. */
export function signMeshWsBind(peerId: string, privateKeyPem: string, nowMs = Date.now()): Record<string, string> {
  return {
    "x-mesh-ws-ts": String(nowMs),
    "x-mesh-ws-signature": signPayload(meshWsBindPayload(peerId, nowMs), privateKeyPem)
  };
}

export type MeshWsBindDecision =
  | { ok: true; authenticated: boolean }
  | { ok: false; reason: "missing_peer_id" | "signature_required" | "unknown_peer_key" | "stale_signature" | "invalid_signature" | "peer_bound_by_authenticated_connection" };

export function decideMeshWsBind(input: {
  peerId: string | null | undefined;
  issuedAtMs?: string | null;
  signature?: string | null;
  /** Key the coordinator holds for this peerId (registered agent key or mesh peer key). */
  knownPublicKeyPem?: string;
  /** An authenticated connection for this peerId is already open. */
  existingAuthenticated: boolean;
  requireSigned: boolean;
  nowMs?: number;
}): MeshWsBindDecision {
  const peerId = input.peerId?.trim();
  if (!peerId) return { ok: false, reason: "missing_peer_id" };
  // A signature we cannot check yet (the agent reconnects before it re-registers after a
  // coordinator restart) counts as an unsigned bind; strict mode refuses it.
  if (!input.signature || !input.knownPublicKeyPem) {
    if (input.requireSigned) return { ok: false, reason: input.signature ? "unknown_peer_key" : "signature_required" };
    if (input.existingAuthenticated) return { ok: false, reason: "peer_bound_by_authenticated_connection" };
    return { ok: true, authenticated: false };
  }
  const ts = Number(input.issuedAtMs);
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MESH_WS_BIND_MAX_SKEW_MS) return { ok: false, reason: "stale_signature" };
  if (!verifyPayload(meshWsBindPayload(peerId, ts), input.signature, input.knownPublicKeyPem)) return { ok: false, reason: "invalid_signature" };
  return { ok: true, authenticated: true };
}

/** A message received on a bound connection must come from the bound peer. */
export function meshWsSenderMatches(boundPeerId: string, message: { fromPeerId?: unknown }): boolean {
  return typeof message.fromPeerId === "string" && message.fromPeerId === boundPeerId;
}

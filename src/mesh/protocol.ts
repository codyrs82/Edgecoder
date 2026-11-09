// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { MeshMessage, MeshMessageType } from "../common/types.js";
import { canonicalizeMessage, signPayload, verifyPayload } from "./peer.js";

/** A message is never valid for longer than this, whatever ttlMs the sender chose. */
export const MAX_MESSAGE_TTL_MS = 5 * 60_000;
/** How far in the future issuedAtMs may be (clock skew). */
export const MAX_MESSAGE_FUTURE_SKEW_MS = 60_000;
/**
 * Hard cap on remembered message ids. Ids are kept until their message expires (at most
 * MAX_MESSAGE_TTL_MS + skew), never evicted early, so a replay inside the validity window is always
 * caught; when the cache is full of unexpired ids, new messages are refused instead.
 */
export const SEEN_CACHE_LIMIT = 50_000;

export class MeshProtocol {
  /** message id -> time after which the message is expired anyway. */
  private readonly seenIds = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly seenLimit = SEEN_CACHE_LIMIT
  ) {}

  private pruneSeen(nowMs: number): void {
    for (const [id, until] of this.seenIds) if (until < nowMs) this.seenIds.delete(id);
  }

  createMessage(
    type: MeshMessageType,
    fromPeerId: string,
    payload: Record<string, unknown>,
    privateKeyPem: string,
    ttlMs = 30_000
  ): MeshMessage {
    const unsigned = {
      id: randomUUID(),
      type,
      fromPeerId,
      issuedAtMs: this.now(),
      ttlMs,
      payload
    };
    const signature = signPayload(canonicalizeMessage(unsigned), privateKeyPem);
    return { ...unsigned, signature };
  }

  validateMessage(message: MeshMessage, publicKeyPem: string): { ok: boolean; reason?: string } {
    if (this.seenIds.has(message.id)) {
      return { ok: false, reason: "duplicate_message" };
    }
    const nowMs = this.now();
    if (!Number.isFinite(message.issuedAtMs) || !Number.isFinite(message.ttlMs) || message.ttlMs < 0) {
      return { ok: false, reason: "message_expired" };
    }
    if (message.issuedAtMs > nowMs + MAX_MESSAGE_FUTURE_SKEW_MS) return { ok: false, reason: "message_from_future" };
    // The sender's ttlMs is honoured only up to MAX_MESSAGE_TTL_MS.
    const expiresAtMs = message.issuedAtMs + Math.min(message.ttlMs, MAX_MESSAGE_TTL_MS);
    if (nowMs > expiresAtMs) return { ok: false, reason: "message_expired" };
    const valid = verifyPayload(
      canonicalizeMessage({
        id: message.id,
        type: message.type,
        fromPeerId: message.fromPeerId,
        issuedAtMs: message.issuedAtMs,
        ttlMs: message.ttlMs,
        payload: message.payload
      }),
      message.signature,
      publicKeyPem
    );
    if (!valid) return { ok: false, reason: "invalid_signature" };

    if (this.seenIds.size >= this.seenLimit) {
      this.pruneSeen(nowMs);
      if (this.seenIds.size >= this.seenLimit) return { ok: false, reason: "replay_cache_full" };
    }
    this.seenIds.set(message.id, expiresAtMs);
    return { ok: true };
  }
}

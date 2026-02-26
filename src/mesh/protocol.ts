// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { MeshMessage, MeshMessageType } from "../common/types.js";
import { canonicalizeMessage, signPayload, verifyPayload } from "./peer.js";

const SEEN_CACHE_LIMIT = 5_000;

export class MeshProtocol {
  private readonly seenIds = new Set<string>();

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
      issuedAtMs: Date.now(),
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
    const expired = Date.now() > message.issuedAtMs + message.ttlMs;
    if (expired) return { ok: false, reason: "message_expired" };
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

    this.seenIds.add(message.id);
    if (this.seenIds.size > SEEN_CACHE_LIMIT) {
      const [first] = this.seenIds;
      if (first) this.seenIds.delete(first);
    }
    return { ok: true };
  }
}

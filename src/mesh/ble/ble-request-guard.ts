// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Admission for incoming BLE inference requests. A provider serves nearby peers only once it holds a
 * mesh token, only for requests carrying a proof made with that token, within size and rate limits.
 *
 * The advertised meshTokenHash is public (anyone in radio range can read it), so it only says which
 * mesh a peer belongs to; it is not a credential. The credential is `requesterProof`: an HMAC keyed
 * with the mesh token itself over the request id, requester id, task hash and issue time. Each
 * proof is accepted once while it is fresh (a retry of the same request id carries a new proof).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface BleRequestGuardOptions {
  /** Max prompt size in bytes (default 64 KiB). */
  maxTaskBytes?: number;
  /** Requests per requester per window (default 6). */
  perRequester?: number;
  /** Requests from all requesters per window (default 30). */
  global?: number;
  windowMs?: number;
  /** How far requesterIssuedAtMs may be from our clock (default 2 minutes). */
  proofMaxSkewMs?: number;
  now?: () => number;
}

export type BleAdmission =
  | { ok: true }
  | {
      ok: false;
      reason: "mesh_token_required" | "mesh_token_mismatch" | "task_too_large" | "rate_limited" | "proof_expired" | "request_replayed";
    };

/** The proof fields a requester adds to its BLETaskRequest. */
export interface BleRequestProofFields {
  requesterIssuedAtMs: number;
  requesterProof: string;
}

const PROOF_DOMAIN = "edgecoder-ble-request-v1";

function proofMac(meshToken: string, f: { requestId: string; requesterId: string; task: string; issuedAtMs: number }): Buffer {
  const taskHash = createHash("sha256").update(f.task, "utf8").digest("hex");
  return createHmac("sha256", meshToken)
    .update([PROOF_DOMAIN, f.requestId, f.requesterId, taskHash, String(f.issuedAtMs)].join("\n"))
    .digest();
}

/** Requester side: the fields to add to a BLE task request. */
export function bleRequestProof(
  meshToken: string,
  req: { requestId: string; requesterId: string; task: string },
  issuedAtMs: number = Date.now()
): BleRequestProofFields {
  return { requesterIssuedAtMs: issuedAtMs, requesterProof: proofMac(meshToken, { ...req, issuedAtMs }).toString("hex") };
}

export class BleRequestGuard {
  private readonly maxTaskBytes: number;
  private readonly perRequester: number;
  private readonly global: number;
  private readonly windowMs: number;
  private readonly proofMaxSkewMs: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, number[]>();
  private globalHits: number[] = [];
  /** proof (hex) -> time after which it is stale anyway. */
  private readonly usedProofs = new Map<string, number>();

  constructor(opts: BleRequestGuardOptions = {}) {
    this.maxTaskBytes = opts.maxTaskBytes ?? 64 * 1024;
    this.perRequester = opts.perRequester ?? 6;
    this.global = opts.global ?? 30;
    this.windowMs = opts.windowMs ?? 60_000;
    this.proofMaxSkewMs = opts.proofMaxSkewMs ?? 2 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  admit(input: {
    /** Our mesh token (not its hash); empty until the coordinator provisions one. */
    ownMeshToken: string;
    requestId: string;
    requesterId: string;
    task: string;
    requesterProof?: unknown;
    requesterIssuedAtMs?: unknown;
  }): BleAdmission {
    if (!input.ownMeshToken) return { ok: false, reason: "mesh_token_required" };
    if (typeof input.task !== "string" || Buffer.byteLength(input.task, "utf8") > this.maxTaskBytes) return { ok: false, reason: "task_too_large" };
    const issuedAtMs = input.requesterIssuedAtMs;
    const proofHex = input.requesterProof;
    if (typeof proofHex !== "string" || typeof issuedAtMs !== "number" || !Number.isFinite(issuedAtMs) || typeof input.requestId !== "string") {
      return { ok: false, reason: "mesh_token_mismatch" };
    }
    const expected = proofMac(input.ownMeshToken, { requestId: input.requestId, requesterId: input.requesterId, task: input.task, issuedAtMs });
    const given = /^[0-9a-f]{64}$/i.test(proofHex) ? Buffer.from(proofHex, "hex") : Buffer.alloc(0);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "mesh_token_mismatch" };
    const expectedHex = expected.toString("hex");

    const now = this.now();
    if (Math.abs(now - issuedAtMs) > this.proofMaxSkewMs) return { ok: false, reason: "proof_expired" };
    for (const [id, until] of this.usedProofs) if (until < now) this.usedProofs.delete(id);
    if (this.usedProofs.has(expectedHex)) return { ok: false, reason: "request_replayed" };

    const since = now - this.windowMs;
    this.globalHits = this.globalHits.filter((t) => t > since);
    const mine = (this.hits.get(input.requesterId) ?? []).filter((t) => t > since);
    if (mine.length >= this.perRequester || this.globalHits.length >= this.global) {
      this.hits.set(input.requesterId, mine);
      return { ok: false, reason: "rate_limited" };
    }
    mine.push(now);
    this.hits.set(input.requesterId, mine);
    this.globalHits.push(now);
    // Bounded by the global rate limit: at most `global` ids per window survive the prune above.
    this.usedProofs.set(expectedHex, issuedAtMs + this.proofMaxSkewMs);
    if (this.hits.size > 1000) {
      for (const [id, ts] of this.hits) if (!ts.some((t) => t > since)) this.hits.delete(id);
    }
    return { ok: true };
  }
}

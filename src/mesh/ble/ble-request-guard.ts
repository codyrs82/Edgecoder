// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Admission for incoming BLE inference requests. A provider serves nearby peers only once it holds a
 * mesh token, only for peers advertising the same token hash, within size and rate limits.
 * BLE advertisements carry no public key, so the requester signature cannot be verified here; the
 * shared token hash is the only credential.
 */

export interface BleRequestGuardOptions {
  /** Max prompt size in bytes (default 64 KiB). */
  maxTaskBytes?: number;
  /** Requests per requester per window (default 6). */
  perRequester?: number;
  /** Requests from all requesters per window (default 30). */
  global?: number;
  windowMs?: number;
  now?: () => number;
}

export type BleAdmission =
  | { ok: true }
  | { ok: false; reason: "mesh_token_required" | "mesh_token_mismatch" | "task_too_large" | "rate_limited" };

export class BleRequestGuard {
  private readonly maxTaskBytes: number;
  private readonly perRequester: number;
  private readonly global: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, number[]>();
  private globalHits: number[] = [];

  constructor(opts: BleRequestGuardOptions = {}) {
    this.maxTaskBytes = opts.maxTaskBytes ?? 64 * 1024;
    this.perRequester = opts.perRequester ?? 6;
    this.global = opts.global ?? 30;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  admit(input: { ownTokenHash: string; requesterTokenHash: string | undefined; requesterId: string; task: string }): BleAdmission {
    if (!input.ownTokenHash) return { ok: false, reason: "mesh_token_required" };
    if (!input.requesterTokenHash || input.requesterTokenHash !== input.ownTokenHash) return { ok: false, reason: "mesh_token_mismatch" };
    if (typeof input.task !== "string" || Buffer.byteLength(input.task, "utf8") > this.maxTaskBytes) return { ok: false, reason: "task_too_large" };
    const now = this.now();
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
    if (this.hits.size > 1000) {
      for (const [id, ts] of this.hits) if (!ts.some((t) => t > since)) this.hits.delete(id);
    }
    return { ok: true };
  }
}

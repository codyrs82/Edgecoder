// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHmac } from "node:crypto";

/*
 * #147: the desktop app finds something already listening on 127.0.0.1:4301 at launch. Before it
 * reuses that listener (and hands it the inference token) it sends a fresh random nonce here; the
 * agent answers with HMAC-SHA256(ADMIN_API_TOKEN, "edgecoder-local-attest.v1." + nonce). Only the
 * agent the app started with that admin token can answer. The shell (desktop/src-tauri/src/
 * agent_attest.rs) computes the same MAC and compares in constant time.
 *
 * Loopback only, and each nonce is answered once, so the route can't be used as a MAC oracle for
 * a nonce someone else picked earlier.
 */

export const LOCAL_ATTEST_PATH = "/local/attest";
export const LOCAL_ATTEST_DOMAIN = "edgecoder-local-attest.v1.";
/** 32 random bytes, hex-encoded (what the desktop shell sends). */
const NONCE_RE = /^[0-9a-f]{64}$/;

export function localAttestMac(adminToken: string, nonce: string): string {
  return createHmac("sha256", adminToken).update(LOCAL_ATTEST_DOMAIN + nonce).digest("hex");
}

/** Remembers answered nonces (bounded, oldest dropped first). */
export class NonceLog {
  private readonly seen = new Set<string>();
  constructor(private readonly max = 1024) {}
  /** True the first time a nonce is offered, false for a replay. */
  claim(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    if (this.seen.size > this.max) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}

export type LocalAttestResult =
  | { status: 200; body: { nonce: string; mac: string } }
  | { status: 400 | 403 | 409 | 503; body: { error: string } };

/** Route logic, framework-free so it is unit-tested. */
export function answerLocalAttest(
  body: unknown,
  ctx: { adminToken: string; loopback: boolean; nonces: NonceLog }
): LocalAttestResult {
  if (!ctx.loopback) return { status: 403, body: { error: "local_only" } };
  if (!ctx.adminToken) return { status: 503, body: { error: "attest_not_configured" } };
  const nonce = (body as { nonce?: unknown } | null)?.nonce;
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return { status: 400, body: { error: "invalid_nonce" } };
  if (!ctx.nonces.claim(nonce)) return { status: 409, body: { error: "nonce_replayed" } };
  return { status: 200, body: { nonce, mac: localAttestMac(ctx.adminToken, nonce) } };
}

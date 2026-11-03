// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { CoordinatorTrustCheck } from "../trust/pinned-keys.js";
import type { VerifiedCoordinator } from "../trust/response-signing.js";

/*
 * The one place the worker's coordinator URL changes. A new URL starts unverified, and nothing that
 * talks to the coordinator (register, heartbeat, pull, results, mesh routes) may use it until
 * verify() has proven the coordinator's key (src/trust/identity-challenge.ts).
 */

export interface TrustChecker {
  check(url: string): Promise<CoordinatorTrustCheck>;
  forget(url?: string): void;
}

export class CoordinatorNotVerifiedError extends Error {
  constructor(url: string) {
    super(`coordinator_not_verified: ${url}`);
  }
}

const normalize = (url: string) => url.trim().replace(/\/+$/, "");

export class ActiveCoordinator {
  private current: string;
  private verifiedUrl: string | null = null;
  private verifiedIdentity: VerifiedCoordinator | null = null;

  constructor(initialUrl: string, private readonly trust: TrustChecker, private readonly onChange?: (from: string, to: string, reason: string) => void) {
    this.current = normalize(initialUrl);
  }

  get url(): string {
    return this.current;
  }

  /** Switch coordinator. A different URL is unverified until the next verify(). */
  set(url: string, reason: string): boolean {
    const next = normalize(url);
    if (next === this.current) return false;
    const prev = this.current;
    this.current = next;
    this.verifiedUrl = null;
    this.verifiedIdentity = null;
    this.trust.forget(next);
    this.onChange?.(prev, next, reason);
    return true;
  }

  /** Drop the verification (reconnect, failure): the next verify() challenges again. */
  invalidate(): void {
    this.verifiedUrl = null;
    this.verifiedIdentity = null;
    this.trust.forget(this.current);
  }

  /**
   * Verify the current URL (cached by the trust gate for a bounded time). `force` re-challenges.
   * Marks the URL verified only if it is still the current one when the check completes.
   */
  async verify(opts: { force?: boolean } = {}): Promise<CoordinatorTrustCheck> {
    const url = this.current;
    if (opts.force) this.trust.forget(url);
    const result = await this.trust.check(url);
    if (url !== this.current) return { trusted: false, coordinatorUrl: url, error: "coordinator_changed_during_verification" };
    this.verifiedUrl = result.trusted ? url : null;
    this.verifiedIdentity =
      result.trusted && result.peerId && result.publicKeyPem
        ? { peerId: result.peerId, publicKeyPem: result.publicKeyPem, responseSigning: result.responseSigning === true }
        : result.trusted
          ? this.verifiedIdentity
          : null;
    return result;
  }

  isVerified(): boolean {
    return this.verifiedUrl !== null && this.verifiedUrl === this.current;
  }

  /**
   * The URL plus the identity proven for it (peerId, pinned key, whether it signs responses):
   * responses from that URL are verified against this key. Throws when not verified.
   */
  requireVerifiedIdentity(): { url: string; identity: VerifiedCoordinator } {
    const url = this.requireVerified();
    if (!this.verifiedIdentity) throw new CoordinatorNotVerifiedError(url);
    return { url, identity: this.verifiedIdentity };
  }

  /** The URL to send requests to; throws when it has not been verified. */
  requireVerified(): string {
    if (!this.isVerified()) throw new CoordinatorNotVerifiedError(this.current);
    return this.current;
  }
}

/** The mesh WebSocket URL: the token travels in the x-mesh-token header, never the query string. */
export function meshWsUrl(coordinatorUrl: string, peerId: string): string {
  const ws = normalize(coordinatorUrl).replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${ws}/mesh/ws?peerId=${encodeURIComponent(peerId)}`;
}

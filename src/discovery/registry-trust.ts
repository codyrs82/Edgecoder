// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// A coordinator's view of the signed coordinator registry, for peer trust: which coordinator keys
// the registry vouches for. Trust = MESH_PEER_ALLOWLIST ∪ registry members on probation or active
// (context.ts trustedPeerKey). The document is verified against the pinned registry keys
// (DEFAULT_REGISTRY_PUBLIC_KEYS plus EDGECODER_REGISTRY_PUBLIC_KEYS) and refreshed on its signed
// TTL: halfway through its lifetime, and never used past it. A suspended member stops being
// trusted at the next refresh; `onRevoked` names the peers that lost trust so the caller can
// drop them from its peer table. With no pinned key the registry adds nothing.

import { canonicalPeerUrl } from "../mesh/peer-trust.js";
import { fingerprintMatches } from "../security/key-fingerprint.js";
import { memberStatus, memberTrusted, verifySignedRegistry, type RegistryEntry, type RegistryMemberStatus, type RegistryPayload } from "./registry.js";

/** How a coordinator is listed: "platform" for EdgeCoder's own, else the member's status. */
export type RegistryListing = "platform" | RegistryMemberStatus;

export interface RegistryTrustOptions {
  /** Fetches the signed document (the coordinator's registry mirror). */
  load: () => Promise<unknown | null>;
  /** Pinned registry public keys (PEM). Empty: the registry is never used. */
  publicKeys: readonly string[];
  now?: () => number;
  /** Earliest next refresh after a good one (default 30 s). */
  minRefreshMs?: number;
  /** Retry after a failed refresh (default 60 s). */
  retryMs?: number;
  /** Peers that were trusted through the registry and no longer are (suspended, removed, expired). */
  onRevoked?: (peerIds: string[]) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class RegistryTrust {
  private readonly opts: RegistryTrustOptions;
  private readonly now: () => number;
  private registry: RegistryPayload | null = null;
  /** Who was trusted after the last refresh (to report who lost it). */
  private lastTrusted = new Set<string>();
  private nextRefreshAtMs = 0;
  private inFlight: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: RegistryTrustOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Whether any registry key is pinned (otherwise this source trusts nobody). */
  get enabled(): boolean {
    return this.opts.publicKeys.length > 0;
  }

  /** The verified registry while it is unexpired, else null. */
  current(): RegistryPayload | null {
    if (!this.registry) return null;
    if (this.registry.expiresAtMs <= this.now()) return null;
    return this.registry;
  }

  private trustedIds(reg: RegistryPayload | null): Set<string> {
    return new Set((reg?.coordinators ?? []).filter((c) => memberTrusted(c)).map((c) => c.peerId));
  }

  /** Fetch and verify now. A document older than the one held (a replay) is ignored. */
  refresh(): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    this.inFlight ??= (async () => {
      let ok = false;
      try {
        const doc = await this.opts.load();
        const v = doc ? verifySignedRegistry(doc, { publicKeys: this.opts.publicKeys, now: this.now }) : null;
        if (v?.ok && (!this.registry || v.registry.issuedAtMs >= this.registry.issuedAtMs)) {
          this.registry = v.registry;
          ok = true;
          const life = Math.max(0, v.registry.expiresAtMs - v.registry.issuedAtMs);
          this.nextRefreshAtMs = Math.max(this.now() + (this.opts.minRefreshMs ?? 30_000), v.registry.issuedAtMs + Math.floor(life / 2));
        } else {
          if (v && !v.ok) this.opts.log?.("registry_trust_rejected", { reason: v.reason });
          this.nextRefreshAtMs = this.now() + (this.opts.retryMs ?? 60_000);
        }
      } catch (err) {
        this.opts.log?.("registry_trust_refresh_failed", { error: String(err) });
        this.nextRefreshAtMs = this.now() + (this.opts.retryMs ?? 60_000);
      }
      const after = this.trustedIds(this.current());
      const revoked = [...this.lastTrusted].filter((id) => !after.has(id));
      this.lastTrusted = after;
      if (revoked.length > 0) this.opts.onRevoked?.(revoked);
      return ok;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Refresh in the background when the TTL schedule says so (or the document expired). */
  maybeRefresh(): void {
    if (!this.enabled || this.inFlight) return;
    if (this.now() >= this.nextRefreshAtMs || (this.registry && this.registry.expiresAtMs <= this.now())) void this.refresh();
  }

  /** Check the schedule every `tickMs` (default 15 s). */
  start(tickMs = 15_000): void {
    if (!this.enabled || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => this.maybeRefresh(), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private entry(peerId: string): RegistryEntry | undefined {
    return this.current()?.coordinators.find((c) => c.peerId === peerId);
  }

  /**
   * The portal's action-signing public keys the verified, unexpired registry publishes (raw base64).
   * Read-only: the refresh schedule (start()) keeps the registry current, so a portal check never
   * makes a fetch of its own.
   */
  portalActionKeys(): string[] {
    return this.current()?.portalActionKeys ?? [];
  }

  /** PeerKeyTrust: the registry lists this peer, on probation or active, with this key. */
  readonly trusts = (peerId: string, publicKeyPem: string): boolean => {
    this.maybeRefresh();
    const e = this.entry(peerId);
    return Boolean(e && memberTrusted(e) && fingerprintMatches(e.publicKeyFingerprint, publicKeyPem));
  };

  /** The verified, unexpired registry's entry for a coordinator (null when none is held or it is not listed). */
  member(peerId: string): RegistryEntry | null {
    this.maybeRefresh();
    return this.entry(peerId) ?? null;
  }

  /** How the registry lists a coordinator (null when it does not, or no registry is held). */
  listing(peerId: string): RegistryListing | null {
    const e = this.entry(peerId);
    if (!e) return null;
    return e.operator.kind === "edgecoder" ? "platform" : memberStatus(e);
  }

  /** Trusted members' URLs (the portal verified each with a key challenge): the endpoint pin for each. */
  urlPins(): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of this.current()?.coordinators ?? []) {
      if (!memberTrusted(c)) continue;
      const url = canonicalPeerUrl(c.urls[0]);
      if (url) out.set(c.peerId, url);
    }
    return out;
  }
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Lightning callback pinning (trust on first use).
 *
 * Paying a Lightning address (name@domain) first fetches https://domain/.well-known/lnurlp/name,
 * whose `callback` URL hands out the invoice, possibly on another host (Wallet of Satoshi does
 * this). The first time a destination resolves, its callback origin (scheme, host, port) is
 * pinned. Each later payout compares the resolved origin with the pin; a different origin means
 * the wallet's payment server changed, or someone took over the domain's /.well-known path. The
 * payout is not made, the destination is marked `callback_changed` (old and new origin), the
 * earnings stay payable, and the owner is told once. Confirming the change with the emailed code
 * (portal) re-pins to the new origin. Changing the destination drops its pin.
 *
 * Pins are keyed by (account, destination), so a new destination starts unpinned.
 */

export interface CallbackPin {
  accountId: string;
  destination: string;
  /** Pinned callback origin, e.g. https://livingroomofsatoshi.com */
  origin: string;
  pinnedAtMs: number;
  /** Set while the destination is `callback_changed`: the origin seen instead of the pin. */
  changedOrigin?: string;
  changedAtMs?: number;
  /** When the owner was told about changedOrigin (once per change). */
  notifiedAtMs?: number;
}

export interface CallbackPinStore {
  getCallbackPin(accountId: string, destination: string): Promise<CallbackPin | null>;
  listCallbackPins(accountId: string): Promise<CallbackPin[]>;
  /** Insert a pin if none exists for (account, destination); returns the stored row either way. */
  pinCallbackOrigin(accountId: string, destination: string, origin: string, nowMs: number): Promise<CallbackPin>;
  /** Record the changed origin. A different changed origin than the one recorded clears notifiedAtMs. */
  markCallbackChanged(accountId: string, destination: string, changedOrigin: string, nowMs: number): Promise<void>;
  /** Atomically take the right to notify: sets notifiedAtMs when a change is recorded and not yet notified. */
  claimCallbackNotification(accountId: string, destination: string, nowMs: number): Promise<CallbackPin | null>;
  /** Undo a claim whose delivery failed, so the next cycle tries again. */
  releaseCallbackNotification(accountId: string, destination: string): Promise<void>;
  /** Re-pin to `changedOrigin` if it is still the recorded change. Returns false when it is not. */
  confirmCallbackChange(accountId: string, destination: string, changedOrigin: string, nowMs: number): Promise<boolean>;
  /** Drop pins for the account's destinations other than `keepDestination` (destination changed). */
  resetCallbackPins(accountId: string, keepDestination: string | null): Promise<void>;
}

/** scheme://host[:port] of a callback URL, lower-cased, default port omitted. */
export function callbackOrigin(callbackUrl: string): string {
  return new URL(callbackUrl).origin.toLowerCase();
}

export type PinCheck =
  | { ok: true; pinned: "new" | "match"; pin: CallbackPin }
  | { ok: false; code: "callback_changed"; previousOrigin: string; newOrigin: string; pin: CallbackPin };

/**
 * Pin on first use, otherwise compare. A mismatch is recorded on the pin (it does not move the pin).
 * `callback_changed` is sticky: once recorded, payouts stay held until the owner confirms, even if
 * the callback later goes back to the pinned origin (a server flipping between hosts is not trusted).
 */
export async function checkCallbackPin(store: CallbackPinStore, accountId: string, destination: string, origin: string, nowMs: number): Promise<PinCheck> {
  const existing = await store.getCallbackPin(accountId, destination);
  if (!existing) {
    const pin = await store.pinCallbackOrigin(accountId, destination, origin, nowMs);
    // Lost a race with another seed pinning a different origin: fall through to the compare.
    if (pin.origin === origin) return { ok: true, pinned: "new", pin };
    return mismatch(store, pin, origin, nowMs);
  }
  if (existing.changedOrigin) return mismatch(store, existing, origin === existing.origin ? existing.changedOrigin : origin, nowMs);
  if (existing.origin === origin) return { ok: true, pinned: "match", pin: existing };
  return mismatch(store, existing, origin, nowMs);
}

async function mismatch(store: CallbackPinStore, pin: CallbackPin, origin: string, nowMs: number): Promise<PinCheck> {
  if (pin.changedOrigin !== origin) await store.markCallbackChanged(pin.accountId, pin.destination, origin, nowMs);
  const updated = (await store.getCallbackPin(pin.accountId, pin.destination)) ?? pin;
  return { ok: false, code: "callback_changed", previousOrigin: pin.origin, newOrigin: origin, pin: updated };
}

/** The account-facing state: `callback_changed` while a change waits for the owner's confirmation. */
export function callbackPinStatus(pins: CallbackPin[]): Array<{ destination: string; origin: string; pinnedAtMs: number; state: "pinned" | "callback_changed"; changedOrigin?: string; changedAtMs?: number }> {
  return pins.map((p) => ({
    destination: p.destination,
    origin: p.origin,
    pinnedAtMs: p.pinnedAtMs,
    state: p.changedOrigin ? "callback_changed" : "pinned",
    ...(p.changedOrigin ? { changedOrigin: p.changedOrigin, changedAtMs: p.changedAtMs } : {})
  }));
}

/** In-memory pins for dev and tests. */
export class MemoryCallbackPinStore implements CallbackPinStore {
  readonly pins = new Map<string, CallbackPin>();
  private key(a: string, d: string) {
    return `${a}\u0000${d}`;
  }
  async getCallbackPin(accountId: string, destination: string) {
    const p = this.pins.get(this.key(accountId, destination));
    return p ? { ...p } : null;
  }
  async listCallbackPins(accountId: string) {
    return [...this.pins.values()].filter((p) => p.accountId === accountId).map((p) => ({ ...p }));
  }
  async pinCallbackOrigin(accountId: string, destination: string, origin: string, nowMs: number) {
    const k = this.key(accountId, destination);
    if (!this.pins.has(k)) this.pins.set(k, { accountId, destination, origin, pinnedAtMs: nowMs });
    return { ...this.pins.get(k)! };
  }
  async markCallbackChanged(accountId: string, destination: string, changedOrigin: string, nowMs: number) {
    const p = this.pins.get(this.key(accountId, destination));
    if (!p || p.changedOrigin === changedOrigin) return;
    Object.assign(p, { changedOrigin, changedAtMs: nowMs, notifiedAtMs: undefined });
  }
  async claimCallbackNotification(accountId: string, destination: string, nowMs: number) {
    const p = this.pins.get(this.key(accountId, destination));
    if (!p || !p.changedOrigin || p.notifiedAtMs !== undefined) return null;
    p.notifiedAtMs = nowMs;
    return { ...p };
  }
  async releaseCallbackNotification(accountId: string, destination: string) {
    const p = this.pins.get(this.key(accountId, destination));
    if (p) p.notifiedAtMs = undefined;
  }
  async confirmCallbackChange(accountId: string, destination: string, changedOrigin: string, nowMs: number) {
    const p = this.pins.get(this.key(accountId, destination));
    if (!p || p.changedOrigin !== changedOrigin) return false;
    this.pins.set(this.key(accountId, destination), { accountId, destination, origin: changedOrigin, pinnedAtMs: nowMs });
    return true;
  }
  async resetCallbackPins(accountId: string, keepDestination: string | null) {
    for (const [k, p] of this.pins) if (p.accountId === accountId && p.destination !== keepDestination) this.pins.delete(k);
  }
}

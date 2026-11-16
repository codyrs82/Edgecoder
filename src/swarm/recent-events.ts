// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Events per key over a sliding window (the Network page's activity: calls a machine took in the
 * last minute, work and gossip a peer coordinator sent). Bounded: at most `maxKeys` keys (the
 * least recently touched go first) and `maxPerKey` timestamps per key, so a burst cannot grow it.
 * A count read past `maxPerKey` is a floor ("at least"), which is all a pulse rate needs.
 */
export class RecentEvents {
  private readonly byKey = new Map<string, number[]>();
  constructor(
    readonly windowMs = 60_000,
    private readonly maxKeys = 5_000,
    private readonly maxPerKey = 1_000
  ) {}

  record(key: string, nowMs = Date.now()): void {
    if (!key) return;
    let list = this.byKey.get(key);
    if (list) this.byKey.delete(key);
    else list = [];
    list.push(nowMs);
    this.trim(list, nowMs);
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    this.byKey.set(key, list);
    while (this.byKey.size > this.maxKeys) this.byKey.delete(this.byKey.keys().next().value as string);
  }

  /** Events for `key` in the window ending now. */
  count(key: string, nowMs = Date.now()): number {
    const list = this.byKey.get(key);
    if (!list) return 0;
    this.trim(list, nowMs);
    if (!list.length) this.byKey.delete(key);
    return list.length;
  }

  /** Drop keys with nothing in the window. */
  prune(nowMs = Date.now()): void {
    for (const [key, list] of this.byKey) {
      this.trim(list, nowMs);
      if (!list.length) this.byKey.delete(key);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  private trim(list: number[], nowMs: number): void {
    const from = nowMs - this.windowMs;
    let i = 0;
    while (i < list.length && list[i] <= from) i++;
    if (i) list.splice(0, i);
  }
}

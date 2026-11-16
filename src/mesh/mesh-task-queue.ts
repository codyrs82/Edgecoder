// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { Subtask } from "../common/types.js";

export interface MeshQueuedTask {
  subtask: Subtask;
  fromPeerId: string;
}

/**
 * The worker's queue of mesh task offers. Both the queue and the set of subtask ids already
 * claimed are bounded, so a flood of offers cannot grow memory without limit.
 */
export class MeshTaskQueue {
  private readonly items: MeshQueuedTask[] = [];
  /** Insertion-ordered, so the oldest id is evicted first once full. */
  private readonly claimed = new Set<string>();

  constructor(
    readonly maxQueued = 32,
    readonly maxClaimed = 4096
  ) {}

  get length(): number {
    return this.items.length;
  }

  hasClaimed(subtaskId: string): boolean {
    return this.claimed.has(subtaskId);
  }

  isFull(): boolean {
    return this.items.length >= this.maxQueued;
  }

  /** Queue an offer and remember its id. False when the queue is full or the id was seen. */
  push(item: MeshQueuedTask): boolean {
    if (this.isFull() || this.claimed.has(item.subtask.id)) return false;
    this.items.push(item);
    this.claimed.add(item.subtask.id);
    while (this.claimed.size > this.maxClaimed) {
      const oldest = this.claimed.values().next().value;
      if (oldest === undefined) break;
      this.claimed.delete(oldest);
    }
    return true;
  }

  /** Drop a queued task another peer claimed. */
  remove(subtaskId: string): boolean {
    const idx = this.items.findIndex((t) => t.subtask.id === subtaskId);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    return true;
  }

  shift(): MeshQueuedTask | undefined {
    return this.items.shift();
  }
}

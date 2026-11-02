// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator side of streamed network inference: the agent running a subtask appends pieces of
 * the reply as they are generated; the requester reads them with a long poll (returns at once
 * when there is something new, else waits a few seconds). Kept in memory for a while after the
 * reply ends.
 */

import { EventEmitter } from "node:events";

const KEEP_AFTER_DONE_MS = 10 * 60_000;
const MAX_CHARS = 2_000_000;

interface Stream {
  chunks: string[];
  /** Next sequence number expected from the agent (pieces are applied in order, duplicates ignored). */
  nextSeq: number;
  chars: number;
  done: boolean;
  error?: string;
  doneAtMs?: number;
  /** Tool calls the model made (Ollama format), sent with the last piece. */
  toolCalls?: unknown[];
}

export class InferenceStreams {
  private readonly streams = new Map<string, Stream>();
  private readonly events = new EventEmitter();

  constructor() {
    this.events.setMaxListeners(0);
  }

  /** Open a stream for a subtask (at submit). */
  open(subtaskId: string): void {
    if (!this.streams.has(subtaskId)) this.streams.set(subtaskId, { chunks: [], nextSeq: 0, chars: 0, done: false });
  }

  has(subtaskId: string): boolean {
    return this.streams.has(subtaskId);
  }

  /**
   * Apply a piece from the agent. Out-of-order pieces ahead of the next expected one are refused
   * (the agent sends them in order; a gap means a lost request, and the final result has it all).
   */
  append(subtaskId: string, seq: number, delta: string, done = false, error?: string, toolCalls?: unknown[]): "ok" | "duplicate" | "unknown" | "gap" | "too_large" {
    const s = this.streams.get(subtaskId);
    if (!s) return "unknown";
    if (seq < s.nextSeq) return "duplicate";
    if (seq > s.nextSeq) return "gap";
    if (s.chars + delta.length > MAX_CHARS) return "too_large";
    s.nextSeq++;
    if (delta) {
      s.chunks.push(delta);
      s.chars += delta.length;
    }
    if (toolCalls?.length) s.toolCalls = [...(s.toolCalls ?? []), ...toolCalls];
    if (done) this.finish(subtaskId, error);
    this.events.emit(subtaskId);
    return "ok";
  }

  /** End a stream (also when the result arrives without a final piece). */
  finish(subtaskId: string, error?: string): void {
    const s = this.streams.get(subtaskId);
    if (!s || s.done) return;
    s.done = true;
    s.error = error;
    s.doneAtMs = Date.now();
    this.events.emit(subtaskId);
  }

  /** Pieces after index `after`; waits up to `waitMs` for something new when there is nothing yet. */
  async read(subtaskId: string, after: number, waitMs: number): Promise<{ chunks: string[]; next: number; done: boolean; error?: string; toolCalls?: unknown[] } | null> {
    const s = this.streams.get(subtaskId);
    if (!s) return null;
    if (s.chunks.length <= after && !s.done && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          this.events.removeListener(subtaskId, done);
          resolve();
        };
        const t = setTimeout(done, waitMs);
        this.events.on(subtaskId, done);
      });
    }
    return { chunks: s.chunks.slice(after), next: s.chunks.length, done: s.done, ...(s.error ? { error: s.error } : {}), ...(s.done && s.toolCalls ? { toolCalls: s.toolCalls } : {}) };
  }

  /** Drop streams that ended long ago. */
  prune(now = Date.now()): void {
    for (const [id, s] of this.streams) if (s.done && s.doneAtMs !== undefined && now - s.doneAtMs > KEEP_AFTER_DONE_MS) this.streams.delete(id);
  }
}

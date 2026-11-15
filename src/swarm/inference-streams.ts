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
  /** Task the stream's subtask belongs to (set at open), so a reader is checked against it. */
  taskId?: string;
  /** UTF-8 size of everything accepted (text and tool calls): the most tokens the reply can be. */
  bytes: number;
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
  open(subtaskId: string, taskId?: string): void {
    if (!this.streams.has(subtaskId)) this.streams.set(subtaskId, { chunks: [], nextSeq: 0, chars: 0, bytes: 0, done: false, taskId });
  }

  /** Task a stream was opened for, or undefined. */
  taskOf(subtaskId: string): string | undefined {
    return this.streams.get(subtaskId)?.taskId;
  }

  /** UTF-8 bytes accepted into a stream so far (text plus tool calls), or undefined when unknown. */
  replyBytes(subtaskId: string): number | undefined {
    return this.streams.get(subtaskId)?.bytes;
  }

  has(subtaskId: string): boolean {
    return this.streams.has(subtaskId);
  }

  /**
   * Apply a piece from the agent. Out-of-order pieces ahead of the next expected one are refused
   * (the agent sends them in order; a gap means a lost request, and the final result has it all).
   * A stream that has ended takes nothing more ("closed"), so there is exactly one final piece.
   */
  append(subtaskId: string, seq: number, delta: string, done = false, error?: string, toolCalls?: unknown[]): "ok" | "duplicate" | "unknown" | "gap" | "too_large" | "closed" {
    const s = this.streams.get(subtaskId);
    if (!s) return "unknown";
    if (seq < s.nextSeq) return "duplicate";
    if (s.done) return "closed";
    if (seq > s.nextSeq) return "gap";
    if (s.chars + delta.length > MAX_CHARS) return "too_large";
    s.nextSeq++;
    if (delta) {
      s.chunks.push(delta);
      s.chars += delta.length;
      s.bytes += Buffer.byteLength(delta, "utf8");
    }
    if (toolCalls?.length) {
      s.toolCalls = [...(s.toolCalls ?? []), ...toolCalls];
      s.bytes += Buffer.byteLength(JSON.stringify(toolCalls), "utf8");
    }
    // A final piece that ends a reply with no text and no tool call (and no error) does not end the
    // stream: an empty reply is a failed call, which the coordinator may give to another agent.
    if (done && (error || s.chunks.length > 0 || s.toolCalls?.length)) this.finish(subtaskId, error);
    this.events.emit(subtaskId);
    return "ok";
  }

  /** True once the stream has ended. */
  isDone(subtaskId: string): boolean {
    return this.streams.get(subtaskId)?.done === true;
  }

  /** True when the stream has any reply text or tool call (something reached, or can reach, the requester). */
  hasContent(subtaskId: string): boolean {
    const s = this.streams.get(subtaskId);
    return !!s && (s.chunks.length > 0 || !!s.toolCalls?.length);
  }

  /**
   * Make a stream that got nothing ready for another agent: its pieces start again at 0 and an
   * error that ended it is cleared. Refused (false) once any text or tool call was accepted, since
   * the requester may already have it.
   */
  reopenIfEmpty(subtaskId: string): boolean {
    const s = this.streams.get(subtaskId);
    if (!s || s.chunks.length > 0 || s.toolCalls?.length) return false;
    s.nextSeq = 0;
    s.chars = 0;
    s.bytes = 0;
    s.done = false;
    s.error = undefined;
    s.doneAtMs = undefined;
    return true;
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

/** Tokens a chat template (and a model's built-in system prompt) may add on top of the request text. */
export const PROMPT_TOKEN_ALLOWANCE = 2048;
/** End-of-turn and similar tokens that are not in the reply text. */
export const OUTPUT_TOKEN_ALLOWANCE = 64;

/**
 * Keep an agent's reported token counts within what the request and the streamed reply could
 * hold: a token is at least one byte of text, so the request's size bounds the prompt tokens and
 * the accepted stream's size bounds the output tokens. The counts price the call, so they are
 * never taken as reported.
 */
export function boundTokenCounts(
  reported: { promptTokens?: number; outputTokens?: number },
  requestBytes: number,
  replyBytes: number
): { promptTokens?: number; outputTokens?: number } {
  const bound = (n: number | undefined, max: number) => (n === undefined ? undefined : Math.max(0, Math.min(Math.floor(n), Math.floor(max))));
  return {
    promptTokens: bound(reported.promptTokens, requestBytes + PROMPT_TOKEN_ALLOWANCE),
    outputTokens: bound(reported.outputTokens, replyBytes + OUTPUT_TOKEN_ALLOWANCE),
  };
}

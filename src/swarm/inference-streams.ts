// Copyright (c) 2025 EdgeCoder
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
/** Everything a stream may hold (text and tool calls, UTF-8): tool calls used to be unbounded. */
const MAX_BYTES = 8_000_000;
/** A stream that never ends (its subtask's lease lapsed, the agent went away) is dropped after this. */
const MAX_STREAM_AGE_MS = 2 * 60 * 60_000;

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
  openedAtMs: number;
  /** When the first text or tool call arrived (run 7: the decode-rate sample, and stalled claims). */
  firstPieceAtMs?: number;
}

export class InferenceStreams {
  private readonly streams = new Map<string, Stream>();
  private readonly events = new EventEmitter();

  constructor() {
    this.events.setMaxListeners(0);
  }

  /** Open a stream for a subtask (at submit). */
  open(subtaskId: string, taskId?: string): void {
    if (!this.streams.has(subtaskId)) this.streams.set(subtaskId, { chunks: [], nextSeq: 0, chars: 0, bytes: 0, done: false, taskId, openedAtMs: Date.now() });
  }

  /** Task a stream was opened for, or undefined. */
  taskOf(subtaskId: string): string | undefined {
    return this.streams.get(subtaskId)?.taskId;
  }

  /** UTF-8 bytes accepted into a stream so far (text plus tool calls), or undefined when unknown. */
  replyBytes(subtaskId: string): number | undefined {
    return this.streams.get(subtaskId)?.bytes;
  }

  /** The reply text the stream relayed (what the requester got), or undefined when unknown. */
  replyText(subtaskId: string): string | undefined {
    return this.streams.get(subtaskId)?.chunks.join("");
  }

  /** UTF-8 bytes of the tool calls a stream holds (0 when none). */
  toolCallBytes(subtaskId: string): number {
    const t = this.streams.get(subtaskId)?.toolCalls;
    return t?.length ? Buffer.byteLength(JSON.stringify(t), "utf8") : 0;
  }

  /** When the stream's first text or tool call arrived, undefined before (or when unknown). */
  firstPieceAt(subtaskId: string): number | undefined {
    return this.streams.get(subtaskId)?.firstPieceAtMs;
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
    const toolBytes = toolCalls?.length ? Buffer.byteLength(JSON.stringify(toolCalls), "utf8") : 0;
    if (s.bytes + Buffer.byteLength(delta, "utf8") + toolBytes > MAX_BYTES) return "too_large";
    s.nextSeq++;
    if (s.firstPieceAtMs === undefined && (delta || toolCalls?.length)) s.firstPieceAtMs = Date.now();
    if (delta) {
      s.chunks.push(delta);
      s.chars += delta.length;
      s.bytes += Buffer.byteLength(delta, "utf8");
    }
    if (toolCalls?.length) {
      s.toolCalls = [...(s.toolCalls ?? []), ...toolCalls];
      s.bytes += toolBytes;
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

  /**
   * A successful result carries the whole reply. If pieces were lost on the way (a failed post makes
   * every later piece a "gap"), the requester would see the stream end with less text, or none, than
   * it paid for. Append what the stream is missing when what it has is a prefix of the result; true
   * when text was added.
   */
  backfill(subtaskId: string, output: string): boolean {
    const s = this.streams.get(subtaskId);
    if (!s || s.done || !output) return false;
    const have = s.chunks.join("");
    if (have.length >= output.length || !output.startsWith(have)) return false;
    const missing = output.slice(have.length);
    if (s.chars + missing.length > MAX_CHARS) return false;
    s.chunks.push(missing);
    s.chars += missing.length;
    s.bytes += Buffer.byteLength(missing, "utf8");
    this.events.emit(subtaskId);
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
    for (const [id, s] of this.streams) {
      if (s.done && s.doneAtMs !== undefined && now - s.doneAtMs > KEEP_AFTER_DONE_MS) this.streams.delete(id);
      else if (now - s.openedAtMs > MAX_STREAM_AGE_MS) this.streams.delete(id);
    }
  }
}

/** Tokens a chat template (and a model's built-in system prompt) may add on top of the request text. */
export const PROMPT_TOKEN_ALLOWANCE = 2048;
/** End-of-turn and similar tokens that are not in the reply text. */
export const OUTPUT_TOKEN_ALLOWANCE = 64;

/**
 * Keep an agent's reported token counts within what the request and the streamed reply could
 * hold: a token is at least one byte of text, so the request's size bounds the prompt tokens and
 * the accepted stream's size bounds the output tokens. The output is also bounded by the call's
 * output cap (`maxOutputTokens`, the request's maxTokens or INFERENCE_DEFAULT_MAX_TOKENS): an agent
 * that ignores the cap and keeps streaming is not paid for what it streamed past it. The counts
 * price the call, so they are never taken as reported.
 */
export function boundTokenCounts(
  reported: { promptTokens?: number; outputTokens?: number },
  requestBytes: number,
  replyBytes: number,
  maxOutputTokens?: number
): { promptTokens?: number; outputTokens?: number } {
  const bound = (n: number | undefined, max: number) => (n === undefined ? undefined : Math.max(0, Math.min(Math.floor(n), Math.floor(max))));
  const outputMax = replyBytes + OUTPUT_TOKEN_ALLOWANCE;
  return {
    promptTokens: bound(reported.promptTokens, requestBytes + PROMPT_TOKEN_ALLOWANCE),
    outputTokens: bound(reported.outputTokens, maxOutputTokens !== undefined && maxOutputTokens > 0 ? Math.min(outputMax, maxOutputTokens + OUTPUT_TOKEN_ALLOWANCE) : outputMax),
  };
}

/** The output cap a queued model call carries (its input's maxTokens), or undefined (older calls). */
export function maxTokensOf(input: string): number | undefined {
  try {
    const n = (JSON.parse(input) as { maxTokens?: unknown }).maxTokens;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

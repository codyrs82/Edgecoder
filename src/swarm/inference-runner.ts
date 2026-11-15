// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent side of network inference: run a chat completion on this machine's Ollama with the model
 * the requester asked for, and send the reply to the coordinator in pieces as it is generated
 * (POST /inference/chunks), so the requester sees it stream. The full reply is the subtask result,
 * which is what gets billed (measured seconds × the hardware tier's rate).
 */

import type { Subtask, SubtaskResult } from "../common/types.js";
import { ollamaChat } from "../inference-api/ollama.js";
import type { ChatMessage, ToolCall, ToolSpec } from "../inference-api/types.js";

export interface InferenceInput {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

/** Error of a model call that produced no text and no tool call (src/swarm/coordinator/routes/inference.ts retries it). */
export const EMPTY_REPLY_ERROR = "empty_reply";

/** Send what has arrived at least this often, or sooner once this much has piled up. */
const FLUSH_MS = 150;
const FLUSH_CHARS = 400;

export async function runInferenceSubtask(
  st: Subtask,
  deps: {
    agentId: string;
    ollamaHost: string;
    /** Signed POST to the coordinator. */
    post: (path: string, body: unknown) => Promise<unknown>;
  },
): Promise<SubtaskResult> {
  const started = Date.now();
  const base = { subtaskId: st.id, taskId: st.taskId, agentId: deps.agentId };
  let input: InferenceInput;
  try {
    input = JSON.parse(st.input) as InferenceInput;
    if (!Array.isArray(input.messages) || input.messages.length === 0) throw new Error("no messages");
  } catch (err) {
    return { ...base, ok: false, output: "", error: `bad inference request: ${(err as Error).message}`, durationMs: 0 };
  }
  const model = st.requestedModel;
  if (!model) return { ...base, ok: false, output: "", error: "no model requested", durationMs: 0 };

  let seq = 0;
  let pending = "";
  let lastFlush = Date.now();
  let full = "";
  const toolCalls: ToolCall[] = [];
  let tokens: { promptTokens?: number; outputTokens?: number } = {};
  const flush = async (done: boolean, error?: string) => {
    if (!pending && !done) return;
    const delta = pending;
    pending = "";
    lastFlush = Date.now();
    try {
      await deps.post("/inference/chunks", { subtaskId: st.id, seq: seq++, delta, done, ...(error ? { error } : {}), ...(done && toolCalls.length ? { toolCalls } : {}), ...(done ? tokens : {}) });
    } catch {
      // The final result still carries the whole reply.
    }
  };

  const abort = new AbortController();
  // The subtask's own deadline bounds the call; the HTTP client's timeouts sit just past it, so a
  // cold model load (seconds to minutes on a CPU) is not cut off as a "Headers Timeout Error".
  const deadlineMs = Math.max(5_000, st.timeoutMs);
  const timer = setTimeout(() => abort.abort(), deadlineMs);
  try {
    for await (const piece of ollamaChat(deps.ollamaHost, { model, messages: input.messages, tools: input.tools, maxTokens: input.maxTokens, temperature: input.temperature }, abort.signal, deadlineMs + 1_000)) {
      if ("toolCalls" in piece) toolCalls.push(...piece.toolCalls);
      else if ("doneReason" in piece) tokens = { promptTokens: piece.promptTokens, outputTokens: piece.outputTokens };
      else if ("delta" in piece) {
        full += piece.delta;
        pending += piece.delta;
        if (pending.length >= FLUSH_CHARS || Date.now() - lastFlush >= FLUSH_MS) await flush(false);
      }
    }
    if (!full.trim() && toolCalls.length === 0) {
      // No text and no tool call is not an answer. It is reported as a failure without a final
      // piece, so the requester's stream stays open and the coordinator can give the call to
      // another agent; nothing is charged for a failed call.
      return { ...base, ok: false, output: "", error: EMPTY_REPLY_ERROR, durationMs: Date.now() - started };
    }
    await flush(true);
    return { ...base, ok: true, output: full, durationMs: Date.now() - started };
  } catch (err) {
    const msg = abort.signal.aborted ? `timed out after ${Math.round(st.timeoutMs / 1000)} s` : (err as Error).message;
    // Nothing reached the requester yet: leave the stream open, so the call can be retried elsewhere
    // (the failed result tells the coordinator, which ends the stream when it does not retry).
    if (full || toolCalls.length) await flush(true, msg);
    return { ...base, ok: false, output: full, error: msg, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

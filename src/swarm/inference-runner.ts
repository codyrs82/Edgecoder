// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent side of network inference: run a chat completion on this machine's Ollama (or its vLLM /
 * MLX engine, deps.chat) with the model the requester asked for, and send the reply to the coordinator in pieces as it is generated
 * (POST /inference/chunks), so the requester sees it stream. The full reply is the subtask result,
 * which is what gets billed (measured seconds × the hardware tier's rate).
 */

import type { Subtask, SubtaskResult } from "../common/types.js";
import { contextNeeded, ollamaChat, type OllamaPiece } from "../inference-api/ollama.js";
import { EngineError } from "../inference-api/openai-engine.js";
import type { ChatMessage, ToolCall, ToolSpec } from "../inference-api/types.js";
import { isFrontierModelId } from "../inference-api/frontier-models.js";

export interface InferenceInput {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

/** Error of a model call that produced no text and no tool call (src/swarm/coordinator/routes/inference.ts retries it). */
export const EMPTY_REPLY_ERROR = "empty_reply";
/** Error of a call longer than the agent's context window (another agent may serve a bigger one). */
export const CONTEXT_TOO_LONG_ERROR = "context_too_long";
/** A subtask naming a frontier model (frontier/<provider>/<model>): those run only on their owner's own key, never here. */
export const FRONTIER_REFUSED_ERROR = "frontier_models_are_not_network_work";
/** A call the agent cancelled because its host ran critically low on memory (the coordinator gives it to another agent). */
export const CANCELLED_FOR_MEMORY_ERROR = "memory_pressure: cancelled, this host ran critically low on memory";

/** Send what has arrived at least this often, or sooner once this much has piled up. */
const FLUSH_MS = 150;
const FLUSH_CHARS = 400;

export async function runInferenceSubtask(
  st: Subtask,
  deps: {
    agentId: string;
    ollamaHost: string;
    /** How long Ollama keeps the model loaded after the call (AGENT_MODEL_KEEP_ALIVE). */
    keepAlive?: string;
    /** The one context window this agent serves calls with (AGENT_CONTEXT_WINDOW); unset = sized per call. */
    contextWindow?: number;
    /** Signed POST to the coordinator. */
    post: (path: string, body: unknown) => Promise<unknown>;
    /**
     * Run the call on another engine than Ollama (vLLM / MLX: src/inference-api/openai-engine.ts).
     * `model` is the requested catalog tag; the engine maps it to the id it serves. Unset = Ollama.
     */
    chat?: (model: string, req: { messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number; temperature?: number }, signal: AbortSignal, timeoutMs: number) => AsyncIterable<OllamaPiece>;
    /** Cancels the call from outside (critical memory pressure): it fails with CANCELLED_FOR_MEMORY_ERROR. */
    signal?: AbortSignal;
    /** Each piece of reply text as it is generated (Active work's tokens-so-far). */
    onDelta?: (text: string) => void;
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
  // A frontier model (someone's own API key) is never network work: refused before anything runs.
  if (isFrontierModelId(model)) return { ...base, ok: false, output: "", error: FRONTIER_REFUSED_ERROR, durationMs: 0 };

  // A call that does not fit the agent's window is refused before Ollama sees it (asking for a bigger
  // window would reload the model). Nothing was sent, so the coordinator gives it to another agent.
  if (deps.contextWindow) {
    const need = contextNeeded(input.messages, input.tools, input.maxTokens);
    if (need > deps.contextWindow) {
      return { ...base, ok: false, output: "", error: `${CONTEXT_TOO_LONG_ERROR}: needs ${need} tokens, this agent serves ${deps.contextWindow}`, durationMs: 0 };
    }
  }

  let seq = 0;
  let pending = "";
  let lastFlush = Date.now();
  let full = "";
  const toolCalls: ToolCall[] = [];
  // Token counts, and the model-load time of a cold call (the power floor leaves it out: job-pricing.ts).
  let tokens: { promptTokens?: number; outputTokens?: number; loadMs?: number; promptMs?: number; genMs?: number } = {};
  const flush = async (done: boolean, error?: string) => {
    if (!pending && !done) return;
    const delta = pending;
    pending = "";
    lastFlush = Date.now();
    try {
      await deps.post("/inference/chunks", { subtaskId: st.id, seq, delta, done, ...(error ? { error } : {}), ...(done && toolCalls.length ? { toolCalls } : {}), ...(done ? tokens : {}) });
      seq++;
    } catch {
      // Keep the piece and its number: the next flush sends it again with what came after, so one
      // lost post does not make every later piece a gap. (The coordinator also fills a stream in
      // from the final result, which carries the whole reply.)
      if (!done) pending = delta + pending;
    }
  };

  const abort = new AbortController();
  // The subtask's own deadline bounds the call; the HTTP client's timeouts sit just past it, so a
  // cold model load (seconds to minutes on a CPU) is not cut off as a "Headers Timeout Error".
  const deadlineMs = Math.max(5_000, st.timeoutMs);
  const timer = setTimeout(() => abort.abort(), deadlineMs);
  let cancelled = false;
  const onCancel = () => {
    cancelled = true;
    abort.abort();
  };
  if (deps.signal?.aborted) onCancel();
  else deps.signal?.addEventListener("abort", onCancel, { once: true });
  try {
    const pieces = deps.chat
      ? deps.chat(model, { messages: input.messages, tools: input.tools, maxTokens: input.maxTokens, temperature: input.temperature }, abort.signal, deadlineMs + 1_000)
      : ollamaChat(deps.ollamaHost, { model, messages: input.messages, tools: input.tools, maxTokens: input.maxTokens, temperature: input.temperature, keepAlive: deps.keepAlive, numCtx: deps.contextWindow }, abort.signal, deadlineMs + 1_000);
    for await (const piece of pieces) {
      if ("toolCalls" in piece) toolCalls.push(...piece.toolCalls);
      else if ("doneReason" in piece) tokens = { promptTokens: piece.promptTokens, outputTokens: piece.outputTokens, ...(piece.loadMs !== undefined ? { loadMs: piece.loadMs } : {}), ...(piece.promptMs !== undefined ? { promptMs: piece.promptMs } : {}), ...(piece.genMs !== undefined ? { genMs: piece.genMs } : {}) };
      else if ("delta" in piece) {
        full += piece.delta;
        pending += piece.delta;
        deps.onDelta?.(piece.delta);
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
    // The engine's own context check (vLLM counts exact tokens; the estimate above is rough): another
    // agent with a bigger window may serve it, as with the check above.
    const overflow = err instanceof EngineError && err.contextOverflow && !full && toolCalls.length === 0;
    const msg = cancelled ? CANCELLED_FOR_MEMORY_ERROR : abort.signal.aborted ? `timed out after ${Math.round(st.timeoutMs / 1000)} s` : overflow ? `${CONTEXT_TOO_LONG_ERROR}: ${(err as Error).message}` : (err as Error).message;
    // Nothing reached the requester yet: leave the stream open, so the call can be retried elsewhere
    // (the failed result tells the coordinator, which ends the stream when it does not retry).
    if (full || toolCalls.length) await flush(true, msg);
    return { ...base, ok: false, output: full, error: msg, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCancel);
  }
}

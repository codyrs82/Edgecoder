// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent side of network inference: run a chat completion on this machine's Ollama with the model
 * the requester asked for, and send the reply to the coordinator in pieces as it is generated
 * (POST /inference/chunks), so the requester sees it stream. The full reply is the subtask result,
 * which is what gets billed (measured seconds × the hardware tier's rate).
 */

import { request } from "undici";
import type { Subtask, SubtaskResult } from "../common/types.js";

export interface InferenceInput {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

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
  const flush = async (done: boolean, error?: string) => {
    if (!pending && !done) return;
    const delta = pending;
    pending = "";
    lastFlush = Date.now();
    try {
      await deps.post("/inference/chunks", { subtaskId: st.id, seq: seq++, delta, done, ...(error ? { error } : {}) });
    } catch {
      // The final result still carries the whole reply.
    }
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(5_000, st.timeoutMs));
  try {
    const res = await request(`${deps.ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: input.messages,
        stream: true,
        think: false,
        options: {
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.maxTokens !== undefined ? { num_predict: input.maxTokens } : {}),
        },
      }),
      signal: abort.signal,
      headersTimeout: 120_000,
      bodyTimeout: 120_000,
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // plain text
      }
      await flush(true, msg);
      return { ...base, ok: false, output: "", error: `ollama: ${msg}`, durationMs: Date.now() - started };
    }
    let buf = "";
    for await (const part of res.body) {
      buf += Buffer.from(part as Uint8Array).toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: { message?: { content?: string }; error?: string };
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error);
        const delta = chunk.message?.content ?? "";
        if (delta) {
          full += delta;
          pending += delta;
          if (pending.length >= FLUSH_CHARS || Date.now() - lastFlush >= FLUSH_MS) await flush(false);
        }
      }
    }
    await flush(true);
    return { ...base, ok: true, output: full, durationMs: Date.now() - started };
  } catch (err) {
    const msg = abort.signal.aborted ? `timed out after ${Math.round(st.timeoutMs / 1000)} s` : (err as Error).message;
    await flush(true, msg);
    return { ...base, ok: false, output: full, error: msg, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

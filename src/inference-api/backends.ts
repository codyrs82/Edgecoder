// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** What can run a chat: this machine's Ollama (free), or the network (your machines, a lease, or any agent). */

import { NetworkInferenceError, streamNetworkCompletion, type NetworkDeps, type NetworkTarget } from "../apps/ide/network-inference.js";
import { ollamaChat } from "./ollama.js";
import { ChatBackendError, type ChatBackend } from "./types.js";

export function localBackend(ollamaHost: string, model: string): ChatBackend {
  return async function* (req, signal) {
    let stopped = "stop";
    try {
      for await (const p of ollamaChat(ollamaHost, { model, messages: req.messages, tools: req.tools, maxTokens: req.maxTokens, temperature: req.temperature }, signal)) {
        if ("doneReason" in p) stopped = p.doneReason;
        else yield p;
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/ECONNREFUSED|fetch failed|connect/i.test(msg)) throw new ChatBackendError("Ollama isn't running on this computer. Open EdgeCoder to start it.", 503);
      if (/not found/i.test(msg)) throw new ChatBackendError(`${model} isn't installed on this computer. Install it from Settings > Models.`, 404);
      throw new ChatBackendError(msg, 502);
    }
    yield { done: true, cSatsSpent: 0, stopReason: stopped === "length" ? "length" : "stop" };
  };
}

export function networkBackend(deps: NetworkDeps, target: { model: string; computeClass?: string } & NetworkTarget): ChatBackend {
  return async function* (req, signal) {
    try {
      for await (const p of streamNetworkCompletion(deps, { ...target, computeClass: target.computeClass ?? "any", messages: req.messages, tools: req.tools, maxTokens: req.maxTokens, temperature: req.temperature }, signal)) {
        if (p.delta) yield { delta: p.delta };
        if (p.toolCalls?.length) yield { toolCalls: p.toolCalls };
        if (p.done) {
          if (p.error) throw new ChatBackendError(`The machine running ${target.model} reported: ${p.error}`, 502);
          yield { done: true, ...(p.creditsSpent !== undefined ? { cSatsSpent: p.creditsSpent } : {}) };
        }
      }
    } catch (err) {
      if (err instanceof ChatBackendError) throw err;
      if (err instanceof NetworkInferenceError) throw new ChatBackendError(err.message, err.status);
      throw new ChatBackendError((err as Error).message, 502);
    }
  };
}

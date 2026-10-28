// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { swapModel, getModelStatus, listModels, pullModel } from "./swap.js";
import { PullTracker } from "./pull-tracker.js";

/** Ollama model names: `name[:tag]`, optionally `namespace/name`; no segment starts with ".". */
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]*(\/(?!\.)[A-Za-z0-9._\-]+)*(:[A-Za-z0-9._\-]+)?$/;

export interface ModelSwapState {
  activeModel: string;
  activeModelParamSize: number;
  onModelChanged?: (model: string, paramSize: number) => void;
  pullTracker: PullTracker;
}

export function buildModelSwapRoutes(
  app: FastifyInstance,
  state: ModelSwapState,
): void {
  app.post("/model/swap", async (req, reply) => {
    const { model } = req.body as { model: string };
    if (!model || typeof model !== "string") {
      return reply.code(400).send({ error: "model_required" });
    }

    const result = await swapModel(model, state.activeModel, state.pullTracker);

    if (result.status === "ready") {
      state.activeModel = result.active;
      state.activeModelParamSize = result.paramSize;
      state.onModelChanged?.(result.active, result.paramSize);
    }

    return reply.send(result);
  });

  app.get("/model/status", async (_req, reply) => {
    const result = await getModelStatus(state.activeModel);
    return reply.send(result);
  });

  app.get("/model/list", async (_req, reply) => {
    const result = await listModels(state.activeModel);
    return reply.send(result);
  });

  // #37: the desktop Model Manager's "pull" button. Starts the download only; /model/swap switches.
  app.post("/model/pull", async (req, reply) => {
    const model = (req.body as { model?: unknown } | undefined)?.model;
    if (typeof model !== "string" || model.length > 200 || !MODEL_NAME_RE.test(model)) {
      return reply.code(400).send({ error: "model_required" });
    }
    // Claim synchronously, before any await, so concurrent requests can't both start a pull.
    if (!state.pullTracker.tryStart(model)) {
      return reply.code(409).send({ error: "pull_in_progress", progress: state.pullTracker.getProgress() });
    }
    const result = await pullModel(model, state.pullTracker);
    if (result.status === "error") return reply.code(502).send(result);
    return reply.code(result.status === "pulling" ? 202 : 200).send(result);
  });

  app.get("/model/pull/progress", async (_req, reply) => {
    const progress = state.pullTracker.getProgress();
    return reply.send(progress ?? { status: "idle" });
  });
}

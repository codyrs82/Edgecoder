// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { swapModel, getModelStatus, listModels } from "./swap.js";
import { PullTracker } from "./pull-tracker.js";
import { CATEGORY_LABELS, MODEL_CATALOG, MODEL_CATALOG_VERSION } from "./catalog.js";

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

  /** Curated install catalog (see src/model/catalog.ts). Read-only; the desktop app refreshes its bundled copy from here. */
  app.get("/model/catalog", async (_req, reply) => {
    return reply.send({ version: MODEL_CATALOG_VERSION, categories: CATEGORY_LABELS, models: MODEL_CATALOG });
  });

  app.get("/model/pull/progress", async (_req, reply) => {
    const progress = state.pullTracker.getProgress();
    return reply.send(progress ?? { status: "idle" });
  });
}

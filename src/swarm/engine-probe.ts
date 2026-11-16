// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent side of a vLLM / MLX engine (src/inference-api/openai-engine.ts): is it up, which model
 * does it serve (as a catalog tag), with what context window, and how many calls at once.
 *
 * The agent reports exactly what the engine serves: the catalog tag of the served model as its
 * one installed model (so buyers, pricing and best-fit routing see "qwen3-coder:30b" whatever the
 * engine), the served context length as its context window, and its slots. When the engine is
 * down or serves something else, the agent reports no model and no free slot, and says why.
 */

import { catalogEntryForTag } from "../model/catalog.js";
import { catalogTagForEngineModel } from "../model/engine-models.js";
import { paramsB } from "../inference-api/auto-route.js";
import { ENGINE_PRESETS, engineKvCacheTokens, listEngineModels, type OpenAiEngine, type OpenAiEnginePreset } from "../inference-api/openai-engine.js";
import { servedContextWindow } from "./parallelism.js";

/** Largest context window an agent reports (AGENT_CONTEXT_WINDOW's bound). */
export const MAX_AGENT_CONTEXT_WINDOW = 131_072;
/** Slots an agent reports at most (the coordinator's pull schema bound). */
export const MAX_AGENT_SLOTS = 16;

export interface EngineServedModel {
  /** Served id (HF repo id, or a --served-model-name). */
  id: string;
  /** Catalog tag it maps to; undefined = not a catalog model. */
  tag?: string;
  maxModelLen?: number;
}

export interface EngineStatus {
  ok: boolean;
  preset: OpenAiEnginePreset;
  served: EngineServedModel[];
  /** The model the agent serves network calls with. */
  model?: Required<Pick<EngineServedModel, "id" | "tag">> & { maxModelLen?: number };
  /** vLLM KV-cache size in tokens. */
  kvCacheTokens?: number;
  /** Why it is not ok, for the log (and the operator). */
  problem?: string;
}

/**
 * Probe the engine: /v1/models, then (vLLM) /metrics. `want` is VLLM_MODEL / MLX_MODEL: when
 * set, that served id must be listed; otherwise the first served model that maps to a catalog
 * tag is used. Never throws.
 */
export async function probeEngine(engine: OpenAiEngine & { model?: string }, aliases: Map<string, string> = new Map(), timeoutMs = 5_000): Promise<EngineStatus> {
  const label = ENGINE_PRESETS[engine.preset].label;
  let served: EngineServedModel[];
  try {
    served = (await listEngineModels(engine, timeoutMs)).map((m) => {
      const tag = catalogTagForEngineModel(m.id, aliases);
      return { id: m.id, ...(tag ? { tag } : {}), ...(m.maxModelLen ? { maxModelLen: m.maxModelLen } : {}) };
    });
  } catch (e) {
    return { ok: false, preset: engine.preset, served: [], problem: `${label} is not reachable at ${engine.url} (${String((e as Error).message ?? e).slice(0, 160)}); start it (docs/inference-engines.md)` };
  }
  const base = { preset: engine.preset, served };
  if (served.length === 0) return { ...base, ok: false, problem: `${label} at ${engine.url} serves no model yet (still loading?)` };
  let pick: EngineServedModel | undefined;
  if (engine.model) {
    pick = served.find((m) => m.id === engine.model);
    if (!pick) return { ...base, ok: false, problem: `${label} serves ${served.map((m) => m.id).slice(0, 5).join(", ")}, not the configured ${ENGINE_PRESETS[engine.preset].modelEnv}=${engine.model}` };
    if (!pick.tag) return { ...base, ok: false, problem: `${engine.model} is not a catalog model the network routes; map it with ENGINE_MODEL_ALIASES="${engine.model}=<catalog tag>"` };
  } else {
    pick = served.find((m) => m.tag);
    if (!pick) return { ...base, ok: false, problem: `${label} serves ${served.map((m) => m.id).slice(0, 5).join(", ")}, none of them a catalog model; set ENGINE_MODEL_ALIASES="<served id>=<catalog tag>"` };
  }
  const kvCacheTokens = await engineKvCacheTokens(engine, timeoutMs);
  return { ...base, ok: true, model: { id: pick.id, tag: pick.tag as string, ...(pick.maxModelLen ? { maxModelLen: pick.maxModelLen } : {}) }, ...(kvCacheTokens ? { kvCacheTokens } : {}) };
}

/**
 * The context window and slots an engine-backed agent reports.
 *
 * Context window: vLLM's max_model_len (a call longer than it would be refused by vLLM), lowered by
 * AGENT_CONTEXT_WINDOW when that is set and smaller. MLX does not report one: AGENT_CONTEXT_WINDOW,
 * else the memory estimate Ollama agents use (parallelism.ts servedContextWindow), never above the
 * model's own (catalog contextTokens).
 *
 * Slots: VLLM_MAX_SLOTS / MLX_MAX_SLOTS, else AGENT_PARALLEL_INFERENCE, else the preset default:
 * MLX 1; vLLM from its KV cache, as many calls as fit if each uses half the window
 * (kvTokens / (window / 2)), 1 when the cache size is unknown. Always 1-16.
 */
export function engineServing(opts: {
  preset: OpenAiEnginePreset;
  status: Pick<EngineStatus, "model" | "kvCacheTokens">;
  maxSlots?: number;
  parallelOverride?: string;
  contextOverride?: number;
  totalMemBytes: number;
}): { slots: number; contextWindow: number } {
  const clampSlots = (n: number) => Math.max(1, Math.min(MAX_AGENT_SLOTS, Math.floor(n)));
  const override = opts.contextOverride !== undefined && Number.isInteger(opts.contextOverride) && opts.contextOverride >= 2048 ? opts.contextOverride : undefined;
  const tag = opts.status.model?.tag;
  const modelParamsB = tag ? paramsB(tag) : undefined;
  const par = Number(opts.parallelOverride);
  const configured = opts.maxSlots ?? (Number.isInteger(par) && par >= 1 && par <= 16 ? par : undefined);

  let contextWindow: number;
  const served = opts.status.model?.maxModelLen;
  if (served) {
    contextWindow = Math.min(override ?? served, served, MAX_AGENT_CONTEXT_WINDOW);
  } else {
    const slotsForEstimate = configured ?? (ENGINE_PRESETS[opts.preset].defaultSlots === "derive" ? 1 : (ENGINE_PRESETS[opts.preset].defaultSlots as number));
    contextWindow = servedContextWindow(opts.totalMemBytes, override, { modelParamsB, slots: slotsForEstimate });
    const own = tag ? catalogEntryForTag(tag)?.contextTokens : undefined;
    if (own) contextWindow = Math.min(contextWindow, own);
    contextWindow = Math.min(contextWindow, MAX_AGENT_CONTEXT_WINDOW);
  }

  let slots: number;
  if (configured !== undefined) slots = clampSlots(configured);
  else {
    const d = ENGINE_PRESETS[opts.preset].defaultSlots;
    if (d === "derive") slots = opts.status.kvCacheTokens ? clampSlots(opts.status.kvCacheTokens / (contextWindow / 2)) : 1;
    else slots = clampSlots(d);
  }
  return { slots, contextWindow };
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * #54: which models an agent may be routed work for.
 *
 * An agent that reports its Ollama models (`installedModels`, read from /api/tags, in a signed
 * /register or /heartbeat) has a *reported* catalog. Only a reported catalog makes an agent
 * eligible for work that names a model: the coordinator's assumed default (older agents that
 * don't report) and models announced over unsigned mesh gossip never do. Older agents keep
 * working for tasks that don't name a model.
 */

export interface ModelCapability {
  activeModel?: string;
  localModelCatalog?: string[];
  /** True once the agent reported its installed models in a signed request. */
  modelsReported?: boolean;
}

/** Placeholder catalog entry for agents without a local Ollama; never a routable model. */
export const DEFAULT_CATALOG_ENTRY = "edgecoder-default";

/** Normalized model list from an agent report: trimmed, de-duplicated, placeholder dropped. */
export function normalizeReportedModels(models: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const m of models ?? []) {
    const t = typeof m === "string" ? m.trim() : "";
    if (t && t !== DEFAULT_CATALOG_ENTRY) out.add(t);
  }
  return [...out];
}

/** Models this agent may serve a model-named job for (inference: any installed model). */
export function routableModels(cap: ModelCapability | undefined): string[] {
  if (!cap?.modelsReported) return [];
  return (cap.localModelCatalog ?? []).filter((m) => m && m !== DEFAULT_CATALOG_ENTRY);
}

/** The agent has `model` installed (reported). Inference runs any installed model by name. */
export function agentHasModel(cap: ModelCapability | undefined, model: string | undefined): boolean {
  if (!model) return false;
  return routableModels(cap).includes(model);
}

/**
 * The agent runs `model` for a code subtask: code work runs on the agent's active model, so it must
 * be that model, and installed.
 */
export function agentRunsModel(cap: ModelCapability | undefined, model: string | undefined): boolean {
  return Boolean(model) && cap?.activeModel === model && agentHasModel(cap, model);
}

/** Claim gate: a subtask that names a model goes only to an agent that has (inference) or runs (code) it. */
export function subtaskModelEligible(cap: ModelCapability | undefined, subtask: { kind?: string; requestedModel?: string }): boolean {
  if (!subtask.requestedModel) return true;
  return subtask.kind === "inference" ? agentHasModel(cap, subtask.requestedModel) : agentRunsModel(cap, subtask.requestedModel);
}

/**
 * Result check: an agent that says which model produced the result (newer agents, inside the signed
 * request) must name the requested one. Absent = older agent; the claim gate already applied.
 */
export function resultModelMismatch(requestedModel: string | undefined, reportedModel: string | undefined): boolean {
  return Boolean(requestedModel) && reportedModel !== undefined && reportedModel !== requestedModel;
}

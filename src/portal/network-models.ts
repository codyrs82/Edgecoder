// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * GET /portal/api/models `swarm`: the network's models, built from the coordinator's
 * /inference/models (the list the web chat and the desktop app pick from), cloud models included.
 *
 * The iPhone app decodes each row as `{ model: String, paramSize: Double, agentCount: Int }`
 * (ios/.../Chat/ModelPickerModels.swift PortalSwarmModel): those three are always present, with a
 * number for paramSize (never null) and an integer agentCount. The other fields are optional
 * extras the app ignores (Swift's Decodable skips unknown keys).
 */

import { paramsB } from "../inference-api/auto-route.js";
import { cloudLabel, orderCloudModels } from "../cloud-host/catalog.js";

/** One /inference/models row, as far as this reads it (src/swarm/coordinator/routes/inference.ts). */
export interface InferenceModelRow {
  model: string;
  agents?: number;
  classes?: string[];
  paramsB?: number;
  contextWindow?: number;
  cSatsPerMTokens?: { input: number; output: number };
  origin?: { vendor: string; country: string };
  hostedBy?: string;
  cloudRank?: number;
  cloudHint?: string;
  restricted?: string;
}

export interface SwarmModelRow {
  model: string;
  /** Billions of parameters (MoE total); a number always (the app formats it). */
  paramSize: number;
  /** Machines online that serve it; a cloud model counts its cloud host(s). */
  agentCount: number;
  classes?: string[];
  contextWindow?: number;
  cSatsPerMTokens?: { input: number; output: number };
  origin?: { vendor: string; country: string };
  /** A cloud model (src/cloud-host/): served through a hosted API by the platform's cloud host. */
  cloud?: true;
  /** "Cloud · recommended", "Cloud · premium". */
  label?: string;
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** The `swarm` rows for /inference/models' `models`: restricted models left out, cloud models in catalog rank order. */
export function swarmModelsFromInference(rows: unknown): SwarmModelRow[] {
  if (!Array.isArray(rows)) return [];
  const usable = rows.filter((r): r is InferenceModelRow => !!r && typeof r === "object" && typeof (r as InferenceModelRow).model === "string" && (r as InferenceModelRow).model.length > 0);
  const ordered = orderCloudModels(usable, (r) => r.model, (r) => (typeof r.cloudRank === "number" ? r.cloudRank : undefined));
  const out: SwarmModelRow[] = [];
  for (const r of ordered) {
    // A security research tier model runs only on your own or leased machines, never as a network call.
    if (r.restricted) continue;
    const size = typeof r.paramsB === "number" && Number.isFinite(r.paramsB) && r.paramsB > 0 ? r.paramsB : paramsB(r.model);
    const cloud = typeof r.cloudRank === "number" || (r.classes ?? []).includes("cloud");
    out.push({
      model: r.model,
      paramSize: Number.isFinite(size) && size > 0 ? size : 7,
      // A cloud model is listed only while a cloud host holding it is online: at least one.
      agentCount: cloud ? Math.max(1, count(r.agents)) : count(r.agents),
      ...(Array.isArray(r.classes) ? { classes: r.classes } : {}),
      ...(typeof r.contextWindow === "number" ? { contextWindow: r.contextWindow } : {}),
      ...(r.cSatsPerMTokens ? { cSatsPerMTokens: r.cSatsPerMTokens } : {}),
      ...(r.origin ? { origin: r.origin } : {}),
      ...(cloud ? { cloud: true as const, label: cloudLabel(r.cloudHint) } : {}),
    });
  }
  return out;
}

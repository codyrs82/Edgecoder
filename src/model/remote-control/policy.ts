// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The agent's own policy for remote model commands. A command signed by the agent's coordinator
 * for the agent's owner still passes only what the host allows:
 *
 *   - AGENT_REMOTE_CONTROL=off: no command changes anything (the state is still reported, view only);
 *   - AGENT_MODEL_ALLOWLIST: models a command may pull or select. Unset = the curated catalog
 *     (src/model/catalog.ts). A comma-separated list replaces it; the word `catalog` in the list
 *     adds the catalog back (`catalog,qwen3:32b`), and `none` allows nothing;
 *   - bounds on the context window, parallel slots and keep-alive (SETTINGS_BOUNDS);
 *   - a pull must fit the free disk and this machine's memory (fitCheck).
 */

import { MODEL_CATALOG, catalogEntryForTag } from "../catalog.js";
import { isOllamaLibraryModelName } from "../ollama-installer.js";
import type { ModelSettingsBounds } from "./protocol.js";

export const SETTINGS_BOUNDS: ModelSettingsBounds = {
  // The env var's own range (src/config/worker.ts AGENT_CONTEXT_WINDOW).
  contextWindow: { min: 2048, max: 131_072 },
  parallel: { min: 1, max: 8 },
  // 0 (unload after each call) up to a day, or -1 (never unload).
  keepAliveSeconds: { min: 0, max: 24 * 3600 }
};

export function remoteControlEnabled(value: string | undefined): boolean {
  return !/^(off|0|false|no)$/i.test(String(value ?? "").trim());
}

export interface ModelAllowlist {
  /** Exact Ollama tags allowed (name:tag; a bare name means name:latest). */
  models: Map<string, { sizeBytes?: number; minMemoryGb?: number }>;
}

/** "19 GB" / "4.7 GB" / "800 MB" -> bytes. */
export function parseSizeText(text: string): number | undefined {
  const m = /^\s*([\d.]+)\s*(KB|MB|GB|TB)\s*$/i.exec(text);
  if (!m) return undefined;
  const mult = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase() as "KB" | "MB" | "GB" | "TB"];
  return Math.round(Number(m[1]) * mult);
}

export function normalizeModelTag(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

export function resolveAllowlist(envValue: string | undefined): ModelAllowlist {
  const models = new Map<string, { sizeBytes?: number; minMemoryGb?: number }>();
  const addCatalog = () => {
    for (const m of MODEL_CATALOG) models.set(normalizeModelTag(m.modelId), { sizeBytes: parseSizeText(m.diskSize), minMemoryGb: m.minMemoryGb });
  };
  const raw = String(envValue ?? "").trim();
  if (!raw) {
    addCatalog();
    return { models };
  }
  for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (item.toLowerCase() === "none") continue;
    if (item.toLowerCase() === "catalog") {
      addCatalog();
      continue;
    }
    if (!isOllamaLibraryModelName(item)) continue;
    const tag = normalizeModelTag(item);
    const entry = catalogEntryForTag(tag);
    models.set(tag, entry ? { sizeBytes: parseSizeText(entry.diskSize), minMemoryGb: entry.minMemoryGb } : {});
  }
  return { models };
}

/** The allowlist entry for a name, or undefined when the host does not allow it. */
export function allowedModel(allowlist: ModelAllowlist, name: string): { sizeBytes?: number; minMemoryGb?: number } | undefined {
  if (!isOllamaLibraryModelName(name)) return undefined;
  return allowlist.models.get(normalizeModelTag(name));
}

/** Keep-alive text (Ollama's keep_alive) -> seconds; -1 for never; undefined when malformed. */
export function keepAliveSeconds(value: string): number | undefined {
  const v = value.trim();
  if (v === "-1") return -1;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Math.round(n * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1));
}

export type SettingsPatch = { contextWindow?: number | "auto"; parallel?: number | "auto"; keepAlive?: string };

/** Checks a settings change against SETTINGS_BOUNDS ("auto" is always in bounds); returns the first problem, or null. */
export function settingsProblem(patch: SettingsPatch, bounds: ModelSettingsBounds = SETTINGS_BOUNDS): string | null {
  if (patch.contextWindow !== undefined && patch.contextWindow !== "auto") {
    const c = patch.contextWindow;
    if (!Number.isInteger(c) || c < bounds.contextWindow.min || c > bounds.contextWindow.max) return "context_window_out_of_bounds";
  }
  if (patch.parallel !== undefined && patch.parallel !== "auto") {
    const p = patch.parallel;
    if (!Number.isInteger(p) || p < bounds.parallel.min || p > bounds.parallel.max) return "parallel_out_of_bounds";
  }
  if (patch.keepAlive !== undefined) {
    const s = keepAliveSeconds(patch.keepAlive);
    if (s === undefined) return "keep_alive_malformed";
    if (s !== -1 && (s < bounds.keepAliveSeconds.min || s > bounds.keepAliveSeconds.max)) return "keep_alive_out_of_bounds";
  }
  return null;
}

const GiB = 1024 ** 3;

/**
 * Will a model of `sizeBytes` fit this machine? Disk: the download plus 10% and 2 GiB to spare.
 * Memory: the weights must fit the GPU's VRAM plus half the RAM (Ollama offloads the rest of the
 * layers to the CPU, slowly but it runs), or 75% of the RAM without a GPU. `minMemoryGb` from the
 * catalog, when known, is checked the same way.
 */
export function fitCheck(input: {
  sizeBytes: number;
  minMemoryGb?: number;
  diskFreeBytes?: number;
  ramBytes: number;
  vramBytes?: number;
  /** Bytes already on disk for this model (a re-pull of an installed tag downloads only what changed). */
  alreadyInstalledBytes?: number;
}): { ok: true } | { ok: false; reason: "insufficient_disk" | "insufficient_memory"; needBytes: number; haveBytes: number } {
  const download = Math.max(0, input.sizeBytes - (input.alreadyInstalledBytes ?? 0));
  if (input.diskFreeBytes !== undefined) {
    const need = Math.round(download * 1.1) + 2 * GiB;
    if (download > 0 && need > input.diskFreeBytes) return { ok: false, reason: "insufficient_disk", needBytes: need, haveBytes: input.diskFreeBytes };
  }
  const memory = input.vramBytes && input.vramBytes > 0 ? input.vramBytes + input.ramBytes * 0.5 : input.ramBytes * 0.75;
  const needMem = Math.max(input.sizeBytes, (input.minMemoryGb ?? 0) * 1e9 * (input.vramBytes ? 0.9 : 1));
  if (needMem > memory) return { ok: false, reason: "insufficient_memory", needBytes: Math.round(needMem), haveBytes: Math.round(memory) };
  return { ok: true };
}

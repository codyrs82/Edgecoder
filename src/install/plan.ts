// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Install plan: from detected hardware and the installer options to a list of agent instances,
 * each with its own Ollama server, model and env file. The same plan is realised by systemd,
 * launchd and Windows scheduled tasks (services.ts), so every platform installs the same thing.
 */
import { EDGECODER_SEED_KEYS, isEdgecoderNetworkUrl } from "../trust/seed-keys.js";
import { gpuModelForVram, MODEL_CATALOG, type CatalogModel } from "../model/catalog.js";
import { parallelInferenceFor } from "../swarm/parallelism.js";
import type { GpuInfo, HostHardware } from "./hardware.js";
import type { InstallOptions } from "./options.js";

export const OLLAMA_BASE_PORT = 11434;

export interface AgentInstance {
  index: number;
  agentId: string;
  /** The instance's first GPU (its agent reports this card's hardware). */
  gpu?: GpuInfo;
  /** Every GPU the instance's Ollama uses (one card, or several pooled for a bigger model). */
  gpus: GpuInfo[];
  ollamaPort: number;
  model: string;
  /** Memory the model choice was based on (GPU VRAM, or RAM / unified memory). */
  memoryGb: number;
  env: Record<string, string>;
}

export interface InstallPlan {
  hostname: string;
  platform: NodeJS.Platform;
  sandboxMode: "docker" | "none";
  instances: AgentInstance[];
  warnings: string[];
}

/**
 * Best model that fits the memory: catalog minMemoryGb already includes headroom, so a 24 GB card
 * gets the 24 GB coder. Recommended models first, then coding over general over small, then size.
 */
export function pickModel(memoryGb: number, catalog: CatalogModel[] = MODEL_CATALOG): string {
  const fits = catalog.filter((m) => m.minMemoryGb <= memoryGb);
  if (fits.length === 0) return catalog[catalog.length - 1]?.modelId ?? "qwen3.5:2b";
  const rank = (m: CatalogModel) => (m.recommended ? 2000 : 0) + (m.category === "coding" ? 1000 : m.category === "general" ? 500 : 0) + m.minMemoryGb;
  return [...fits].sort((a, b) => rank(b) - rank(a))[0].modelId;
}

function agentOs(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
}

export function planInstall(hw: HostHardware, opts: InstallOptions, dockerAvailable: boolean): InstallPlan {
  const warnings: string[] = [];
  const sandboxMode: "docker" | "none" = opts.sandbox === "none" ? "none" : dockerAvailable ? "docker" : "none";
  if (sandboxMode === "none") warnings.push("Docker is not available: agents will register but not pull swarm tasks until Docker is installed (SANDBOX_MODE=docker).");
  else if (hw.platform === "darwin") warnings.push("macOS: the agents run as the _edgecoder account, which cannot use a Docker Desktop socket owned by your login user; until it can reach a Docker daemon, agents register but pull no swarm tasks (docs/install.md).");
  const discrete = hw.gpus.filter((g) => g.vendor === "nvidia" || g.vendor === "amd");
  let slots: GpuInfo[][];
  if (opts.instances && opts.instances > 0) {
    slots = Array.from({ length: opts.instances }, (_, i) => (discrete[i] ? [discrete[i]] : []));
  } else if (discrete.length > 0) {
    slots = gpuGroups(discrete, opts);
  } else {
    slots = [hw.gpus[0] ? [hw.gpus[0]] : []];
  }
  const base = (opts.agentIdPrefix ?? hw.hostname).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const instances: AgentInstance[] = slots.map((group, index) => {
    const gpu = group[0];
    const discreteGpu = !!gpu && gpu.vendor !== "apple";
    // A pooled instance's model can use every card's VRAM.
    const memoryGb = discreteGpu ? group.reduce((n, g) => n + g.vramGb, 0) : hw.ramGb;
    const model = opts.model ?? (discreteGpu ? gpuModelForVram(memoryGb) : pickModel(memoryGb));
    const gpuTag = group.length > 1 ? `gpu${group[0].index}-${group[group.length - 1].index}` : `gpu${gpu?.index ?? index}`;
    const agentId = slots.length === 1 ? `${base}-${gpu ? (group.length > 1 ? gpuTag : "gpu") : "cpu"}` : `${base}-${gpuTag}`;
    const ollamaPort = OLLAMA_BASE_PORT + index;
    const env: Record<string, string> = {
      EDGE_RUNTIME_MODE: "worker",
      AGENT_ID: agentId,
      AGENT_OS: agentOs(hw.platform),
      AGENT_MODE: "swarm-only",
      AGENT_CLIENT_TYPE: "edgecoder-native",
      SANDBOX_MODE: sandboxMode,
      COORDINATOR_URL: opts.coordinatorUrl,
      MESH_AUTH_TOKEN: opts.meshToken ?? "",
      PORTAL_URL: opts.portalUrl,
      AGENT_REGISTRATION_TOKEN: opts.tokens[agentId] ?? opts.tokens["*"] ?? "",
      LOCAL_MODEL_PROVIDER: "edgecoder-local",
      OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
      OLLAMA_MODEL: model,
      MAX_CONCURRENT_TASKS: "1",
      // Parallel model calls sized by this instance's own memory (the GPU's VRAM, not host RAM);
      // its Ollama gets the same OLLAMA_NUM_PARALLEL (services.ts), as the desktop app does.
      AGENT_PARALLEL_INFERENCE: String(parallelInferenceFor(memoryGb * 1024 ** 3)),
      EDGECODER_INSTANCE: String(index)
    };
    // On the edgecoder.io network the agent trusts only the seeds' published keys, as the desktop app does.
    if (isEdgecoderNetworkUrl(opts.coordinatorUrl)) {
      env.EDGECODER_TRUST_MODE = "strict";
      env.TRUSTED_COORDINATOR_KEYS = EDGECODER_SEED_KEYS.join(",");
    }
    if (gpu && gpu.vendor !== "apple") {
      // The agent detects its card itself (nvidia-smi / rocm-smi, picked by EDGECODER_GPU_INDEX).
      // AGENT_GPU_* are not written: they are the container override, and an overridden profile
      // is flagged and loses its verified tier on every restart (worker-runner buildHardwareProfile).
      const visible = group.map((g) => g.index).join(",");
      env.CUDA_VISIBLE_DEVICES = visible;
      env.HIP_VISIBLE_DEVICES = visible;
      env.EDGECODER_GPU_INDEX = String(gpu.index);
    }
    if (!env.AGENT_REGISTRATION_TOKEN) warnings.push(`${agentId}: no registration token; enrol this node id in the portal and re-run with --token ${agentId}=<token>`);
    return { index, agentId, gpu, gpus: group, ollamaPort, model, memoryGb, env };
  });
  return { hostname: hw.hostname, platform: hw.platform, sandboxMode, instances, warnings };
}

/**
 * How a host's GPUs become instances. --gpus-per-instance pools N cards each. Otherwise the layout:
 * per-gpu (one model per card: the most parallel work), single (every card pooled: the biggest
 * model), or mixed (half the cards one per card, the rest in pairs: fast work and a bigger model
 * side by side). Default: mixed on 4+ cards of 40 GB or more, else per-gpu.
 */
export function gpuGroups(gpus: GpuInfo[], opts: Pick<InstallOptions, "layout" | "gpusPerInstance" | "perGpu">): GpuInfo[][] {
  const chunk = (n: number, from: GpuInfo[]) => Array.from({ length: Math.ceil(from.length / n) }, (_, i) => from.slice(i * n, i * n + n));
  if (opts.gpusPerInstance && opts.gpusPerInstance > 0) return chunk(opts.gpusPerInstance, gpus);
  const layout = opts.layout ?? (!opts.perGpu ? "single" : gpus.length >= 4 && gpus.every((g) => g.vramGb >= 40) ? "mixed" : "per-gpu");
  if (layout === "single") return [gpus];
  if (layout === "mixed") {
    const singles = Math.ceil(gpus.length / 2);
    return [...chunk(1, gpus.slice(0, singles)), ...chunk(2, gpus.slice(singles))];
  }
  return chunk(1, gpus);
}

export function renderEnvFile(env: Record<string, string>): string {
  const lines = ["# Generated by edgecoder-install; re-run the installer rather than editing by hand.", "# Values you may change: AGENT_REGISTRATION_TOKEN, OLLAMA_MODEL, MAX_CONCURRENT_TASKS."];
  for (const [k, v] of Object.entries(env)) lines.push(`${k}=${v}`);
  return lines.join("\n") + "\n";
}

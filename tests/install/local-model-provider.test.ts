// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/common/config.js";
import { workerConfigSchema } from "../../src/config/worker.js";
import { resolveEngine } from "../../src/inference-api/openai-engine.js";
import { resolveInstanceEngine, VLLM_PROFILES, parseEnvFile } from "../../src/install/engine.js";
import { detectHardware } from "../../src/install/hardware.js";
import { parseInstallArgs } from "../../src/install/options.js";
import { localModelProvider, planInstall, renderEnvFile, type AgentInstance } from "../../src/install/plan.js";
import { catalogTagForEngineModel, parseModelAliases } from "../../src/model/engine-models.js";
import { MODEL_CATALOG } from "../../src/model/catalog.js";
import { probeEngine } from "../../src/swarm/engine-probe.js";

/*
 * The installer's LOCAL_MODEL_PROVIDER. The worker reports installed models, takes the GPU
 * benchmark and runs real work only as "ollama-local" (worker-runner.ts); "edgecoder-local" is the
 * stub that echoes the task. Installers before this fix wrote "edgecoder-local" for every instance,
 * so a fresh GPU host advertised no models (found on the Lambda A100, Nov 2026).
 */

const A100 = "0, NVIDIA A100-SXM4-80GB, 81920\n";
const gpuHw = detectHardware({ probe: (cmd) => (cmd === "nvidia-smi" ? A100 : null), platform: "linux", arch: "x64", ramGb: 220, cpuModel: "EPYC", cpuCores: 30, hostname: "lambda-a100" });
const cpuHw = detectHardware({ probe: () => null, platform: "linux", arch: "x64", ramGb: 16, cpuModel: "Xeon", cpuCores: 8, hostname: "fly-cpu" });

/** What the worker does with an env file: its config schema, then the engine; PROVIDER as in worker-runner.ts. */
function workerView(inst: AgentInstance) {
  const env = parseEnvFile(renderEnvFile(inst.env));
  const W = loadConfig("worker", workerConfigSchema, env);
  const engine = resolveEngine(env);
  const provider = engine.kind === "ollama" ? W.LOCAL_MODEL_PROVIDER : "ollama-local";
  return { env, W, engine, provider, reportsModels: provider === "ollama-local", challengeKinds: provider === "ollama-local" ? ["cpu", "gpu"] : ["cpu"] };
}

describe("localModelProvider", () => {
  it("is ollama-local for an Ollama instance with a model and for vLLM / MLX; edgecoder-local only without a model", () => {
    expect(localModelProvider(undefined, "qwen3-coder:30b")).toBe("ollama-local");
    expect(localModelProvider({ kind: "ollama", env: {} }, "qwen3.5:4b")).toBe("ollama-local");
    expect(localModelProvider({ kind: "vllm", env: {} }, "qwen3-coder:30b")).toBe("ollama-local");
    expect(localModelProvider({ kind: "mlx", env: {} }, "")).toBe("ollama-local");
    expect(localModelProvider({ kind: "ollama", env: {} }, "")).toBe("edgecoder-local");
    expect(localModelProvider(undefined, undefined)).toBe("edgecoder-local");
  });
});

describe("installer env: the worker reports models", () => {
  it("GPU host on Ollama: ollama-local, so it reports its model and takes the GPU benchmark", () => {
    const plan = planInstall(gpuHw, parseInstallArgs(["apply", "--token", "tok"]), true);
    expect(plan.instances).toHaveLength(1);
    const inst = plan.instances[0];
    expect(inst.env.LOCAL_MODEL_PROVIDER).toBe("ollama-local");
    expect(inst.env.EDGECODER_ENGINE).toBeUndefined();
    const v = workerView(inst);
    expect(v.engine.kind).toBe("ollama");
    expect(v.provider).toBe("ollama-local");
    expect(v.reportsModels).toBe(true);
    expect(v.challengeKinds).toContain("gpu");
    expect(v.W.OLLAMA_MODEL).toBe(inst.model);
    expect(MODEL_CATALOG.some((m) => m.modelId === inst.model)).toBe(true);
  });

  it("every GPU of a per-GPU install is ollama-local", () => {
    const two = detectHardware({ probe: (cmd) => (cmd === "nvidia-smi" ? "0, NVIDIA L40S, 46068\n1, NVIDIA L40S, 46068\n" : null), platform: "linux", arch: "x64", ramGb: 200, cpuModel: "Xeon", cpuCores: 32, hostname: "two" });
    const plan = planInstall(two, parseInstallArgs(["apply", "--per-gpu", "--token", "tok"]), true);
    expect(plan.instances.length).toBe(2);
    for (const inst of plan.instances) expect(workerView(inst).provider).toBe("ollama-local");
  });

  it("vLLM instance: ollama-local written explicitly, and its served model resolves to a catalog tag", async () => {
    const opts = parseInstallArgs(["apply", "--token", "tok", "--vllm-profile", "a100-80"]);
    opts.instanceEngines = { 0: resolveInstanceEngine(0, { engine: "vllm", vllmProfile: "a100-80" }) };
    const inst = planInstall(gpuHw, opts, true).instances[0];
    expect(inst.env.EDGECODER_ENGINE).toBe("vllm");
    expect(inst.env.LOCAL_MODEL_PROVIDER).toBe("ollama-local");
    const v = workerView(inst);
    expect(v.engine.kind).toBe("vllm");
    expect(v.provider).toBe("ollama-local");
    expect(v.env.ENGINE_MODEL_ALIASES).toBeUndefined();
    // vLLM serves the repo id (install-vllm.sh passes no --served-model-name): the agent maps it.
    const server = createServer((req, res) => {
      if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: VLLM_PROFILES["a100-80"].model, max_model_len: 65536 }] }));
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      if (v.engine.kind === "ollama") throw new Error("expected vllm");
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const status = await probeEngine({ ...v.engine, url }, parseModelAliases(v.W.ENGINE_MODEL_ALIASES));
      expect(status.problem).toBeUndefined();
      expect(status.ok).toBe(true);
      expect(status.model?.id).toBe(v.engine.model);
      expect(status.model?.tag).toBe("qwen3-coder:30b");
    } finally {
      server.close();
    }
  });

  it("CPU-only host: it still runs a model on its own Ollama, so ollama-local", () => {
    const plan = planInstall(cpuHw, parseInstallArgs(["apply", "--token", "tok"]), true);
    const inst = plan.instances[0];
    expect(inst.agentId).toBe("fly-cpu-cpu");
    expect(inst.gpu).toBeUndefined();
    expect(inst.model).toBeTruthy();
    const v = workerView(inst);
    expect(v.provider).toBe("ollama-local");
    expect(v.reportsModels).toBe(true);
  });
});

describe("vLLM profiles", () => {
  it("every profile's model resolves to a catalog tag without ENGINE_MODEL_ALIASES", () => {
    for (const [name, p] of Object.entries(VLLM_PROFILES)) {
      const tag = catalogTagForEngineModel(p.model);
      expect(tag, `${name}: ${p.model}`).toBeDefined();
      expect(MODEL_CATALOG.some((m) => m.modelId === tag), `${name}: ${tag} in the catalog`).toBe(true);
      expect(tag).toBe("qwen3-coder:30b");
    }
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPeerKeys } from "../../../src/mesh/peer.js";
import { ModelControlAgent, type CurrentModelSettings } from "../../../src/model/remote-control/agent-controller.js";
import { createOllamaAdmin } from "../../../src/model/remote-control/ollama-admin.js";
import { loadOverrides, layerOverrides, overridesPath } from "../../../src/model/remote-control/overrides.js";
import { resolveAllowlist } from "../../../src/model/remote-control/policy.js";
import { createModelControlFrame, type ModelControlRequest } from "../../../src/model/remote-control/protocol.js";
import { startFakeOllama, type FakeOllama } from "./fake-ollama.js";

/*
 * The agent side against a fake Ollama: signed commands are carried out within the host's policy,
 * settings persist to the agent's own override file, and every result is reported.
 */
const coord = createPeerKeys("coord-ac");
const pinned = { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem };
const GB = 1e9;

let ollama: FakeOllama;
let reports: any[];
let applied: any[];
let settings: CurrentModelSettings;
let configDir: string;

function agent(opts: { enabled?: boolean; allowlist?: string; diskFree?: number; ramBytes?: number; vramBytes?: number; env?: Record<string, string> } = {}) {
  const env = opts.env ?? { model: "qwen3.5:9b", contextWindow: "16384" };
  return new ModelControlAgent({
    agentId: "agent-ac",
    enabled: opts.enabled ?? true,
    allowlist: resolveAllowlist(opts.allowlist),
    ollama: createOllamaAdmin(ollama.url),
    overridesFile: overridesPath(configDir),
    env,
    overrides: { version: 1 },
    current: () => settings,
    apply: async (change) => {
      applied.push(change);
      const layered = layerOverrides(env, loadOverrides(overridesPath(configDir)).overrides).env;
      settings = { ...settings, model: layered.model ?? settings.model, contextWindow: Number(layered.contextWindow ?? settings.contextWindow), parallel: Number(layered.parallel ?? settings.parallel), keepAlive: layered.keepAlive ?? settings.keepAlive };
    },
    hardware: { ramBytes: opts.ramBytes ?? 64 * GB, vramBytes: opts.vramBytes },
    modelsDir: configDir,
    diskSpace: () => ({ freeBytes: opts.diskFree ?? 500 * GB, totalBytes: 1000 * GB }),
    sizeOf: async (m) => (m === "someone/tuned:q4" ? 3 * GB : undefined),
    report: async (body) => {
      reports.push(JSON.parse(JSON.stringify(body)));
    }
  });
}
const send = (a: ModelControlAgent, request: ModelControlRequest, extra: { agentId?: string } = {}) =>
  a.handleFrame(createModelControlFrame({ request, agentId: extra.agentId ?? "agent-ac", coordinatorId: coord.peerId, requestedBy: "acct-owner", privateKeyPem: coord.privateKeyPem }), pinned);

beforeEach(async () => {
  ollama = await startFakeOllama({ "qwen3.5:9b": 6.6 * GB, "qwen2.5-coder:7b": 4.7 * GB });
  reports = [];
  applied = [];
  configDir = mkdtempSync(join(tmpdir(), "ec-ac-"));
  settings = { model: "qwen3.5:9b", contextWindow: 16384, parallel: 2, keepAlive: "30m", sources: { model: "env", contextWindow: "env", parallel: "default", keepAlive: "default" } };
});
afterEach(async () => ollama.close());

describe("agent model control", () => {
  it("pulls an allowlisted model with progress and reports the result and new state", async () => {
    ollama.pullSizes.set("qwen3.5:4b", 3.4 * GB);
    const r = await send(agent(), { action: "pull", args: { model: "qwen3.5:4b" } });
    expect(r.status).toBe("done");
    expect(ollama.models.has("qwen3.5:4b")).toBe(true);
    const results = reports.filter((x) => x.result).map((x) => x.result.status);
    expect(results[0]).toBe("accepted");
    expect(results.at(-1)).toBe("done");
    const final = reports.at(-1);
    expect(final.state.installed.map((m: any) => m.name)).toContain("qwen3.5:4b");
    expect(final.state.ollamaVersion).toBe("0.40.7");
  });

  it("refuses a model outside the allowlist, and an operator allowlist locks it down", async () => {
    expect((await send(agent(), { action: "pull", args: { model: "someone/other:latest" } })).error).toBe("model_not_allowlisted");
    expect((await send(agent({ allowlist: "qwen2.5-coder:7b" }), { action: "pull", args: { model: "qwen3.5:4b" } })).error).toBe("model_not_allowlisted");
    // An operator-added model the catalog does not size is sized from its registry manifest.
    expect((await send(agent({ allowlist: "catalog,someone/tuned:q4" }), { action: "pull", args: { model: "someone/tuned:q4" } })).status).toBe("done");
    expect(ollama.calls.filter((c) => c.path === "/api/pull").map((c) => c.body.model)).toEqual(["someone/tuned:q4"]);
  });

  it("refuses pulls that do not fit the disk or the memory", async () => {
    expect((await send(agent({ diskFree: 10 * GB }), { action: "pull", args: { model: "qwen3-coder:30b" } })).error).toBe("insufficient_disk");
    expect((await send(agent({ ramBytes: 16 * GB }), { action: "pull", args: { model: "llama3.3:70b" } })).error).toBe("insufficient_memory");
    expect(ollama.calls.some((c) => c.path === "/api/pull")).toBe(false);
  });

  it("does nothing with AGENT_REMOTE_CONTROL=off but still reports its state (view only)", async () => {
    const a = agent({ enabled: false });
    expect((await send(a, { action: "pull", args: { model: "qwen3.5:4b" } })).error).toBe("remote_control_off");
    expect((await send(a, { action: "remove", args: { model: "qwen2.5-coder:7b" } })).error).toBe("remote_control_off");
    expect((await send(a, { action: "refresh", args: {} })).status).toBe("done");
    expect(reports.at(-1).state.remoteControl).toBe("off");
    expect(a.orchestrationRefusal("qwen3.5:4b")).toBe("remote_control_off");
    expect(ollama.models.size).toBe(2);
  });

  it("selects an installed model, persists it in the override file and applies it", async () => {
    const a = agent();
    expect((await send(a, { action: "set_model", args: { model: "qwen3.5:0.8b" } })).error).toBe("model_not_installed");
    expect((await send(a, { action: "set_model", args: { model: "qwen2.5-coder:7b" } })).status).toBe("done");
    expect(settings.model).toBe("qwen2.5-coder:7b");
    const file = loadOverrides(overridesPath(configDir)).overrides;
    expect(file.model).toMatchObject({ value: "qwen2.5-coder:7b", baseline: "qwen3.5:9b", updatedBy: "acct-owner" });
  });

  it("removes a model but never the one in use", async () => {
    const a = agent();
    expect((await send(a, { action: "remove", args: { model: "qwen3.5:9b" } })).error).toBe("model_in_use");
    // Loaded (in use on the machine, e.g. by the desktop app's chat): the local user decides.
    ollama.loaded.add("qwen2.5-coder:7b");
    expect((await send(a, { action: "remove", args: { model: "qwen2.5-coder:7b" } })).error).toBe("model_loaded");
    ollama.loaded.clear();
    expect((await send(a, { action: "remove", args: { model: "qwen2.5-coder:7b" } })).status).toBe("done");
    expect(ollama.models.has("qwen2.5-coder:7b")).toBe(false);
  });

  it("changes settings within bounds, persisted without touching the env file", async () => {
    const a = agent();
    expect((await send(a, { action: "set_settings", args: { contextWindow: 999_999 } })).error).toBe("context_window_out_of_bounds");
    expect((await send(a, { action: "set_settings", args: { parallel: 12 } })).error).toBe("parallel_out_of_bounds");
    const ok = await send(a, { action: "set_settings", args: { contextWindow: 32768, parallel: 3, keepAlive: "-1" } });
    expect(ok.status).toBe("done");
    expect(settings).toMatchObject({ contextWindow: 32768, parallel: 3, keepAlive: "-1" });
    const file = loadOverrides(overridesPath(configDir)).overrides;
    expect(file.contextWindow).toMatchObject({ value: 32768, baseline: "16384" });
    expect(file.parallel).toMatchObject({ value: 3, baseline: "" });
  });

  it("reloads the model (unload, then apply)", async () => {
    ollama.loaded.add("qwen3.5:9b");
    expect((await send(agent(), { action: "restart_model", args: {} })).status).toBe("done");
    expect(ollama.calls.some((c) => c.path === "/api/generate" && c.body.keep_alive === 0 && c.body.model === "qwen3.5:9b")).toBe(true);
    expect(applied).toEqual([{}]);
  });

  it("ignores a command for another agent or from another key, without reporting", async () => {
    const a = agent();
    expect((await send(a, { action: "remove", args: { model: "qwen2.5-coder:7b" } }, { agentId: "someone-else" })).error).toBe("wrong_agent");
    const evil = createPeerKeys("coord-evil");
    const forged = createModelControlFrame({ request: { action: "remove", args: { model: "qwen2.5-coder:7b" } }, agentId: "agent-ac", coordinatorId: coord.peerId, requestedBy: "acct-owner", privateKeyPem: evil.privateKeyPem });
    expect((await a.handleFrame(forged, pinned)).error).toBe("invalid_signature");
    expect(reports).toEqual([]);
    expect(ollama.models.has("qwen2.5-coder:7b")).toBe(true);
  });
});

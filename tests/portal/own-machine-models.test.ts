import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { machineMemory, ownMachineModels } from "../../src/portal/routes/machines.js";
import { modelShareNote } from "../../src/portal/pages/settings-machines.js";
import { computeOptions } from "../../src/portal/routes/compute.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function coordinator(machines: unknown[]) {
  const co = Fastify();
  const seen: unknown[] = [];
  co.post("/agent-control/machines", async (req) => (seen.push(req.body), { machines }));
  await co.listen({ port: 0, host: "127.0.0.1" });
  servers.push(co);
  return { url: `http://127.0.0.1:${(co.server.address() as { port: number }).port}`, seen };
}

const state = (activeModel: string, loaded: string[] = [], extra: Record<string, unknown> = {}) => ({ ollamaReachable: true, activeModel, installed: [{ name: activeModel }, ...loaded.map((name) => ({ name }))], loaded: loaded.map((name) => ({ name })), ...extra });

describe("ownMachineModels (web chat Auto asks your own machines first)", () => {
  it("lists loaded models first, then active ones, from connected machines only", async () => {
    const co = await coordinator([
      { agentId: "studio", connected: true, state: state("qwen3.5:9b", ["qwen3-coder:30b"]) },
      { agentId: "mbp", connected: true, state: state("qwen3.5:9b") },
      { agentId: "old", connected: false, state: state("llama3:8b") },
      { agentId: "down", connected: true, state: state("gemma:2b", [], { ollamaReachable: false }) },
    ]);
    const store = { listNodesByOwner: async () => ["studio", "mbp", "old", "down"].map((nodeId) => ({ nodeId, nodeKind: "agent" })) };
    const models = await ownMachineModels({ PORTAL_SERVICE_TOKEN: "svc", EXTERNAL_HTTP_TIMEOUT_MS: 5_000, discoverCoordinatorUrlsForPortal: async () => [co.url], store }, "u1");
    // An Ollama-less host's active model comes last (an older coordinator does not say what it serves).
    expect(models).toEqual(["qwen3-coder:30b", "qwen3.5:9b", "gemma:2b"]);
    expect(co.seen[0]).toEqual({ accountId: "acct-u1", agentIds: ["studio", "mbp", "old", "down"] });
  });

  it("offers a vLLM host's model: Ollama unreachable, nothing installed, but its active model is served", async () => {
    // The Lambda A100 (2026-11-17): Auto went to the paid network because this machine was skipped.
    const co = await coordinator([
      { agentId: "lambda-a100-gpu0", connected: true, state: { ollamaReachable: false, activeModel: "qwen3-coder:30b", installed: [], loaded: [] } },
    ]);
    const store = { listNodesByOwner: async () => [{ nodeId: "lambda-a100-gpu0", nodeKind: "agent" }] };
    expect(await ownMachineModels({ PORTAL_SERVICE_TOKEN: "svc", EXTERNAL_HTTP_TIMEOUT_MS: 5_000, discoverCoordinatorUrlsForPortal: async () => [co.url], store }, "u1")).toEqual(["qwen3-coder:30b"]);
  });

  it("uses the coordinator's routable models when it lists them (what a `mine` call can run there)", async () => {
    const co = await coordinator([
      // vLLM: the state says nothing useful; models says what it serves.
      { agentId: "a100", connected: true, activeModel: "qwen3-coder:30b", models: ["qwen3-coder:30b"], state: { ollamaReachable: false, activeModel: "qwen3-coder:30b", installed: [], loaded: [] } },
      // Ollama: warm first, then active, then the rest; a model in the state but not routable is left out.
      { agentId: "mac", connected: true, activeModel: "qwen3.5:9b", models: ["qwen3.5:9b", "qwen3.5:4b"], state: state("qwen3.5:9b", ["qwen3.5:4b", "not-reported:1b"]) },
      { agentId: "gone", connected: false, models: ["llama3:8b"], state: null },
    ]);
    const store = { listNodesByOwner: async () => ["a100", "mac", "gone"].map((nodeId) => ({ nodeId, nodeKind: "agent" })) };
    expect(await ownMachineModels({ PORTAL_SERVICE_TOKEN: "svc", EXTERNAL_HTTP_TIMEOUT_MS: 5_000, discoverCoordinatorUrlsForPortal: async () => [co.url], store }, "u1")).toEqual(["qwen3.5:4b", "qwen3-coder:30b", "qwen3.5:9b"]);
  });

  it("includes the models a machine runs only for you (kept off the network: too big to share there)", async () => {
    // The 8 GB laptop (2026-11-17): its budget serves qwen3.5:4b; qwen3.5:9b is installed and active, for its owner only.
    const co = await coordinator([
      { agentId: "nvidia-1-gpu", connected: true, activeModel: "qwen3.5:4b", models: ["qwen3.5:4b"], networkModels: ["qwen3.5:4b"], ownerModels: ["qwen3.5:9b"], state: state("qwen3.5:9b", ["qwen3.5:4b"]) },
    ]);
    const store = { listNodesByOwner: async () => [{ nodeId: "nvidia-1-gpu", nodeKind: "agent" }] };
    expect(await ownMachineModels({ PORTAL_SERVICE_TOKEN: "svc", EXTERNAL_HTTP_TIMEOUT_MS: 5_000, discoverCoordinatorUrlsForPortal: async () => [co.url], store }, "u1")).toEqual(["qwen3.5:4b", "qwen3.5:9b"]);
  });

  it("asks nobody when the account has no machines", async () => {
    const co = await coordinator([]);
    const store = { listNodesByOwner: async () => [] };
    expect(await ownMachineModels({ PORTAL_SERVICE_TOKEN: "", EXTERNAL_HTTP_TIMEOUT_MS: 5_000, discoverCoordinatorUrlsForPortal: async () => [co.url], store }, "u1")).toEqual([]);
    expect(co.seen).toHaveLength(0);
  });
});

describe("Your machines' models: a model that runs for you only", () => {
  const GB = 1024 ** 3;
  const machine = { networkModels: ["qwen3.5:4b"], ownerModels: ["qwen3.5:9b", "qwen2.5-coder:1.5b"], memory: { budgetBytes: 5 * GB, models: [{ name: "qwen3.5:9b", bytes: 8.2 * GB }, { name: "qwen2.5-coder:1.5b", bytes: 1.5 * GB }, { name: "qwen3.5:4b", bytes: 4 * GB }] } };

  it("says why, with the agent's numbers when it reports them", () => {
    expect(modelShareNote("qwen3.5:9b", machine)).toBe("Runs for you only: too big to share on the network from this machine (needs ~8.2 GB; budget 5 GB)");
    expect(modelShareNote("qwen3.5:9b", { networkModels: ["qwen3.5:4b"], ownerModels: ["qwen3.5:9b"] })).toBe("Runs for you only: too big to share on the network from this machine");
    expect(modelShareNote("qwen2.5-coder:1.5b", machine)).toMatch(/^Runs for you only: this machine shares as many models/);
    // Served on the network, or a coordinator that does not say: no note.
    expect(modelShareNote("qwen3.5:4b", machine)).toBe("");
    expect(modelShareNote("qwen3.5:9b", {})).toBe("");
    // An older agent: kept off the network and not offered to its owner either.
    expect(modelShareNote("qwen3.5:9b", { networkModels: ["qwen3.5:4b"], ownerModels: [] })).toBe("Not shared on the network from this machine. Update its agent to run it for you only.");
  });

  it("the page script carries the note function", async () => {
    const { machinesPageScript } = await import("../../src/portal/pages/settings-machines.js");
    const script = machinesPageScript();
    expect(script).toContain("function modelShareNote(");
    expect(script).toContain("modelShareNote(im.name, m)");
    // It parses as browser JavaScript (no TypeScript left in it).
    expect(() => new Function("escapeHtml", "statusBadge", "api", "showToast", "document", "window", script)).not.toThrow();
  });

  it("machineMemory keeps only well-formed numbers", () => {
    expect(machineMemory({ budgetBytes: 5, ownerModels: [{ name: "a", bytes: 9 }, { name: 3 }], models: [{ name: "b", bytes: 2 }] })).toEqual({ budgetBytes: 5, models: [{ name: "a", bytes: 9 }, { name: "b", bytes: 2 }] });
    expect(machineMemory({ budgetBytes: "x" })).toBeUndefined();
    expect(machineMemory(undefined)).toBeUndefined();
  });

  it("the compute picker lists your machines' own models the network does not", () => {
    const opts = computeOptions([{ model: "qwen3.5:4b", agents: 3, classes: ["gpu"] }], {}, [], Date.now(), ["qwen3.5:4b", "qwen3.5:9b"]);
    const mine = opts.filter((o) => o.group === "mine").map((o) => [o.compute.model, o.detail]);
    expect(mine).toEqual([["qwen3.5:4b", "Free · runs only on your own machines"], ["qwen3.5:9b", "Free · on your machine only (not shared on the network)"]]);
  });
});

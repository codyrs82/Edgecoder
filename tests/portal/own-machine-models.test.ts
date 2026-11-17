import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ownMachineModels } from "../../src/portal/routes/machines.js";

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
    expect(models).toEqual(["qwen3-coder:30b", "qwen3.5:9b"]);
    expect(co.seen[0]).toEqual({ accountId: "acct-u1", agentIds: ["studio", "mbp", "old", "down"] });
  });

  it("asks nobody when the account has no machines", async () => {
    const co = await coordinator([]);
    const store = { listNodesByOwner: async () => [] };
    expect(await ownMachineModels({ PORTAL_SERVICE_TOKEN: "", EXTERNAL_HTTP_TIMEOUT_MS: 5_000, discoverCoordinatorUrlsForPortal: async () => [co.url], store }, "u1")).toEqual([]);
    expect(co.seen).toHaveLength(0);
  });
});

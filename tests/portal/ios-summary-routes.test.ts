import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAccountApiRoutes } from "../../src/portal/routes/account.js";

/**
 * The iPhone hosts only over Bluetooth and does not earn or pay out: /ios/dashboard and
 * /ios/agents/:agentId/contribution return account and network info only, never contribution,
 * earnings or wallet figures. Both still answer (no 404) for older app builds.
 */
describe("iOS summary routes", () => {
  const user = { userId: "u1", email: "u1@x.io", emailVerified: true };
  const nodes = [{ nodeId: "phone-abc123", nodeKind: "agent", ownerUserId: "u1", active: true, nodeApproved: true, lastSeenMs: 1 }];
  const store = {
    listNodesByOwner: async (userId: string) => nodes.filter((n) => n.ownerUserId === userId),
    getNodeEnrollment: async (id: string) => nodes.find((n) => n.nodeId === id) ?? null
  };
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    registerAccountApiRoutes(app, {
      store,
      getCurrentUser: async () => user,
      loadIosNetworkSummary: async () => ({ capacity: { totals: { totalCapacity: 3, agentsConnected: 2 } } }),
      loadIosAgentRuntime: async () => ({ runtime: { connected: true, mode: "swarm-only" } }),
      // Would leak earnings if a route still read it.
      loadWalletSnapshotForUser: async () => ({ creditHistory: [{ type: "earn", reason: "compute_contribution", credits: 5, relatedTaskId: "t1" }] })
    } as never);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("/ios/dashboard returns the user, nodes and network summary only", async () => {
    const res = await app.inject({ method: "GET", url: "/ios/dashboard" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["networkSummary", "nodes", "user"]);
    expect(body.user.userId).toBe("u1");
    expect(body.nodes[0].nodeId).toBe("phone-abc123");
    expect(body.networkSummary.capacity.totals.agentsConnected).toBe(2);
  });

  it("/ios/agents/:agentId/contribution returns node and runtime state, no earnings", async () => {
    const res = await app.inject({ method: "GET", url: "/ios/agents/phone-abc123/contribution" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["agentId", "node", "runtime"]);
    expect(body.runtime).toEqual({ connected: true, mode: "swarm-only" });
    expect(JSON.stringify(body)).not.toMatch(/earned|credits|balance|sats/i);
  });
});

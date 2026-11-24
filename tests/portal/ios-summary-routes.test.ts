import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAccountApiRoutes } from "../../src/portal/routes/account.js";

/**
 * The iPhone does not show what hosting earned: /ios/dashboard and /ios/agents/:agentId/contribution
 * return account, node, job-count and network/runtime info, never earnings, balance or payout
 * figures. Both still answer (no 404) for older app builds.
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
      loadIosAgentActivity: async () => ({ contribution: { contributedTaskCount: 2 }, runtime: { connected: true, mode: "swarm-only" }, recentTaskIds: ["t2", "t1"] }),
      // Earnings in the history must not reach the response; only the job count does.
      loadWalletSnapshotForUser: async () => ({
        credits: { balance: 42 },
        quote: { estimatedSats: 4200 },
        creditHistory: [
          { type: "earn", reason: "compute_contribution", credits: 5, relatedTaskId: "t1" },
          { type: "earn", reason: "compute_contribution", credits: 3, relatedTaskId: "t2" }
        ]
      })
    } as never);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("/ios/dashboard returns the user, nodes, job count and network summary, no earnings", async () => {
    const res = await app.inject({ method: "GET", url: "/ios/dashboard" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["contribution", "networkSummary", "nodes", "user"]);
    expect(body.contribution).toEqual({ contributedTaskCount: 2 });
    expect(JSON.stringify(body)).not.toMatch(/earned|credits|balance|sats|walletSnapshot/i);
    expect(body.user.userId).toBe("u1");
    expect(body.nodes[0].nodeId).toBe("phone-abc123");
    expect(body.networkSummary.capacity.totals.agentsConnected).toBe(2);
  });

  it("/ios/agents/:agentId/contribution returns node, job count and runtime state, no earnings", async () => {
    const res = await app.inject({ method: "GET", url: "/ios/agents/phone-abc123/contribution" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["agentId", "contribution", "node", "recentTaskIds", "runtime"]);
    expect(body.contribution).toEqual({ contributedTaskCount: 2 });
    expect(body.runtime).toEqual({ connected: true, mode: "swarm-only" });
    expect(JSON.stringify(body)).not.toMatch(/earned|credits|balance|sats/i);
  });
});

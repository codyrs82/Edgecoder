import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/*
 * The order book reports both fees (read-only) so the Wallet screens can show what a purchase and
 * a compute payment keep back: purchaseFeeBps (COORDINATOR_FEE_BPS) and networkFeeBps
 * (NETWORK_FEE_BPS). docs/economy-math.md sections 1 and 2. Set explicitly here so the test pins
 * the wiring, not a default the owner may change.
 */
const MESH = "mesh-secret-market-book";

describe("coordinator /economy/market/book fees", () => {
  let app: any;
  beforeAll(async () => {
    vi.resetModules();
    process.env.MESH_AUTH_TOKEN = MESH;
    process.env.COORDINATOR_FEE_BPS = "0";
    process.env.NETWORK_FEE_BPS = "500";
    const { coordinatorServer } = await import("../../src/swarm/coordinator.js");
    await coordinatorServer.ready();
    app = coordinatorServer;
  }, 60_000);
  afterAll(async () => {
    delete process.env.COORDINATOR_FEE_BPS;
    delete process.env.NETWORK_FEE_BPS;
    await app?.close();
  });

  test("states the purchase fee and the network fee", async () => {
    const res = await app.inject({ method: "GET", url: "/economy/market/book", headers: { "x-mesh-token": MESH } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ purchaseFeeBps: 0, networkFeeBps: 500 });
  });
});

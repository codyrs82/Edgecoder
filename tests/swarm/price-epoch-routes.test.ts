import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { publicKeyFingerprint } from "../../src/mesh/peer-trust.js";

/*
 * #53 (real coordinator app, Fastify inject): the legacy price epoch is bounded and a lone
 * coordinator cannot run a price consensus without a quorum of allowlisted signers.
 */

const MESH = "mesh-secret-price";
const ADMIN = "admin-secret-price";
const peerKey = createPeerKeys("coord-price-peer");
let app: any;

beforeAll(async () => {
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.ADMIN_API_TOKEN = ADMIN;
  process.env.MESH_PEER_ALLOWLIST = `coord-price-peer:${publicKeyFingerprint(peerKey.publicKeyPem)}@https://peer.invalid`;
  delete process.env.APPROVED_COORDINATOR_IDS;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.MESH_PEER_ALLOWLIST;
});

const admin = { "content-type": "application/json", "x-admin-token": ADMIN, "x-mesh-token": MESH };
const current = async () => (await app.inject({ method: "GET", url: "/economy/price/current", headers: { "x-mesh-token": MESH } })).json();

describe("price epoch guard (#53)", () => {
  test("a proposal that jumps past the max step is rejected and changes nothing", async () => {
    const before = await current();
    const res = await app.inject({
      method: "POST",
      url: "/economy/price/propose",
      headers: admin,
      payload: { coordinatorId: "local", cpuCapacity: 1, gpuCapacity: 1, queuedTasks: 10_000, activeAgents: 0 }
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "price_out_of_bounds", reason: "change_too_large" });
    expect(await current()).toEqual(before);
  });

  test("an in-bounds proposal is accepted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/economy/price/propose",
      headers: admin,
      payload: { coordinatorId: "local", cpuCapacity: 10, gpuCapacity: 10, queuedTasks: 10, activeAgents: 0 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().epochs.map((e: any) => e.pricePerComputeUnitSats)).toEqual([30, 120]);
  });

  test("consensus without a quorum of allowlisted signers does not set a price", async () => {
    const before = await current();
    const res = await app.inject({
      method: "POST",
      url: "/economy/price/consensus",
      headers: admin,
      payload: { cpuCapacity: 10, gpuCapacity: 10, queuedTasks: 12, activeAgents: 0 }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "price_quorum_not_met", outcome: { quorum: 2 } });
    expect(await current()).toEqual(before);
  });

  test("quotes are signed over their inputs and time", async () => {
    const res = await app.inject({ method: "GET", url: "/economy/price/quote?resourceClass=cpu&cpuCapacity=4&queuedTasks=4", headers: { "x-mesh-token": MESH } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.issuedAtMs).toBe("number");
    expect(typeof body.signature).toBe("string");
  });
});

import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { loadRegistrySigningKey, signRegistry, type RegistryEntry, type RegistryMemberStatus } from "../../src/discovery/registry.js";
import { publicKeyFingerprint, signPeerRequest } from "../../src/mesh/peer-trust.js";

/*
 * A coordinator trusts the signed registry's members as peers (real coordinator app): with a
 * pinned registry key (EDGECODER_REGISTRY_PUBLIC_KEYS) and its mirror pointed at a stand-in
 * portal, a community member on probation may make signed peer requests and is labelled in
 * /network/world; a suspended one may not; registry-only peers get no subtask grants.
 */

const MESH = "mesh-secret-registry-trust";
const REMOTE = "203.0.113.71";
const signing = loadRegistrySigningKey(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
const ALLOWED = createPeerKeys("coord-reg-allowlisted");
const PROBATION = createPeerKeys("coord-reg-probation");
const SUSPENDED = createPeerKeys("coord-reg-suspended");
let portal: Server;
let app: any;
let ctx: typeof import("../../src/swarm/coordinator/context.js");
let grants: typeof import("../../src/swarm/coordinator/grants.js");
const SELF = createPeerKeys("coord-reg-self");

function entry(keys: { peerId: string; publicKeyPem: string }, kind: "edgecoder" | "community", status: RegistryMemberStatus, url: string): RegistryEntry {
  return {
    peerId: keys.peerId,
    publicKeyFingerprint: publicKeyFingerprint(keys.publicKeyPem),
    urls: [url],
    region: "us",
    operator: { id: kind === "edgecoder" ? "edgecoder" : "op", name: "", kind },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: 1,
    health: { status: "healthy", checkedAtMs: Date.now(), latencyMs: 5 },
    status
  };
}

beforeAll(async () => {
  portal = createServer((req, res) => {
    const now = Date.now();
    const coordinators = [entry(PROBATION, "community", "probation", "https://probation.invalid"), entry(SUSPENDED, "community", "suspended", "https://suspended.invalid")];
    coordinators.unshift(entry(SELF, "edgecoder", "active", "https://self.invalid"));
    const doc = signRegistry({ v: 1, network: "edgecoder", issuedAtMs: now, expiresAtMs: now + 15 * 60_000, coordinators, fallbackUrls: [] }, signing);
    res.writeHead(req.url === "/network/registry" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(doc));
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  const portalUrl = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    MESH_AUTH_TOKEN: MESH,
    MESH_TOKEN_REQUIRED_FOR_PEERS: "false",
    MESH_PEER_ALLOWLIST: `${ALLOWED.peerId}:${publicKeyFingerprint(ALLOWED.publicKeyPem)}@https://allowed.invalid`,
    EDGECODER_REGISTRY_PUBLIC_KEYS: signing.publicKeyPem,
    REGISTRY_UPSTREAM_URL: `${portalUrl}/network/registry`,
    COORDINATOR_PEER_ID: SELF.peerId,
    COORDINATOR_PRIVATE_KEY_PEM: SELF.privateKeyPem
  });
  delete process.env.DATABASE_URL;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.COORDINATOR_BOOTSTRAP_URLS;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ctx = await import("../../src/swarm/coordinator/context.js");
  grants = await import("../../src/swarm/coordinator/grants.js");
  await app.ready();
  expect(ctx.identity.peerId).toBe(SELF.peerId);
  expect(await ctx.registryTrust.refresh()).toBe(true);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  for (const k of ["MESH_PEER_ALLOWLIST", "MESH_TOKEN_REQUIRED_FOR_PEERS", "EDGECODER_REGISTRY_PUBLIC_KEYS", "REGISTRY_UPSTREAM_URL", "COORDINATOR_PEER_ID", "COORDINATOR_PRIVATE_KEY_PEM"]) delete process.env[k];
});

function signedGet(keys: PeerKeys, url: string) {
  const sig = signPeerRequest({ peerId: keys.peerId, privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem, method: "GET", url });
  return app.inject({ method: "GET", url, remoteAddress: REMOTE, headers: sig });
}

describe("peer trust through the signed registry", () => {
  test("trust = allowlist ∪ registry members on probation or active", () => {
    expect(ctx.registryTrust.enabled).toBe(true);
    expect(ctx.trustedPeerKey(PROBATION.peerId, PROBATION.publicKeyPem)).toBe(true);
    expect(ctx.trustedPeerKey(ALLOWED.peerId, ALLOWED.publicKeyPem)).toBe(true);
    expect(ctx.trustedPeerKey(SUSPENDED.peerId, SUSPENDED.publicKeyPem)).toBe(false);
    expect(ctx.trustedPeerKey(PROBATION.peerId, SUSPENDED.publicKeyPem)).toBe(false);
  });

  test("a probation member's signed peer request passes without the mesh token; a suspended one's does not", async () => {
    expect((await signedGet(PROBATION, "/network/world/local")).statusCode).toBe(200);
    expect((await signedGet(SUSPENDED, "/network/world/local")).statusCode).toBe(401);
  });

  test("the coordinator serves the registry it verified", async () => {
    const res = await app.inject({ method: "GET", url: "/network/registry", remoteAddress: REMOTE });
    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe("edgecoder-registry/1");
  });

  test("/network/world labels coordinators with their registry status", async () => {
    const res = await app.inject({ method: "GET", url: "/network/world", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    expect(res.statusCode).toBe(200);
    const coords = res.json().coordinators as Array<{ id: string; registryStatus?: string; self: boolean }>;
    expect(coords.find((c) => c.self)?.registryStatus).toBe("platform");
    // the probation member is pinned at its registry URL and listed (not reachable from here)
    expect(coords.find((c) => c.id === PROBATION.peerId)?.registryStatus).toBe("probation");
    expect(coords.some((c) => c.id === SUSPENDED.peerId)).toBe(false);
  });

  test("a registry-only peer gets no subtask grant (no billed work); an allowlisted one is not refused for that", () => {
    expect(grants.grantSubtaskToPeer("subtask-none", PROBATION.peerId)).toEqual({ granted: false, reason: "peer_not_billable" });
    expect(grants.grantSubtaskToPeer("subtask-none", ALLOWED.peerId)).toEqual({ granted: false, reason: "not_offered" });
  });
});

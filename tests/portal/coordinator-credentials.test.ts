import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import Fastify from "fastify";
import { createInternalAuth } from "../../src/portal/internal-auth.js";
import { registerInternalRoutes } from "../../src/portal/routes/internal.js";
import { MemoryCoordinatorCredentialStore, scopeForRoute, type RegistryMemberView } from "../../src/portal/coordinator-credentials.js";
import { signCoordinatorPortalRequest } from "../../src/security/service-request-signing.js";
import { publicKeyFingerprint } from "../../src/security/key-fingerprint.js";

/*
 * Per-coordinator portal credentials on the real /internal routes:
 * - a coordinator signs with its own key; enrolment (registration token) or the registry binds it,
 * - scopes: validate (agents registering to it), lookup of its own nodes, stats; nothing else,
 * - revocation: registry suspension, admin revoke; a revoked coordinator cannot bind a new key,
 * - replayed signatures are refused,
 * - PORTAL_COORDINATOR_TOKEN keeps working behind its flag, with a deprecation warning.
 */

const SERVICE = "svc-token";
const COORD = "coord-token";
const ADMIN = "admin";
const PORTAL = "https://edgecoder.io";

function keypair() {
  const k = generateKeyPairSync("ed25519");
  return { priv: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: k.publicKey.export({ type: "spki", format: "pem" }).toString() };
}

type Node = Record<string, any>;

function buildPortal(opts: { acceptCoordinatorToken?: boolean; registry?: Map<string, RegistryMemberView> } = {}) {
  const store = new MemoryCoordinatorCredentialStore();
  const registry = opts.registry ?? new Map<string, RegistryMemberView>();
  const warn = vi.fn();
  const nodes = new Map<string, Node>();
  const add = (n: Node) => nodes.set(n.nodeId, { emailVerified: true, nodeApproved: true, active: true, ownerEmail: `${n.nodeId}@x.io`, ownerUserId: `owner-${n.nodeId}`, lastIp: "198.51.100.9", lastCountryCode: "DE", ...n });
  add({ nodeId: "coord-a", nodeKind: "coordinator", registrationTokenHash: "h(coord-a-registration)" });
  add({ nodeId: "coord-b", nodeKind: "coordinator", registrationTokenHash: "h(coord-b-registration)" });
  add({ nodeId: "agent-1", nodeKind: "agent", registrationTokenHash: "h(agent-1-registration)" });
  add({ nodeId: "agent-2", nodeKind: "agent", registrationTokenHash: "h(agent-2-registration)", lastValidatedByCoordinator: "coord-b" });
  const portalStore = {
    getNodeEnrollment: async (id: string) => (nodes.has(id) ? { ...nodes.get(id) } : null),
    getNodeEnrollmentByDeviceId: async () => null,
    getNodeEnrollmentByRegistrationTokenHash: async () => null,
    listPendingNodes: async () => [],
    listCoordinatorNodeIds: async () => ["coord-a", "coord-b"],
    updateNodeDns: async () => undefined,
    getStatsCounts: async () => ({ users: { total: 1, verified: 1 }, nodes: { total: 4 } }),
    touchNodeValidation: async (i: { nodeId: string; sourceIp?: string; validatedByCoordinator?: string | null }) => {
      const n = nodes.get(i.nodeId)!;
      if (i.validatedByCoordinator !== undefined) n.lastValidatedByCoordinator = i.validatedByCoordinator ?? undefined;
    }
  };
  const auth = createInternalAuth({
    serviceToken: SERVICE,
    coordinatorToken: COORD,
    acceptCoordinatorToken: opts.acceptCoordinatorToken,
    adminToken: ADMIN,
    allowOpenWhenUnset: false,
    log: { warn },
    coordinatorCredentials: {
      store,
      registryMember: (id) => registry.get(id) ?? null,
      enrolledCoordinator: async (id, token) => {
        const n = nodes.get(id);
        return n && n.nodeKind === "coordinator" && n.registrationTokenHash === `h(${token})` ? { ownerUserId: n.ownerUserId } : null;
      }
    }
  });
  const app = Fastify();
  app.register(async (internal) => {
    registerInternalRoutes(internal, {
      ...auth,
      credentialStore: store,
      store: portalStore,
      autoRequestHost: undefined,
      hostApprovedFor: async () => true,
      deleteDnsRecord: async () => undefined,
      deriveIosDeviceIdFromNodeId: () => undefined,
      resolveIpIntelligence: async () => ({ countryCode: "DE", vpnDetected: false }),
      secureCompare: (a: string, b: string) => a === b,
      sha256Hex: (v: string) => `h(${v})`
    } as any);
    // Like the payout and security-research routes: in the plugin, no coordinator scope.
    internal.get("/internal/security-research/entitlements", async () => ({ entitlements: [] }));
  });
  return { app, store, nodes, registry, warn };
}

function signed(coordinatorId: string, key: { priv: string; pub: string }, method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    ...extra,
    ...signCoordinatorPortalRequest({ coordinatorId, privateKeyPem: key.priv, publicKeyPem: key.pub, method, url: `${PORTAL}${path}`, body: payload })
  };
  return { method, url: path, headers, ...(payload !== undefined ? { payload } : {}) };
}

const enrolHeaders = (id: string) => ({ "x-coordinator-node-id": id, "x-coordinator-registration-token": `${id}-registration` });
const validateBody = (nodeId = "agent-1", nodeKind = "agent") => ({ nodeId, nodeKind, registrationToken: `${nodeId}-registration`, sourceIp: "203.0.113.5" });

describe("signed coordinator credentials", () => {
  test("enrolment binds the key once; later calls need no token or registration token", async () => {
    const { app, store, nodes } = buildPortal();
    const key = keypair();
    const first = await app.inject(signed("coord-a", key, "POST", "/internal/nodes/validate", validateBody(), enrolHeaders("coord-a")));
    expect(first.statusCode).toBe(200);
    const json = first.json();
    expect(json.allowed).toBe(true);
    expect(json.node.ownerEmail).toBeUndefined();
    expect(json.node.sourceIp).toBeUndefined();
    expect(nodes.get("agent-1")!.lastValidatedByCoordinator).toBe("coord-a");
    const rows = await store.listForCoordinator("coord-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "enrolled", publicKeyFingerprint: publicKeyFingerprint(key.pub), operatorUserId: "owner-coord-a" });

    const lookup = await app.inject(signed("coord-a", key, "POST", "/internal/nodes/lookup", { nodeIds: ["agent-1", "agent-2"] }));
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(["agent-1"]);
    expect(lookup.json().nodes[0].ownerEmail).toBeUndefined();

    const stats = await app.inject(signed("coord-a", key, "GET", "/internal/stats/counts"));
    expect(stats.statusCode).toBe(200);
  });

  test("an unenrolled key, or another coordinator's registration token, is refused", async () => {
    const { app } = buildPortal();
    const res = await app.inject(signed("coord-a", keypair(), "POST", "/internal/nodes/lookup", { nodeIds: [] }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("coordinator_not_enrolled");
    const wrong = await app.inject(signed("coord-a", keypair(), "POST", "/internal/nodes/lookup", { nodeIds: [] }, enrolHeaders("coord-b")));
    expect(wrong.statusCode).toBe(403);
    // A coordinator naming itself as another one with that one's key is just a bad signature.
    const forged = signed("coord-a", keypair(), "GET", "/internal/stats/counts");
    const res2 = await app.inject({ ...forged, headers: { ...forged.headers, "x-coord-id": "coord-b" } });
    expect(res2.statusCode).toBe(401);
  });

  test("a replayed signed request is refused", async () => {
    const { app } = buildPortal();
    const key = keypair();
    const call = signed("coord-a", key, "POST", "/internal/nodes/lookup", { nodeIds: ["agent-1"] }, enrolHeaders("coord-a"));
    expect((await app.inject(call)).statusCode).toBe(200);
    const again = await app.inject(call);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("coordinator_signature_replayed");
  });

  test("a tampered body is refused", async () => {
    const { app } = buildPortal();
    const call = signed("coord-a", keypair(), "POST", "/internal/nodes/lookup", { nodeIds: ["agent-1"] }, enrolHeaders("coord-a"));
    const res = await app.inject({ ...call, payload: JSON.stringify({ nodeIds: ["agent-2"] }) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("coordinator_body_mismatch");
  });
});

describe("scopes", () => {
  test("every other /internal route refuses a coordinator credential", async () => {
    const { app } = buildPortal();
    const key = keypair();
    expect((await app.inject(signed("coord-a", key, "GET", "/internal/stats/counts", undefined, enrolHeaders("coord-a")))).statusCode).toBe(200);
    for (const call of [
      signed("coord-a", key, "GET", "/internal/security-research/entitlements"),
      signed("coord-a", key, "POST", "/internal/nodes/agent-1/approval", { approved: true }, { "x-admin-token": "nope" }),
      signed("coord-a", key, "GET", "/internal/coordinator-credentials")
    ]) {
      const res = await app.inject(call);
      expect(res.statusCode, call.url).toBe(403);
      expect(res.json().error, call.url).toBe("coordinator_scope_denied");
    }
  });

  test("nodes:validate covers agents registering to it and its own node, not another coordinator", async () => {
    const { app } = buildPortal();
    const key = keypair();
    expect((await app.inject(signed("coord-a", key, "POST", "/internal/nodes/validate", validateBody("coord-a", "coordinator"), enrolHeaders("coord-a")))).statusCode).toBe(200);
    const other = await app.inject(signed("coord-a", key, "POST", "/internal/nodes/validate", validateBody("coord-b", "coordinator")));
    expect(other.statusCode).toBe(403);
    expect(other.json().reason).toBe("coordinator_scope_denied");
  });

  test("a credential without a scope cannot use that route", async () => {
    const { app, store } = buildPortal();
    const key = keypair();
    const admin = await app.inject({
      method: "POST",
      url: "/internal/coordinator-credentials",
      headers: { "x-portal-service-token": SERVICE, "x-admin-token": ADMIN },
      payload: { coordinatorNodeId: "coord-a", publicKeyPem: key.pub, scopes: ["nodes:lookup:self"] }
    });
    expect(admin.statusCode).toBe(200);
    expect((await store.listForCoordinator("coord-a"))[0].scopes).toEqual(["nodes:lookup:self"]);
    expect((await app.inject(signed("coord-a", key, "POST", "/internal/nodes/lookup", { nodeIds: [] }))).statusCode).toBe(200);
    const stats = await app.inject(signed("coord-a", key, "GET", "/internal/stats/counts"));
    expect(stats.statusCode).toBe(403);
    expect(stats.json()).toEqual({ error: "coordinator_scope_denied", scope: "stats:read" });
    expect(scopeForRoute("post", "/internal/nodes/validate")).toBe("nodes:validate");
    expect(scopeForRoute("POST", "/internal/payouts/callback-changed")).toBeNull();
  });
});

describe("revocation", () => {
  test("an admin revoke stops the coordinator at once, and it cannot bind a new key itself", async () => {
    const { app } = buildPortal();
    const key = keypair();
    expect((await app.inject(signed("coord-a", key, "GET", "/internal/stats/counts", undefined, enrolHeaders("coord-a")))).statusCode).toBe(200);
    const noAdmin = await app.inject({ method: "POST", url: "/internal/coordinator-credentials/revoke", headers: { "x-portal-service-token": SERVICE }, payload: { coordinatorNodeId: "coord-a" } });
    expect(noAdmin.statusCode).toBe(403);
    const revoke = await app.inject({ method: "POST", url: "/internal/coordinator-credentials/revoke", headers: { "x-portal-service-token": SERVICE, "x-admin-token": ADMIN }, payload: { coordinatorNodeId: "coord-a", reason: "test" } });
    expect(revoke.json()).toEqual({ ok: true, revoked: 1 });
    const after = await app.inject(signed("coord-a", key, "GET", "/internal/stats/counts"));
    expect(after.statusCode).toBe(403);
    expect(after.json().error).toBe("coordinator_credential_revoked");
    const rebind = await app.inject(signed("coord-a", keypair(), "GET", "/internal/stats/counts", undefined, enrolHeaders("coord-a")));
    expect(rebind.json().error).toBe("coordinator_credential_revoked");
  });

  test("revoking a coordinator that never called blocks its first call too", async () => {
    const { app } = buildPortal();
    await app.inject({ method: "POST", url: "/internal/coordinator-credentials/revoke", headers: { "x-portal-service-token": SERVICE, "x-admin-token": ADMIN }, payload: { coordinatorNodeId: "coord-b" } });
    const res = await app.inject(signed("coord-b", keypair(), "GET", "/internal/stats/counts", undefined, enrolHeaders("coord-b")));
    expect(res.json().error).toBe("coordinator_credential_revoked");
  });

  test("the registry trusts its members' current key and a suspension refuses them", async () => {
    const key = keypair();
    const registry = new Map<string, RegistryMemberView>([["coord-r", { nodeId: "coord-r", status: "active", keyFingerprints: [publicKeyFingerprint(key.pub)], operatorUserId: "op-r" }]]);
    const { app, store } = buildPortal({ registry });
    expect((await app.inject(signed("coord-r", key, "GET", "/internal/stats/counts"))).statusCode).toBe(200);
    expect((await store.listForCoordinator("coord-r"))[0]).toMatchObject({ source: "registry", operatorUserId: "op-r" });
    // Another key for the same member is not trusted.
    expect((await app.inject(signed("coord-r", keypair(), "GET", "/internal/stats/counts"))).statusCode).toBe(403);
    registry.set("coord-r", { ...registry.get("coord-r")!, status: "suspended" });
    const suspended = await app.inject(signed("coord-r", key, "GET", "/internal/stats/counts"));
    expect(suspended.statusCode).toBe(403);
    expect(suspended.json().error).toBe("coordinator_suspended");
    // Rotated in the registry: the old key bound through it stops working.
    const next = keypair();
    registry.set("coord-r", { ...registry.get("coord-r")!, status: "active", keyFingerprints: [publicKeyFingerprint(next.pub), publicKeyFingerprint(key.pub)] });
    expect((await app.inject(signed("coord-r", key, "GET", "/internal/stats/counts"))).statusCode).toBe(403);
    expect((await app.inject(signed("coord-r", next, "GET", "/internal/stats/counts"))).statusCode).toBe(200);
  });
});

describe("PORTAL_COORDINATOR_TOKEN migration flag", () => {
  test("on (default): still accepted, with a deprecation warning", async () => {
    const { app, warn } = buildPortal();
    const res = await app.inject({ method: "POST", url: "/internal/nodes/lookup", headers: { "x-portal-service-token": COORD, ...enrolHeaders("coord-a") }, payload: { nodeIds: [] } });
    expect(res.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "token_only" }), "portal_coordinator_token_deprecated");
  });

  test("off: refused; a signed call still works", async () => {
    const { app } = buildPortal({ acceptCoordinatorToken: false });
    const res = await app.inject({ method: "POST", url: "/internal/nodes/lookup", headers: { "x-portal-service-token": COORD, ...enrolHeaders("coord-a") }, payload: { nodeIds: [] } });
    expect(res.statusCode).toBe(401);
    expect((await app.inject(signed("coord-a", keypair(), "POST", "/internal/nodes/lookup", { nodeIds: [] }, enrolHeaders("coord-a")))).statusCode).toBe(200);
  });

  test("the platform service token keeps the full answer", async () => {
    const { app } = buildPortal();
    const res = await app.inject({ method: "POST", url: "/internal/nodes/lookup", headers: { "x-portal-service-token": SERVICE }, payload: { nodeIds: ["agent-1"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes[0].ownerEmail).toBe("agent-1@x.io");
  });
});

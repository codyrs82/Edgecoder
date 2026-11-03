import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { dnsLabelConflicts } from "../../src/portal/dns-manager.js";
import { isReservedNodeId, registerAccountApiRoutes } from "../../src/portal/routes/account.js";
import { registerPasskeyRoutes } from "../../src/portal/routes/passkey.js";

const sha256Hex = (s: string) => `h(${s})`;

function setup() {
  const users: Record<string, { userId: string; email: string; emailVerified: boolean }> = {
    "Bearer alice": { userId: "alice", email: "a@x.io", emailVerified: true },
    "Bearer bob": { userId: "bob", email: "b@x.io", emailVerified: true }
  };
  const nodes = new Map<string, any>();
  const deleteDnsRecord = vi.fn(async () => ({ ok: true }));
  const store = {
    getNodeEnrollment: async (id: string) => nodes.get(id) ?? null,
    getNodeEnrollmentByDeviceId: async () => null,
    getNodeEnrollmentByRegistrationTokenHash: async (h: string) => [...nodes.values()].find((n) => n.registrationTokenHash === h) ?? null,
    listCoordinatorNodeIds: async () => [...nodes.values()].filter((n) => n.nodeKind === "coordinator").map((n) => n.nodeId),
    listActiveCoordinators: async () => [{ nodeId: "seed-1", dnsHostname: "seed-1.coord.edgecoder.io", dnsStatus: "active" }],
    upsertNodeEnrollment: async (r: any) => {
      const prev = nodes.get(r.nodeId);
      if (prev && prev.ownerUserId !== r.ownerUserId) return null;
      const rec = { ...r, nodeApproved: false, active: false };
      nodes.set(r.nodeId, rec);
      return rec;
    },
    setNodeApproval: async (id: string, v: boolean) => ({ ...nodes.get(id), nodeApproved: v }),
    updateNodeDns: async (i: any) => { nodes.set(i.nodeId, { ...nodes.get(i.nodeId), dnsHostname: i.dnsHostname }); },
    deleteNodeEnrollment: async (id: string) => nodes.delete(id)
  };
  const app = Fastify();
  registerAccountApiRoutes(app, {
    store,
    getCurrentUser: async (req: any) => users[String(req.headers.authorization)] ?? null,
    buildAccessContext: async () => ({ isSystemAdmin: false, isCoordinatorAdmin: false }),
    getCoordinatorHostname: (id: string) => `${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.coord.edgecoder.io`,
    deleteDnsRecord,
    sha256Hex,
    deriveIosDeviceIdFromNodeId: () => undefined
  } as never);
  const enroll = (who: string, nodeId: string, nodeKind = "coordinator") =>
    app.inject({ method: "POST", url: "/nodes/enroll", headers: { authorization: `Bearer ${who}` }, payload: { nodeId, nodeKind } });
  return { app, nodes, enroll, deleteDnsRecord };
}

describe("node ID rules", () => {
  it("reserves the credit-account prefix", async () => {
    expect(isReservedNodeId("acct-123")).toBe(true);
    expect(isReservedNodeId("ACCT-123")).toBe(true);
    expect(isReservedNodeId("my-acct-1")).toBe(false);
    const { enroll } = setup();
    const res = await enroll("bob", "acct-alice", "agent");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("reserved_node_id");
  });

  it("finds node IDs that share a DNS label", () => {
    expect(dnsLabelConflicts("MY_COORD", ["my-coord", "MY_COORD", "other"])).toEqual(["my-coord"]);
    expect(dnsLabelConflicts("a.b", ["a-b"])).toEqual(["a-b"]);
    expect(dnsLabelConflicts("solo", ["solo", "solo2"])).toEqual([]);
  });

  it("refuses a coordinator whose DNS name another coordinator already maps to", async () => {
    const { enroll } = setup();
    expect((await enroll("alice", "my-coord")).statusCode).toBe(200);
    const res = await enroll("bob", "MY_COORD");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("dns_name_taken");
    // Re-enrolling your own coordinator is fine.
    expect((await enroll("alice", "my-coord")).statusCode).toBe(200);
  });

  it("keeps a DNS record another enrollment's node ID also maps to when deleting", async () => {
    const { app, nodes, deleteDnsRecord } = setup();
    // Two older enrollments that collide (created before the check).
    nodes.set("my-coord", { nodeId: "my-coord", nodeKind: "coordinator", ownerUserId: "alice", dnsHostname: "my-coord.coord.edgecoder.io" });
    nodes.set("MY_COORD", { nodeId: "MY_COORD", nodeKind: "coordinator", ownerUserId: "bob", dnsHostname: "my-coord.coord.edgecoder.io" });
    const res = await app.inject({ method: "DELETE", url: "/nodes/MY_COORD", headers: { authorization: "Bearer bob" } });
    expect(res.statusCode).toBe(200);
    expect(deleteDnsRecord).not.toHaveBeenCalled();
    nodes.set("solo", { nodeId: "solo", nodeKind: "coordinator", ownerUserId: "bob", dnsHostname: "solo.coord.edgecoder.io" });
    await app.inject({ method: "DELETE", url: "/nodes/solo", headers: { authorization: "Bearer bob" } });
    expect(deleteDnsRecord).toHaveBeenCalledWith("solo");
  });
});

describe("GET /nodes/discover-coordinator", () => {
  it("needs a registration token that belongs to an enrollment", async () => {
    const { app, enroll } = setup();
    const enrolled = await enroll("alice", "box-gpu0", "agent");
    const token = enrolled.json().registrationToken as string;
    expect((await app.inject({ url: "/nodes/discover-coordinator" })).statusCode).toBe(401);
    const bad = await app.inject({ url: "/nodes/discover-coordinator", headers: { authorization: "Bearer not-a-token" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("registration_token_invalid");
    const ok = await app.inject({ url: "/nodes/discover-coordinator", headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ coordinatorUrl: "https://seed-1.coord.edgecoder.io" });
  });
});

describe("POST /auth/passkey/register/verify", () => {
  it("returns 409 when the credential ID belongs to another user", async () => {
    const app = Fastify();
    registerPasskeyRoutes(app, {
      store: {
        consumePasskeyChallenge: async () => ({ flowType: "registration", userId: "bob", challenge: "c" }),
        upsertPasskeyCredential: async () => false
      },
      getCurrentUser: async () => ({ userId: "bob", email: "b@x.io" }),
      normalizePasskeyResponsePayload: (r: unknown) => r,
      verifyRegistrationResponse: async () => ({
        verified: true,
        registrationInfo: { credential: { id: "victim-cred", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, credentialDeviceType: "singleDevice", credentialBackedUp: false }
      }),
      base64UrlFromBuffer: (b: Uint8Array) => Buffer.from(b).toString("base64url"),
      PASSKEY_ALLOWED_ORIGINS: ["https://portal.example"],
      PASSKEY_RP_ID: "portal.example"
    } as never);
    const res = await app.inject({ method: "POST", url: "/auth/passkey/register/verify", payload: { challengeId: "x".repeat(36), response: {} } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("passkey_already_registered");
  });
});

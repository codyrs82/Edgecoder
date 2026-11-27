import { describe, expect, test, vi } from "vitest";
import Fastify from "fastify";
import { createInternalAuth } from "../../src/portal/internal-auth.js";
import { registerInternalRoutes } from "../../src/portal/routes/internal.js";

/*
 * /internal/nodes/validate and /internal/nodes/lookup with the real route file and auth:
 * - validate never derives DNS from the caller-supplied sourceIp,
 * - validate records which coordinator (coordinator token + its own enrollment) validated a node,
 * - lookup with the shared coordinator token answers only about those nodes, without owner email,
 *   IP or country; the platform service token keeps the full answer.
 */

const SERVICE = "svc-token";
const COORD = "coord-token";

type Node = Record<string, any>;

function buildPortal() {
  const auth = createInternalAuth({ serviceToken: SERVICE, coordinatorToken: COORD, adminToken: "admin", allowOpenWhenUnset: false });
  const nodes = new Map<string, Node>();
  const add = (n: Node) => nodes.set(n.nodeId, { emailVerified: true, nodeApproved: true, active: true, ownerEmail: `${n.nodeId}@x.io`, lastIp: "198.51.100.9", lastCountryCode: "DE", ...n });
  add({ nodeId: "coord-a", nodeKind: "coordinator", registrationTokenHash: "h(coord-a-registration)" });
  add({ nodeId: "coord-b", nodeKind: "coordinator", registrationTokenHash: "h(coord-b-registration)" });
  add({ nodeId: "agent-1", nodeKind: "agent", registrationTokenHash: "h(agent-1-registration)" });
  add({ nodeId: "agent-2", nodeKind: "agent", registrationTokenHash: "h(agent-2-registration)", lastValidatedByCoordinator: "coord-b" });
  const updateNodeDns = vi.fn(async () => undefined);
  const store = {
    getNodeEnrollment: async (id: string) => (nodes.has(id) ? { ...nodes.get(id) } : null),
    getNodeEnrollmentByDeviceId: async () => null,
    getNodeEnrollmentByRegistrationTokenHash: async () => null,
    listCoordinatorNodeIds: async () => ["coord-a", "coord-b"],
    updateNodeDns,
    touchNodeValidation: async (i: { nodeId: string; sourceIp?: string; validatedByCoordinator?: string | null }) => {
      const n = nodes.get(i.nodeId)!;
      n.lastIp = i.sourceIp ?? n.lastIp;
      if (i.validatedByCoordinator !== undefined) n.lastValidatedByCoordinator = i.validatedByCoordinator ?? undefined;
    }
  };
  const app = Fastify();
  app.register(async (internal) => {
    registerInternalRoutes(internal, {
      ...auth,
      store,
      autoRequestHost: undefined,
      hostApprovedFor: async () => true,
      deleteDnsRecord: async () => undefined,
      deriveIosDeviceIdFromNodeId: () => undefined,
      resolveIpIntelligence: async () => ({ countryCode: "DE", vpnDetected: false }),
      secureCompare: (a: string, b: string) => a === b,
      sha256Hex: (v: string) => `h(${v})`
    } as any);
  });
  return { app, nodes, updateNodeDns };
}

const coordA = { "x-coordinator-node-id": "coord-a", "x-coordinator-registration-token": "coord-a-registration" };

const validate = (app: any, headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/internal/nodes/validate", headers: { "content-type": "application/json", ...headers }, payload });
const lookup = (app: any, headers: Record<string, string>, nodeIds: string[]) =>
  app.inject({ method: "POST", url: "/internal/nodes/lookup", headers: { "content-type": "application/json", ...headers }, payload: { nodeIds } });

describe("/internal/nodes/validate", () => {
  test("keeps validating agents with either token and records the validating coordinator", async () => {
    const { app, nodes } = buildPortal();
    const res = await validate(app, { "x-portal-service-token": COORD, ...coordA }, { nodeId: "agent-1", nodeKind: "agent", registrationToken: "agent-1-registration", sourceIp: "203.0.113.5" });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowed).toBe(true);
    expect(nodes.get("agent-1")!.lastValidatedByCoordinator).toBe("coord-a");
    // A platform-token validation clears it.
    const svc = await validate(app, { "x-portal-service-token": SERVICE }, { nodeId: "agent-1", nodeKind: "agent", registrationToken: "agent-1-registration" });
    expect(svc.json().allowed).toBe(true);
    expect(nodes.get("agent-1")!.lastValidatedByCoordinator).toBeUndefined();
  });

  test("a coordinator-token call with a wrong identity records nothing", async () => {
    const { app, nodes } = buildPortal();
    await validate(app, { "x-portal-service-token": COORD, "x-coordinator-node-id": "coord-a", "x-coordinator-registration-token": "coord-b-registration" }, { nodeId: "agent-1", nodeKind: "agent", registrationToken: "agent-1-registration" });
    expect(nodes.get("agent-1")!.lastValidatedByCoordinator).toBeUndefined();
    // An agent's own token is not a coordinator identity.
    await validate(app, { "x-portal-service-token": COORD, "x-coordinator-node-id": "agent-2", "x-coordinator-registration-token": "agent-2-registration" }, { nodeId: "agent-1", nodeKind: "agent", registrationToken: "agent-1-registration" });
    expect(nodes.get("agent-1")!.lastValidatedByCoordinator).toBeUndefined();
  });

  test("never sets a coordinator's DNS from the caller-supplied sourceIp", async () => {
    const { app, updateNodeDns } = buildPortal();
    const res = await validate(app, { "x-portal-service-token": COORD }, { nodeId: "coord-b", nodeKind: "coordinator", registrationToken: "coord-b-registration", sourceIp: "203.0.113.200" });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(updateNodeDns).not.toHaveBeenCalled();
  });
});

describe("/internal/nodes/lookup", () => {
  test("the service token keeps the full answer for any node", async () => {
    const { app } = buildPortal();
    const res = await lookup(app, { "x-portal-service-token": SERVICE }, ["agent-1", "agent-2"]);
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes.map((n: any) => n.nodeId)).toEqual(["agent-1", "agent-2"]);
    expect(res.json().nodes[0]).toMatchObject({ ownerEmail: "agent-1@x.io", sourceIp: "198.51.100.9", countryCode: "DE" });
  });

  test("the coordinator token without a valid coordinator identity is refused", async () => {
    const { app } = buildPortal();
    expect((await lookup(app, { "x-portal-service-token": COORD }, ["agent-1"])).statusCode).toBe(403);
    const wrong = await lookup(app, { "x-portal-service-token": COORD, "x-coordinator-node-id": "coord-a", "x-coordinator-registration-token": "nope-nope-nope" }, ["agent-1"]);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe("coordinator_identity_required");
  });

  test("the coordinator token sees only nodes its coordinator validated, without email, IP or country", async () => {
    const { app } = buildPortal();
    await validate(app, { "x-portal-service-token": COORD, ...coordA }, { nodeId: "agent-1", nodeKind: "agent", registrationToken: "agent-1-registration", sourceIp: "203.0.113.5" });
    const res = await lookup(app, { "x-portal-service-token": COORD, ...coordA }, ["agent-1", "agent-2", "coord-b"]);
    expect(res.statusCode).toBe(200);
    const nodes = res.json().nodes;
    expect(nodes.map((n: any) => n.nodeId)).toEqual(["agent-1"]);
    expect(nodes[0]).toMatchObject({ nodeKind: "agent", hostApproved: true, active: true });
    for (const field of ["ownerEmail", "sourceIp", "countryCode"]) expect(nodes[0]).not.toHaveProperty(field);
  });
});

describe("callerKind", () => {
  test("tells the platform token from the shared coordinator token", () => {
    const auth = createInternalAuth({ serviceToken: SERVICE, coordinatorToken: COORD, adminToken: "a", allowOpenWhenUnset: false });
    expect(auth.callerKind({ headers: { "x-portal-service-token": SERVICE } })).toBe("service");
    expect(auth.callerKind({ headers: { "x-portal-service-token": COORD } })).toBe("coordinator");
    expect(auth.callerKind({ headers: { "x-portal-service-token": "other" } })).toBeNull();
    // Same value configured for both: the platform token wins.
    const same = createInternalAuth({ serviceToken: SERVICE, coordinatorToken: SERVICE, adminToken: "a", allowOpenWhenUnset: false });
    expect(same.callerKind({ headers: { "x-portal-service-token": SERVICE } })).toBe("service");
  });
});

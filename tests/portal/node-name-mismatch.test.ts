import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createInternalAuth } from "../../src/portal/internal-auth.js";
import { rejectedAttemptsForOwner, REJECTED_ATTEMPT_WINDOW_MS } from "../../src/portal/rejected-attempts.js";
import { registerAccountApiRoutes } from "../../src/portal/routes/account.js";
import { registerInternalRoutes } from "../../src/portal/routes/internal.js";

/*
 * An agent that names itself differently from its enrolment (Patrick enrolled RTXA2000-Laptop, the
 * installer named the agent nvidia-1-gpu): the portal says which node its token is for, the
 * installer can ask the same with the token, and the owner's Nodes page lists the refused name.
 */

const sha256Hex = (s: string) => `h(${s})`;
const NODES = new Map<string, { nodeId: string; nodeKind: string; ownerUserId: string; ownerEmail: string; registrationTokenHash: string }>([
  ["RTXA2000-Laptop", { nodeId: "RTXA2000-Laptop", nodeKind: "agent", ownerUserId: "patrick", ownerEmail: "patrick@example.com", registrationTokenHash: sha256Hex("tok-patrick") }],
  ["alice-gpu", { nodeId: "alice-gpu", nodeKind: "agent", ownerUserId: "alice", ownerEmail: "alice@example.com", registrationTokenHash: sha256Hex("tok-alice") }]
]);
const store = {
  getNodeEnrollment: async (id: string) => NODES.get(id) ?? null,
  getNodeEnrollmentByDeviceId: async () => null,
  getNodeEnrollmentByRegistrationTokenHash: async (h: string) => [...NODES.values()].find((n) => n.registrationTokenHash === h) ?? null
};

async function internalApp() {
  const auth = createInternalAuth({ serviceToken: "svc", coordinatorToken: "coord", adminToken: "adm", allowOpenWhenUnset: false });
  const app = Fastify();
  await app.register(async (internal) => {
    registerInternalRoutes(internal, { ...auth, store, sha256Hex, secureCompare: (a: string, b: string) => a === b, deriveIosDeviceIdFromNodeId: () => undefined, resolveIpIntelligence: async () => ({}) } as never);
  });
  return app;
}

const validate = (app: any, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/internal/nodes/validate", headers: { "content-type": "application/json", "x-portal-service-token": "coord" }, payload: body });

describe("portal /internal/nodes/validate names the token's own node on node_not_enrolled", () => {
  it("a token enrolled as another name: tokenNode is that enrolment", async () => {
    const app = await internalApp();
    const res = await validate(app, { nodeId: "nvidia-1-gpu", nodeKind: "agent", registrationToken: "tok-patrick" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ allowed: false, reason: "node_not_enrolled", tokenNode: { nodeId: "RTXA2000-Laptop", ownerEmail: "patrick@example.com" } });
  });

  it("an unknown token, or one for another node kind, names nobody", async () => {
    const app = await internalApp();
    expect((await validate(app, { nodeId: "nvidia-1-gpu", nodeKind: "agent", registrationToken: "tok-nobody-1" })).json()).toEqual({ allowed: false, reason: "node_not_enrolled" });
    expect((await validate(app, { nodeId: "some-coord", nodeKind: "coordinator", registrationToken: "tok-patrick" })).json()).toEqual({ allowed: false, reason: "node_not_enrolled" });
  });
});

function accountApp(projection: Array<Record<string, unknown>>) {
  const users: Record<string, { userId: string; email: string; emailVerified: boolean }> = {
    "Bearer patrick": { userId: "patrick", email: "patrick@example.com", emailVerified: true },
    "Bearer alice": { userId: "alice", email: "alice@example.com", emailVerified: true }
  };
  const asked: Array<string | undefined> = [];
  const app = Fastify();
  registerAccountApiRoutes(app, {
    store,
    sha256Hex,
    getCurrentUser: async (req: any) => users[String(req.headers.authorization)] ?? null,
    // Like the coordinators: rows whose owner_email is the asked one.
    fetchCoordinatorFederatedSummary: async ({ ownerEmail }: { ownerEmail?: string }) => {
      asked.push(ownerEmail);
      return { nodes: projection.filter((n) => !ownerEmail || n.ownerEmail === ownerEmail) };
    }
  } as never);
  return { app, asked };
}

describe("GET /nodes/token-node: the node id a token was issued for, for the token's holder", () => {
  it("answers with the token, refuses without or with an unknown one", async () => {
    const { app } = accountApp([]);
    const ok = await app.inject({ url: "/nodes/token-node", headers: { authorization: "Bearer tok-patrick" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ nodeId: "RTXA2000-Laptop", nodeKind: "agent" });
    expect((await app.inject({ url: "/nodes/token-node" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/nodes/token-node", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
  });
});

describe("GET /nodes/rejected-attempts: only this account's tokens", () => {
  const now = Date.now();
  const projection = [
    { nodeId: "nvidia-1-gpu", nodeKind: "agent", ownerEmail: "patrick@example.com", lastSeenMs: now - 60_000 },
    { nodeId: "alice-other-name", nodeKind: "agent", ownerEmail: "alice@example.com", lastSeenMs: now - 60_000 },
    // Enrolled (by anyone): not an unenrolled attempt.
    { nodeId: "RTXA2000-Laptop", nodeKind: "agent", ownerEmail: "patrick@example.com", lastSeenMs: now },
    // Too old, approved, or a coordinator: not shown.
    { nodeId: "old-name", nodeKind: "agent", ownerEmail: "patrick@example.com", lastSeenMs: now - REJECTED_ATTEMPT_WINDOW_MS - 1 },
    { nodeId: "approved-name", nodeKind: "agent", ownerEmail: "patrick@example.com", nodeApproved: true, lastSeenMs: now },
    { nodeId: "coord-x", nodeKind: "coordinator", ownerEmail: "patrick@example.com", lastSeenMs: now }
  ];

  it("lists the names refused with the owner's own tokens", async () => {
    const { app, asked } = accountApp(projection);
    const res = await app.inject({ url: "/nodes/rejected-attempts", headers: { authorization: "Bearer patrick" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().attempts.map((a: { nodeId: string }) => a.nodeId)).toEqual(["nvidia-1-gpu"]);
    expect(asked).toEqual(["patrick@example.com"]);
    const alice = await app.inject({ url: "/nodes/rejected-attempts", headers: { authorization: "Bearer alice" } });
    expect(alice.json().attempts.map((a: { nodeId: string }) => a.nodeId)).toEqual(["alice-other-name"]);
    expect((await app.inject({ url: "/nodes/rejected-attempts" })).statusCode).toBe(401);
  });

  it("drops rows of another email even when a coordinator returns them", async () => {
    const out = await rejectedAttemptsForOwner({ ownerEmail: "Patrick@Example.com", nodes: projection, isEnrolled: async (id) => NODES.has(id), nowMs: now });
    expect(out.map((a) => a.nodeId)).toEqual(["nvidia-1-gpu"]);
    expect(await rejectedAttemptsForOwner({ ownerEmail: "", nodes: projection, isEnrolled: async () => false, nowMs: now })).toEqual([]);
  });
});

import { describe, expect, test } from "vitest";
import Fastify from "fastify";
import { createInternalAuth } from "../../src/portal/internal-auth.js";
import { registerInternalRoutes } from "../../src/portal/routes/internal.js";

/*
 * The portal's /internal/* routes with the real route file and auth: coordinators hold a
 * read/validate credential (the coordinator token, or today the shared service token), and node
 * approval also needs the control-plane admin credential.
 */

const SERVICE = "svc-token";
const COORD = "coord-token";
const ADMIN = "cp-admin-token";

async function buildPortal(opts: { coordinatorToken?: string; adminToken?: string } = {}) {
  const auth = createInternalAuth({ serviceToken: SERVICE, coordinatorToken: opts.coordinatorToken ?? COORD, adminToken: opts.adminToken ?? ADMIN, allowOpenWhenUnset: false });
  const approvals: Array<{ nodeId: string; approved: boolean }> = [];
  const store = {
    setNodeApproval: async (nodeId: string, approved: boolean) => {
      approvals.push({ nodeId, approved });
      return { nodeId, nodeKind: "agent", nodeApproved: approved };
    },
    listPendingNodes: async () => [],
    getNodeEnrollment: async () => null
  };
  const app = Fastify();
  await app.register(async (internal) => {
    registerInternalRoutes(internal, {
      ...auth,
      store,
      deleteDnsRecord: async () => undefined,
      deriveIosDeviceIdFromNodeId: () => undefined,
      getCoordinatorHostname: () => "",
      isDnsConfigured: () => false,
      resolveIpIntelligence: async () => ({}),
      secureCompare: (a: string, b: string) => a === b,
      sha256Hex: (v: string) => v,
      syncCoordinatorDns: async () => undefined
    } as any);
  });
  return { app, approvals };
}

const approve = (app: any, headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/internal/nodes/node-1/approval", headers: { "content-type": "application/json", ...headers }, payload: { approved: true } });

describe("portal node approval needs the control-plane admin credential", () => {
  test("the coordinator token cannot approve nodes", async () => {
    const { app, approvals } = await buildPortal();
    const res = await approve(app, { "x-portal-service-token": COORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("control_plane_admin_required");
    expect(approvals).toHaveLength(0);
  });

  test("the service token alone cannot approve nodes either", async () => {
    const { app, approvals } = await buildPortal();
    expect((await approve(app, { "x-portal-service-token": SERVICE })).statusCode).toBe(403);
    expect((await approve(app, { "x-portal-service-token": SERVICE, "x-admin-token": "wrong" })).statusCode).toBe(403);
    expect(approvals).toHaveLength(0);
  });

  test("the admin credential without any internal token is still refused by the plugin hook", async () => {
    const { app } = await buildPortal();
    expect((await approve(app, { "x-admin-token": ADMIN })).statusCode).toBe(401);
  });

  test("service token plus admin credential (what the control plane sends) approves", async () => {
    const { app, approvals } = await buildPortal();
    expect((await approve(app, { "x-portal-service-token": SERVICE, "x-admin-token": ADMIN })).statusCode).toBe(200);
    expect((await approve(app, { "x-portal-service-token": SERVICE, authorization: `Bearer ${ADMIN}` })).statusCode).toBe(200);
    expect(approvals).toEqual([
      { nodeId: "node-1", approved: true },
      { nodeId: "node-1", approved: true }
    ]);
  });

  test("with no admin credential configured, approval is closed (503)", async () => {
    const { app } = await buildPortal({ adminToken: "" });
    expect((await approve(app, { "x-portal-service-token": SERVICE, "x-admin-token": "anything" })).statusCode).toBe(503);
  });
});

describe("the coordinator token is read/validate only", () => {
  test("it reads pending nodes and stats", async () => {
    const { app } = await buildPortal();
    expect((await app.inject({ method: "GET", url: "/internal/nodes/pending", headers: { "x-portal-service-token": COORD } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/internal/nodes/lookup", headers: { "x-portal-service-token": COORD }, payload: { nodeIds: ["a"] } })).statusCode).toBe(200);
  });

  test("a wrong token is refused", async () => {
    const { app } = await buildPortal();
    expect((await app.inject({ method: "GET", url: "/internal/nodes/pending", headers: { "x-portal-service-token": "nope" } })).statusCode).toBe(401);
  });

  test("when no coordinator token is configured, only the service token works", async () => {
    const { app } = await buildPortal({ coordinatorToken: "" });
    expect((await app.inject({ method: "GET", url: "/internal/nodes/pending", headers: { "x-portal-service-token": COORD } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/internal/nodes/pending", headers: { "x-portal-service-token": SERVICE } })).statusCode).toBe(200);
  });
});

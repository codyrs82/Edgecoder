import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Rejecting a pending request from a node with no portal enrollment (owner "unknown") goes to the
// coordinators' /admin/nodes/:id/dismiss; such a node is never approved.
const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
vi.mock("undici", () => ({
  request: vi.fn(async (url: string, opts: { headers: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    return { statusCode: 200, body: { dump: async () => {}, json: async () => ({}), text: async () => "" } };
  })
}));
const { registerCoordinatorOpsRoutes } = await import("../../src/portal/routes/coordinator-ops.js");

function build(opts: { isSystemAdmin?: boolean; enrolled?: boolean } = {}) {
  const audit: unknown[] = [];
  const autoRequested: unknown[] = [];
  const app = Fastify();
  registerCoordinatorOpsRoutes(app, {
    COORDINATOR_ADMIN_TOKEN: "coord-admin",
    autoRequestHost: async (n: unknown) => { autoRequested.push(n); },
    CONTROL_PLANE_URL: "",
    CONTROL_PLANE_ADMIN_TOKEN: "",
    EXTERNAL_HTTP_TIMEOUT_MS: 1000,
    controlPlaneHeaders: () => ({}),
    discoverCoordinatorUrlsForPortal: async () => ["https://seed.test/", "https://seed-eu.test"],
    requireCoordinatorOperationsUser: async () => ({
      user: { userId: "admin", email: "admin@x.io" },
      access: { isSystemAdmin: opts.isSystemAdmin ?? true, canManageCoordinatorOps: true }
    }),
    store: {
      getNodeEnrollment: async (id: string) => (opts.enrolled ? { nodeId: id, nodeKind: "agent", ownerEmail: "owner@x.io", nodeApproved: false } : null),
      setNodeApproval: async () => undefined,
      deleteNodeEnrollment: async () => true,
      appendAdminAudit: async (e: unknown) => { audit.push(e); return "a1"; }
    }
  } as never);
  return { app, audit, autoRequested };
}

describe("ownerless enrollment requests", () => {
  beforeEach(() => { calls.length = 0; });

  it("refuses to approve a node with no owner account", async () => {
    const { app } = build();
    const res = await app.inject({ method: "POST", url: "/coordinator/ops/node-approval", payload: { nodeId: "lambda-a100-gpu", nodeKind: "agent", approved: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("node_has_no_owner");
    expect(calls).toEqual([]);
    await app.close();
  });

  it("rejects by dismissing it on every coordinator, with the block, and audits it", async () => {
    const { app, audit } = build();
    const res = await app.inject({ method: "POST", url: "/coordinator/ops/node-dismiss", payload: { nodeId: "lambda-a100-gpu", nodeKind: "agent", blockDays: 7 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, dismissed: 2, blockDays: 7 });
    expect(calls.map((c) => c.url).sort()).toEqual(["https://seed-eu.test/admin/nodes/lambda-a100-gpu/dismiss", "https://seed.test/admin/nodes/lambda-a100-gpu/dismiss"]);
    for (const c of calls) {
      expect(c.headers["x-admin-token"]).toBe("coord-admin");
      expect(c.body).toMatchObject({ nodeKind: "agent", blockDays: 7 });
    }
    expect(audit).toEqual([expect.objectContaining({ action: "node.dismiss", actorEmail: "admin@x.io", detail: expect.objectContaining({ nodeId: "lambda-a100-gpu", blockDays: 7, dismissed: 2 }) })]);
    await app.close();
  });

  it("is for system admins only, and not for enrolled nodes", async () => {
    const notAdmin = build({ isSystemAdmin: false });
    expect((await notAdmin.app.inject({ method: "POST", url: "/coordinator/ops/node-dismiss", payload: { nodeId: "x1", nodeKind: "agent" } })).statusCode).toBe(403);
    const enrolled = build({ enrolled: true });
    expect((await enrolled.app.inject({ method: "POST", url: "/coordinator/ops/node-dismiss", payload: { nodeId: "x1", nodeKind: "agent" } })).statusCode).toBe(409);
    expect(calls).toEqual([]);
    await notAdmin.app.close();
    await enrolled.app.close();
  });

  it("approving an enrolled machine files a host request for its owner", async () => {
    const { app, autoRequested } = build({ enrolled: true });
    const res = await app.inject({ method: "POST", url: "/coordinator/ops/node-approval", payload: { nodeId: "mac-1", nodeKind: "agent", approved: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(autoRequested).toEqual([expect.objectContaining({ nodeId: "mac-1", ownerEmail: "owner@x.io" })]);
    await app.close();
  });
});

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

// The node id in the control-plane approval URL is one path segment: it is percent-encoded so it
// cannot add path segments, a query or a fragment.
const calls: string[] = [];
vi.mock("undici", () => ({
  request: vi.fn(async (url: string) => {
    calls.push(url);
    return { statusCode: 200, body: { dump: async () => {}, json: async () => ({}), text: async () => "" } };
  })
}));
const { registerCoordinatorOpsRoutes } = await import("../../src/portal/routes/coordinator-ops.js");

describe("POST /coordinator/ops/node-approval", () => {
  it("encodes the node id into a single path segment", async () => {
    const nodeId = "../../admin/x?y=1#z";
    const app = Fastify();
    registerCoordinatorOpsRoutes(app, {
      CONTROL_PLANE_URL: "http://control-plane.test",
      CONTROL_PLANE_ADMIN_TOKEN: "admin",
      controlPlaneHeaders: () => ({}),
      requireCoordinatorOperationsUser: async () => ({ user: { userId: "admin" }, access: { canManageCoordinatorOps: true } }),
      store: {
        getNodeEnrollment: async (id: string) => (id === nodeId ? { nodeId, nodeApproved: false } : null),
        setNodeApproval: async () => undefined,
        deleteNodeEnrollment: async () => true
      }
    } as never);
    const res = await app.inject({ method: "POST", url: "/coordinator/ops/node-approval", payload: { nodeId, nodeKind: "agent", approved: true } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([`http://control-plane.test/agents/${encodeURIComponent(nodeId)}/approval`]);
    await app.close();
  });
});

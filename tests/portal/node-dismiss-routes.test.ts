import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Rejecting a pending request from a node with no portal enrollment (owner "unknown") goes to the
// coordinators' /admin/nodes/:id/dismiss; such a node is never approved.
const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
let respond: (url: string, body: any) => { status: number; json: unknown } = () => ({ status: 200, json: {} });
vi.mock("undici", () => ({
  request: vi.fn(async (url: string, opts: { headers: Record<string, string>; body?: string }) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, headers: opts.headers, body });
    const r = respond(url, body);
    return { statusCode: r.status, body: { dump: async () => {}, json: async () => r.json, text: async () => "" } };
  })
}));
const { registerCoordinatorOpsRoutes } = await import("../../src/portal/routes/coordinator-ops.js");

function build(opts: { isSystemAdmin?: boolean; enrolled?: boolean } = {}) {
  const audit: unknown[] = [];
  const autoRequested: unknown[] = [];
  const deleted: string[] = [];
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
      deleteNodeEnrollment: async (id: string) => { deleted.push(id); return true; },
      deleteLedgerRows: async () => { throw new Error("history must be kept"); },
      appendAdminAudit: async (e: unknown) => { audit.push(e); return "a1"; }
    }
  } as never);
  return { app, audit, autoRequested, deleted };
}

describe("ownerless enrollment requests", () => {
  beforeEach(() => { calls.length = 0; respond = () => ({ status: 200, json: {} }); });

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

describe("removing an approved machine (node.remove)", () => {
  beforeEach(() => { calls.length = 0; respond = () => ({ status: 200, json: {} }); });
  const remove = (app: ReturnType<typeof build>["app"], payload: unknown) => app.inject({ method: "POST", url: "/coordinator/ops/node-remove", payload });

  it("revokes the token, drops it on every coordinator, keeps history and audits it", async () => {
    const { app, audit, deleted } = build({ enrolled: true });
    const res = await remove(app, { nodeId: "ec-st10-chi-gpu0-1", nodeKind: "agent" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, tokenRevoked: true, removed: 2 });
    expect(deleted).toEqual(["ec-st10-chi-gpu0-1"]);
    // A dry-run check on both coordinators, then the removal on both.
    expect(calls.map((c) => (c.body as { dryRun: boolean }).dryRun)).toEqual([true, true, false, false]);
    for (const c of calls) {
      expect(c.url).toMatch(/\/admin\/nodes\/ec-st10-chi-gpu0-1\/remove$/);
      expect(c.headers["x-admin-token"]).toBe("coord-admin");
    }
    expect(audit).toEqual([expect.objectContaining({ action: "node.remove", actorEmail: "admin@x.io", targetEmailHint: "owner@x.io", detail: expect.objectContaining({ nodeId: "ec-st10-chi-gpu0-1", tokenRevoked: true, force: false }) })]);
    await app.close();
  });

  it("refuses while a coordinator reports an active reservation lease, unless forced", async () => {
    respond = (url, body) => (body.dryRun && url.startsWith("https://seed-eu") ? { status: 409, json: { error: "active_reservation", detail: "holds active reservation r1 until 2026-11-16T12:00:00.000Z" } } : body.force ? { status: 200, json: {} } : { status: body.dryRun ? 200 : 409, json: {} });
    const { app, audit, deleted } = build({ enrolled: true });
    const res = await remove(app, { nodeId: "busy-1", nodeKind: "agent" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("active_reservation");
    expect(res.json().detail).toContain("reservation r1");
    expect(deleted).toEqual([]);
    expect(audit).toEqual([]);
    calls.length = 0;
    const forced = await remove(app, { nodeId: "busy-1", nodeKind: "agent", force: true });
    expect(forced.statusCode, forced.body).toBe(200);
    expect(calls.every((c) => (c.body as { force: boolean; dryRun: boolean }).force === true && (c.body as { dryRun: boolean }).dryRun === false)).toBe(true);
    expect(deleted).toEqual(["busy-1"]);
    expect(audit).toEqual([expect.objectContaining({ action: "node.remove", detail: expect.objectContaining({ force: true }) })]);
    await app.close();
  });

  it("is for system admins only", async () => {
    const { app, deleted } = build({ isSystemAdmin: false, enrolled: true });
    expect((await remove(app, { nodeId: "x1", nodeKind: "agent" })).statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect(deleted).toEqual([]);
    await app.close();
  });
});

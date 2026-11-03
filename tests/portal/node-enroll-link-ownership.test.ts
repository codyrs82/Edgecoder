import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAccountApiRoutes } from "../../src/portal/routes/account.js";

/**
 * /nodes/enroll and the /dashboard/summary self-heal must only link (and so route earnings for)
 * nodes the caller owns. A node ID or device ID enrolled by another user returns 409.
 */
describe("node enrollment ownership and agent links", () => {
  const links: Array<{ accountId: string; agentId: string; ownerUserId: string }> = [];
  const controlPlane = Fastify();
  let cpUrl = "";
  const users = {
    victim: { userId: "victim", email: "v@x.io", emailVerified: true },
    attacker: { userId: "attacker", email: "a@x.io", emailVerified: true }
  };
  let current: (typeof users)[keyof typeof users] = users.attacker;
  let nodes: Map<string, any>;

  beforeAll(async () => {
    controlPlane.post("/credits/accounts/:accountId/agents/link", async (req) => {
      const b = req.body as { agentId: string; ownerUserId: string };
      links.push({ accountId: (req.params as { accountId: string }).accountId, ...b });
      return { ok: true };
    });
    controlPlane.post("/credits/accounts/:accountId/ensure", async () => ({ ok: true }));
    await controlPlane.listen({ port: 0, host: "127.0.0.1" });
    const addr = controlPlane.server.address();
    cpUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await controlPlane.close();
  });

  // Mirrors PortalStore.upsertNodeEnrollment: a known device redirects to its node; the owner guard holds.
  const byDevice = (d?: string) => [...nodes.values()].find((n) => d && n.deviceId === d) ?? null;
  const store = {
    getNodeEnrollment: async (id: string) => nodes.get(id) ?? null,
    getNodeEnrollmentByDeviceId: async (d: string) => byDevice(d),
    listNodesByOwner: async (userId: string) => [...nodes.values()].filter((n) => n.ownerUserId === userId),
    upsertNodeEnrollment: async (r: any) => {
      const dev = byDevice(r.deviceId);
      const target = dev ? dev.nodeId : r.nodeId;
      const prev = nodes.get(target);
      if (prev && prev.ownerUserId !== r.ownerUserId) return null;
      const rec = { ...r, nodeId: target, deviceId: r.deviceId ?? prev?.deviceId, nodeApproved: prev?.nodeApproved ?? false, active: false };
      nodes.set(target, rec);
      return rec;
    },
    setNodeApproval: async (id: string, v: boolean) => {
      const n = { ...nodes.get(id), nodeApproved: v };
      nodes.set(id, n);
      return n;
    }
  };

  let enrollApp: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    links.length = 0;
    nodes = new Map([["victim-agent", { nodeId: "victim-agent", deviceId: "victim-device", nodeKind: "agent", ownerUserId: "victim", nodeApproved: true, active: true }]]);
    current = users.attacker;
    enrollApp = Fastify();
    registerAccountApiRoutes(enrollApp, {
      store,
      getCurrentUser: async () => current,
      sha256Hex: (s: string) => `h(${s})`,
      deriveIosDeviceIdFromNodeId: () => undefined,
      CONTROL_PLANE_URL: cpUrl,
      CONTROL_PLANE_ADMIN_TOKEN: "cp-admin",
      EXTERNAL_HTTP_TIMEOUT_MS: 2000,
      controlPlaneHeaders: () => ({ "content-type": "application/json" }),
      ensureCreditAccountForUser: async () => undefined,
      loadWalletSnapshotForUser: async () => null
    } as never);
    await enrollApp.ready();
  });

  const enroll = (payload: Record<string, unknown>) => enrollApp.inject({ method: "POST", url: "/nodes/enroll", payload: { nodeKind: "agent", ...payload } });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it("refuses another user's node ID with 409 and links nothing", async () => {
    const r = await enroll({ nodeId: "victim-agent" });
    expect(r.statusCode).toBe(409);
    await settle();
    expect(links).toEqual([]);
    expect(nodes.get("victim-agent").ownerUserId).toBe("victim");
  });

  it("refuses another user's node ID even when the device ID is the caller's own (redirect)", async () => {
    expect((await enroll({ nodeId: "attacker-agent", deviceId: "attacker-device" })).statusCode).toBe(200);
    await vi.waitFor(() => expect(links).toHaveLength(1));
    links.length = 0;

    const r = await enroll({ nodeId: "victim-agent", deviceId: "attacker-device" });
    expect(r.statusCode).toBe(409);
    await settle();
    expect(links.find((l) => l.agentId === "victim-agent")).toBeUndefined();
    expect(links).toEqual([]);
    expect(nodes.get("victim-agent").ownerUserId).toBe("victim");
  });

  it("refuses another user's device ID with 409", async () => {
    const r = await enroll({ nodeId: "fresh-agent", deviceId: "victim-device" });
    expect(r.statusCode).toBe(409);
    await settle();
    expect(links).toEqual([]);
    expect(nodes.has("fresh-agent")).toBe(false);
  });

  it("enrolls and links the caller's own node", async () => {
    const r = await enroll({ nodeId: "attacker-agent", deviceId: "attacker-device" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, nodeId: "attacker-agent" });
    await vi.waitFor(() => expect(links).toEqual([{ accountId: "acct-attacker", agentId: "attacker-agent", ownerUserId: "attacker" }]));

    // Re-enrolling with a new node ID on the same device links the canonical (owned) node only.
    links.length = 0;
    const again = await enroll({ nodeId: "attacker-agent-2", deviceId: "attacker-device" });
    expect(again.statusCode).toBe(200);
    expect(again.json().nodeId).toBe("attacker-agent");
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(links[0].agentId).toBe("attacker-agent");
  });

  it("dashboard self-heal links only the caller's own nodes", async () => {
    await enroll({ nodeId: "attacker-agent" });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    links.length = 0;
    const r = await enrollApp.inject({ method: "GET", url: "/dashboard/summary" });
    expect(r.statusCode).toBe(200);
    await vi.waitFor(() => expect(links).toHaveLength(1));
    expect(links).toEqual([{ accountId: "acct-attacker", agentId: "attacker-agent", ownerUserId: "attacker" }]);
  });
});

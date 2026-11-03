import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAccountApiRoutes } from "../../src/portal/routes/account.js";
import { hashApiKey } from "../../src/portal/routes/hosted.js";

describe("POST /nodes/enroll accepts a portal API key", () => {
  const setup = () => {
    const users: Record<string, { userId: string; email: string; emailVerified: boolean }> = {
      u1: { userId: "u1", email: "a@x.io", emailVerified: true },
      u2: { userId: "u2", email: "b@x.io", emailVerified: false },
    };
    const keys = new Map([[hashApiKey("eck_good"), "u1"], [hashApiKey("eck_unverified"), "u2"]]);
    const nodes = new Map<string, any>();
    const store = {
      userForApiKeyHash: async (h: string) => keys.get(h) ?? null,
      getUserById: async (id: string) => users[id] ?? null,
      getNodeEnrollment: async (id: string) => nodes.get(id) ?? null,
      getNodeEnrollmentByDeviceId: async () => null,
      upsertNodeEnrollment: async (r: any) => {
        const prev = nodes.get(r.nodeId);
        if (prev && prev.ownerUserId !== r.ownerUserId) return null;
        const rec = { ...r, nodeApproved: prev?.nodeApproved ?? false, active: false };
        nodes.set(r.nodeId, rec);
        return rec;
      },
      setNodeApproval: async (id: string, v: boolean) => ({ ...nodes.get(id), nodeApproved: v }),
    };
    const app = Fastify();
    registerAccountApiRoutes(app, {
      store,
      getCurrentUser: async (req: any) => (req.headers.authorization === "Bearer session-tok" ? users.u1 : null),
      sha256Hex: (s: string) => `h(${s})`,
      deriveIosDeviceIdFromNodeId: () => undefined,
    } as never);
    return { app, nodes };
  };
  const enroll = (app: ReturnType<typeof Fastify>, auth: string | undefined, nodeId = "box-gpu0") =>
    app.inject({ method: "POST", url: "/nodes/enroll", headers: auth ? { authorization: auth } : {}, payload: { nodeId, nodeKind: "agent" } });

  it("enrols as the key's user and approves agents for a verified email", async () => {
    const { app, nodes } = setup();
    const r = await enroll(app, "Bearer eck_good");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, nodeId: "box-gpu0", nodeApproved: true, emailVerified: true });
    expect(r.json().registrationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(nodes.get("box-gpu0").ownerUserId).toBe("u1");
  });

  it("refuses a bad or missing key", async () => {
    const { app } = setup();
    expect((await enroll(app, "Bearer eck_wrong")).statusCode).toBe(401);
    expect((await enroll(app, undefined)).statusCode).toBe(401);
  });

  it("keeps session tokens working, plus ownership and email gating", async () => {
    const { app } = setup();
    expect((await enroll(app, "Bearer session-tok")).statusCode).toBe(200);
    expect((await enroll(app, "Bearer eck_unverified", "box-gpu0")).statusCode).toBe(409);
    const r = await enroll(app, "Bearer eck_unverified", "other");
    expect(r.statusCode).toBe(200);
    expect(r.json().nodeApproved).toBe(false);
  });
});

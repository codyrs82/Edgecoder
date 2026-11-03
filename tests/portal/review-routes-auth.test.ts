import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerReviewRoutes } from "../../src/portal/routes/reviews.js";

/** /portal/api/reviews proxies every task's escalation with the service token: operators only, no upstream text to clients. */
describe("portal review routes", () => {
  const coordinator = Fastify();
  let portal: FastifyInstance;
  const decisions: unknown[] = [];
  const users: Record<string, { userId: string; email: string; admin: boolean }> = {
    "Bearer user": { userId: "u1", email: "u@x.io", admin: false },
    "Bearer admin": { userId: "a1", email: "a@x.io", admin: true }
  };

  beforeAll(async () => {
    coordinator.get("/escalate", async () => ({ escalations: [{ taskId: "t1", status: "pending", request: { task: "fix it", language: "python" } }] }));
    coordinator.get("/escalate/:taskId", async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      if (taskId === "boom") return reply.code(500).send("internal stack trace at /srv/coordinator.ts:123");
      return { taskId, status: "pending", request: { task: "fix it", failedCode: "print(1" } };
    });
    coordinator.post("/escalate/:taskId/result", async (req) => {
      decisions.push(req.body);
      return { ok: true, internal: "coordinator-internal-detail" };
    });
    await coordinator.listen({ port: 0, host: "127.0.0.1" });
    const addr = coordinator.server.address() as { port: number };
    portal = Fastify();
    registerReviewRoutes(portal, {
      EXTERNAL_HTTP_TIMEOUT_MS: 5_000,
      PORTAL_SERVICE_TOKEN: "svc",
      buildAccessContext: async (u: { userId: string }) => ({ isSystemAdmin: u.userId === "a1", isCoordinatorAdmin: false }),
      discoverCoordinatorUrlsForPortal: async () => [`http://127.0.0.1:${addr.port}`],
      getCurrentUser: async (req: any) => users[String(req.headers.authorization)] ?? null,
      store: {}
    } as never);
  });
  afterAll(async () => {
    await portal.close();
    await coordinator.close();
  });

  it("requires a session, then an operator, on every route", async () => {
    for (const [method, url] of [["GET", "/portal/api/reviews"], ["GET", "/portal/api/reviews/t1"], ["POST", "/portal/api/reviews/t1/decision"]] as const) {
      const payload = method === "POST" ? { decision: "accept" } : undefined;
      expect((await portal.inject({ method, url, payload })).statusCode).toBe(401);
      const res = await portal.inject({ method, url, payload, headers: { authorization: "Bearer user" } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "operator_only" });
    }
    expect(decisions).toHaveLength(0);
  });

  it("lets an operator list, read and decide", async () => {
    const auth = { authorization: "Bearer admin" };
    const list = await portal.inject({ url: "/portal/api/reviews", headers: auth });
    expect(list.json().reviews[0]).toMatchObject({ taskId: "t1", task: "fix it" });
    const one = await portal.inject({ url: "/portal/api/reviews/t1", headers: auth });
    expect(one.json()).toMatchObject({ taskId: "t1", failedCode: "print(1" });
    const dec = await portal.inject({ method: "POST", url: "/portal/api/reviews/t1/decision", headers: auth, payload: { decision: "reject" } });
    expect(dec.statusCode).toBe(200);
    expect(dec.json()).toEqual({ ok: true });
    expect(decisions).toHaveLength(1);
  });

  it("returns a fixed error instead of the coordinator's response text", async () => {
    const res = await portal.inject({ url: "/portal/api/reviews/boom", headers: { authorization: "Bearer admin" } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "coordinator_error" });
    expect(res.body).not.toContain("stack trace");
  });
});

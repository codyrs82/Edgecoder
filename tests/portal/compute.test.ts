import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { registerChatApiRoutes } from "../../src/portal/routes/chat.js";
import { computeLabel, computeOptions, networkTargetFor, registerComputeRoutes, timeLeft } from "../../src/portal/routes/compute.js";

describe("compute helpers", () => {
  it("labels where a chat runs", () => {
    expect(computeLabel({ target: "network", model: "qwen3.5:9b", computeClass: "gpu" })).toBe("Network · qwen3.5:9b · GPU");
    expect(computeLabel({ target: "network", model: "qwen3.5:9b", computeClass: "any" })).toBe("Network · qwen3.5:9b");
    expect(computeLabel({ target: "mine", model: "qwen2.5-coder:7b" })).toBe("My machines · qwen2.5-coder:7b");
    expect(computeLabel({ target: "reserved", model: "m", reservationId: "res-1", computeClass: "gpu.dc" })).toBe("Reserved Datacenter GPU · m");
  });

  it("maps a choice to the network backend's target", () => {
    expect(networkTargetFor({ target: "network", model: "m" })).toEqual({ model: "m", computeClass: "any" });
    expect(networkTargetFor({ target: "network", model: "m", computeClass: "apple" })).toEqual({ model: "m", computeClass: "apple" });
    expect(networkTargetFor({ target: "mine", model: "m" })).toEqual({ model: "m", target: "mine" });
    expect(networkTargetFor({ target: "reserved", model: "m", reservationId: "res-1", computeClass: "gpu" })).toEqual({ model: "m", reservationId: "res-1" });
  });

  it("says how long a lease has left", () => {
    expect(timeLeft(10 * 60_000 + 5, 0)).toBe("10 min left");
    expect(timeLeft(65 * 60_000, 0)).toBe("1 h 5 min left");
    expect(timeLeft(120 * 60_000, 0)).toBe("2 h left");
    expect(timeLeft(30_000, 0)).toBe("ending");
  });

  it("lists leases first, then the network per model and class, then your machines", () => {
    const now = 1_000_000;
    const opts = computeOptions(
      [{ model: "qwen3.5:9b", agents: 3, classes: ["gpu", "cpu"] }],
      { gpu: { cSatsPerSecondBaseTier: 0.05 }, cpu: { cSatsPerSecondBaseTier: 0.01 } },
      [
        { id: "res-1", computeClass: "gpu", status: "active", endMs: now + 20 * 60_000, models: ["qwen2.5-coder:32b"] },
        { id: "res-0", computeClass: "gpu", status: "ended", endMs: now - 1, models: ["x"] },
      ],
      now,
    );
    expect(opts.map((o) => [o.group, o.label])).toEqual([
      ["reserved", "Reserved GPU · qwen2.5-coder:32b"],
      ["network", "Network · qwen3.5:9b"],
      ["network", "Network · qwen3.5:9b · GPU"],
      ["network", "Network · qwen3.5:9b · CPU"],
      ["mine", "My machines · qwen3.5:9b"],
    ]);
    expect(opts[0].detail).toBe("20 min left · prepaid");
    expect(opts[0].compute).toEqual({ target: "reserved", model: "qwen2.5-coder:32b", reservationId: "res-1", computeClass: "gpu" });
    expect(opts[1].detail).toBe("3 machines · from 0.010 cSats/s");
    expect(opts[2].detail).toBe("0.050 cSats/s");
    expect(new Set(opts.map((o) => o.id)).size).toBe(opts.length);
  });
});

/** A coordinator that answers like the real one for the routes the portal calls. */
async function fakeCoordinator() {
  const seen: Array<{ path: string; body: any; token: unknown }> = [];
  const co = Fastify();
  const note = (req: any) => seen.push({ path: req.url, body: req.body, token: req.headers["x-portal-service-token"] });
  co.post("/account/summary", async (req) => (note(req), { accountId: (req.body as any).accountId, cSats: 1970.5, earnedSats: 12, recent: [{ type: "spend", cSats: 2, reason: "inference", atMs: 1 }] }));
  co.get("/inference/models", async (req) => (note(req), { models: [{ model: "qwen3.5:9b", agents: 2, classes: ["gpu"] }], classes: { gpu: { label: "GPU", cSatsPerSecondBaseTier: 0.05 } } }));
  co.post("/account/reservations/list", async (req) => (note(req), { reservations: [{ id: "res-1", computeClass: "gpu", status: "active", startMs: Date.now(), endMs: Date.now() + 600_000, models: ["qwen3.5:9b"] }], options: { gpu: { available: 1, cSatsPerSecond: 0.05, tiers: [], models: ["qwen3.5:9b"] } }, minMinutes: 5, maxMinutes: 1440 }));
  co.post("/account/reservations", async (req, reply) => {
    note(req);
    if ((req.body as any).minutes > 600) return reply.code(402).send({ error: "insufficient_credits", neededCSats: 1800 });
    return { reservation: { id: "res-2", computeClass: (req.body as any).computeClass, status: "active" } };
  });
  co.post("/account/reservations/cancel", async (req) => (note(req), { reservation: { id: (req.body as any).reservationId, status: "ended", refundCSats: 3 } }));
  co.post("/inference/submit", async (req, reply) => {
    note(req);
    if ((req.body as any).model === "broke") return reply.code(402).send({ error: "insufficient_credits", neededCSats: 9 });
    return { subtaskId: "sub-1" };
  });
  co.post("/inference/stream", async (req) => (note(req), { chunks: ["Hel", "lo"], next: 2, done: true, creditsSpent: 0.42 }));
  await co.listen({ port: 0, host: "127.0.0.1" });
  const addr = co.server.address() as { port: number };
  return { co, seen, url: `http://127.0.0.1:${addr.port}` };
}

describe("portal compute routes", () => {
  let coord: Awaited<ReturnType<typeof fakeCoordinator>>;
  let app: FastifyInstance;
  const store = {
    getConversationOwner: vi.fn(async () => "u1"),
    addMessage: vi.fn(async () => undefined),
    getConversationMessages: vi.fn(async () => [{ role: "user", content: "hi" }]),
  };
  beforeAll(async () => {
    coord = await fakeCoordinator();
    app = Fastify();
    const deps = {
      store: store as never,
      getCurrentUser: async (req: { headers: Record<string, unknown> }) => (req.headers.cookie === "session" ? ({ userId: "u1" } as never) : null),
      PORTAL_SERVICE_TOKEN: "svc",
      discoverCoordinatorUrlsForPortal: async () => [coord.url],
    };
    registerComputeRoutes(app, deps);
    registerChatApiRoutes(app, deps as never);
  });
  afterAll(async () => {
    await app.close();
    await coord.co.close();
  });
  const auth = { cookie: "session" };

  it("needs a signed-in user", async () => {
    for (const [method, url] of [["GET", "/portal/api/compute/summary"], ["GET", "/portal/api/compute/reservations"], ["POST", "/portal/api/compute/reservations"], ["GET", "/portal/api/compute/options"]] as const) {
      expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, url).toBe(401);
    }
  });

  it("shows the account's cSats balance from the coordinator", async () => {
    const r = await app.inject({ url: "/portal/api/compute/summary", headers: auth });
    expect(r.json()).toMatchObject({ connected: true, cSats: 1970.5, earnedSats: 12, classes: { gpu: { cSatsPerSecondBaseTier: 0.05 } } });
    const call = coord.seen.find((s) => s.path === "/account/summary");
    expect(call).toMatchObject({ body: { accountId: "acct-u1" }, token: "svc" });
  });

  it("reserves, lists and cancels for the user's account only", async () => {
    const list = await app.inject({ url: "/portal/api/compute/reservations", headers: auth });
    expect(list.json().options.gpu.available).toBe(1);
    const made = await app.inject({ method: "POST", url: "/portal/api/compute/reservations", headers: auth, payload: { computeClass: "gpu", minutes: 30, model: "qwen3.5:9b", accountId: "acct-someone-else" } });
    expect(made.statusCode).toBe(200);
    expect(coord.seen.filter((s) => s.path === "/account/reservations").at(-1)!.body).toEqual({ computeClass: "gpu", minutes: 30, model: "qwen3.5:9b", accountId: "acct-u1" });
    const broke = await app.inject({ method: "POST", url: "/portal/api/compute/reservations", headers: auth, payload: { computeClass: "gpu", minutes: 900 } });
    expect(broke.statusCode).toBe(402);
    expect(broke.json()).toEqual({ error: "insufficient_credits", neededCSats: 1800 });
    expect((await app.inject({ method: "POST", url: "/portal/api/compute/reservations", headers: auth, payload: { computeClass: "tpu", minutes: 30 } })).statusCode).toBe(400);
    const cancelled = await app.inject({ method: "POST", url: "/portal/api/compute/reservations/cancel", headers: auth, payload: { reservationId: "res-1" } });
    expect(cancelled.json().reservation.refundCSats).toBe(3);
    expect(coord.seen.filter((s) => s.path === "/account/reservations/cancel").at(-1)!.body).toEqual({ reservationId: "res-1", accountId: "acct-u1" });
  });

  it("offers the chat picker's options", async () => {
    const r = await app.inject({ url: "/portal/api/compute/options", headers: auth });
    const labels = r.json().options.map((o: { label: string }) => o.label);
    expect(labels).toEqual(["Reserved GPU · qwen3.5:9b", "Network · qwen3.5:9b", "Network · qwen3.5:9b · GPU", "My machines · qwen3.5:9b"]);
  });

  it("runs a chat on the chosen network compute, billed to the account, and reports the cost", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/portal/api/chat",
      headers: auth,
      payload: { conversationId: "c1", message: "hi", compute: { target: "network", model: "qwen3.5:9b", computeClass: "gpu" } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('data: {"content":"Hel"}');
    expect(r.body).toContain('"cSatsSpent":0.42');
    expect(r.body).toContain('"compute":"Network · qwen3.5:9b · GPU"');
    expect(r.body.trim().endsWith("data: [DONE]")).toBe(true);
    const submit = coord.seen.filter((s) => s.path === "/inference/submit").at(-1)!;
    expect(submit.body).toMatchObject({ submitterAccountId: "acct-u1", model: "qwen3.5:9b", computeClass: "gpu", messages: [{ role: "user", content: "hi" }] });
    expect(store.addMessage).toHaveBeenLastCalledWith(expect.objectContaining({ role: "assistant", content: "Hello", creditsSpent: 0.42 }));
  });

  it("sends a reservation and 'mine' through, and refuses with a plain HTTP error", async () => {
    await app.inject({ method: "POST", url: "/portal/api/chat", headers: auth, payload: { conversationId: "c1", message: "hi", compute: { target: "reserved", model: "m", reservationId: "res-1" } } });
    expect(coord.seen.filter((s) => s.path === "/inference/submit").at(-1)!.body).toMatchObject({ reservationId: "res-1", model: "m" });
    await app.inject({ method: "POST", url: "/portal/api/chat", headers: auth, payload: { conversationId: "c1", message: "hi", compute: { target: "mine", model: "m" } } });
    expect(coord.seen.filter((s) => s.path === "/inference/submit").at(-1)!.body).toMatchObject({ target: "mine" });
    const broke = await app.inject({ method: "POST", url: "/portal/api/chat", headers: auth, payload: { conversationId: "c1", message: "hi", compute: { target: "network", model: "broke" } } });
    expect(broke.statusCode).toBe(402);
    expect(broke.json().error).toMatch(/Not enough cSats/);
    // A reservation needs its id.
    expect((await app.inject({ method: "POST", url: "/portal/api/chat", headers: auth, payload: { conversationId: "c1", message: "hi", compute: { target: "reserved", model: "m" } } })).statusCode).toBe(400);
  });
});

describe("portal shell and chat page markup", () => {
  it("puts a profile row with an account menu at the bottom of the sidebar", async () => {
    const app = Fastify();
    registerPortalPages(app);
    for (const url of ["/portal/dashboard", "/portal/chat", "/portal/settings", "/portal/settings/plan"]) {
      const html = (await app.inject({ url })).body;
      expect(html, url).toContain('id="profileBtn"');
      expect(html, url).toContain('aria-haspopup="menu"');
      expect(html, url).toContain('id="accountMenu" role="menu"');
      expect(html, url).toContain('id="profileGear"');
      expect(html, url).not.toContain("balance-chip");
      for (const label of ["Profile", "Plan &amp; usage", "Usage", "Compute", "Connect your tools", "Install agent", "Settings", "Admin", "Docs", "Log out"]) expect(html, `${url} ${label}`).toContain(`<span>${label}</span>`);
      expect(html, url).toContain('"/portal/api/compute/summary"');
    }
    const chat = (await app.inject({ url: "/portal/chat" })).body;
    expect(chat).toContain('id="computeSearch"');
    expect(chat).toContain('"/portal/api/compute/options"');
    expect(chat).toContain('"edgecoder.chat.compute."');
    await app.close();
  });
});

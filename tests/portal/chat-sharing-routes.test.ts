import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerChatSharingRoutes } from "../../src/portal/routes/chat-sharing.js";

function setup() {
  const flags = new Map<string, { share: boolean; at: number }>();
  const store = {
    getChatSharing: async (userId: string) => {
      const f = flags.get(userId);
      return { shareChatForImprovement: f?.share ?? false, updatedAtMs: f?.at ?? null };
    },
    setChatSharing: async (userId: string, share: boolean, atMs = 0) => void flags.set(userId, { share, at: atMs })
  };
  const app = Fastify();
  registerChatSharingRoutes(app, {
    store,
    getCurrentUser: async (req: { headers: Record<string, unknown> }) => {
      const m = /sess=(\w+)/.exec(String(req.headers.cookie ?? ""));
      return m ? { userId: m[1] } : null;
    }
  });
  return { app, flags };
}

describe("GET/PUT /me/chat-sharing", () => {
  it("is off by default and can be turned on and off, per user", async () => {
    const { app, flags } = setup();
    const get = async (u: string) => (await app.inject({ method: "GET", url: "/me/chat-sharing", headers: { cookie: `sess=${u}` } })).json();
    expect(await get("u1")).toEqual({ shareChatForImprovement: false, updatedAtMs: null });

    const on = await app.inject({ method: "PUT", url: "/me/chat-sharing", headers: { cookie: "sess=u1" }, payload: { shareChatForImprovement: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().shareChatForImprovement).toBe(true);
    expect((await get("u1")).shareChatForImprovement).toBe(true);
    expect((await get("u2")).shareChatForImprovement).toBe(false);

    await app.inject({ method: "PUT", url: "/me/chat-sharing", headers: { cookie: "sess=u1" }, payload: { shareChatForImprovement: false } });
    expect((await get("u1")).shareChatForImprovement).toBe(false);
    expect(flags.get("u1")!.at).toBeGreaterThan(0);
  });

  it("needs a session and a boolean", async () => {
    const { app, flags } = setup();
    expect((await app.inject({ method: "GET", url: "/me/chat-sharing" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/me/chat-sharing", payload: { shareChatForImprovement: true } })).statusCode).toBe(401);
    for (const payload of [{ shareChatForImprovement: "yes" }, {}, { shareChatForImprovement: true, userId: "u2" }]) {
      const r = await app.inject({ method: "PUT", url: "/me/chat-sharing", headers: { cookie: "sess=u1" }, payload });
      expect(r.statusCode).toBe(400);
    }
    expect(flags.size).toBe(0);
  });

  it("503 without a database", async () => {
    const app = Fastify();
    registerChatSharingRoutes(app, { store: null, getCurrentUser: async () => ({ userId: "u1" }) });
    expect((await app.inject({ method: "GET", url: "/me/chat-sharing" })).statusCode).toBe(503);
  });
});

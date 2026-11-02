import cors from "@fastify/cors";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { writeSseHead } from "../../src/common/sse.js";

describe("writeSseHead", () => {
  it("keeps the CORS headers on a hand-written event stream (the desktop webview needs them)", async () => {
    const app = Fastify();
    await app.register(cors, { origin: ["tauri://localhost"] });
    app.post("/stream", (_req, reply) => {
      writeSseHead(reply);
      reply.raw.write("data: hi\n\n");
      reply.raw.end();
    });
    const res = await app.inject({ method: "POST", url: "/stream", headers: { origin: "tauri://localhost" } });
    expect(res.headers["access-control-allow-origin"]).toBe("tauri://localhost");
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toBe("data: hi\n\n");
    await app.close();
  });
});

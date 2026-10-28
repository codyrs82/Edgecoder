import Fastify from "fastify";
import { MockAgent, request } from "undici";
import { describe, expect, it } from "vitest";
import { currentRequestId, exposeRequestId, internalOrigins, requestIdInterceptor } from "../../src/common/http-logging.js";

describe("request-id forwarding (#14)", () => {
  it("collects internal origins from service URLs", () => {
    const o = internalOrigins({
      CONTROL_PLANE_URL: "https://control.example/x",
      COORDINATOR_DISCOVERY_URLS: "https://a.example, https://b.example",
      INFERENCE_URL: "not a url"
    });
    expect([...o].sort()).toEqual(["https://a.example", "https://b.example", "https://control.example"]);
  });

  it("forwards the current request id to internal origins only", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const seen: Record<string, unknown> = {};
    for (const origin of ["https://control.example", "https://api.resend.com"]) {
      agent
        .get(origin)
        .intercept({ path: "/x", method: "GET" })
        .reply(200, (opts) => {
          const h = opts.headers as unknown;
          if (Array.isArray(h)) {
            const i = h.findIndex((v, j) => j % 2 === 0 && String(v).toLowerCase() === "x-request-id");
            seen[origin] = i >= 0 ? h[i + 1] : undefined;
          } else {
            seen[origin] = (h as Record<string, string> | undefined)?.["x-request-id"];
          }
          return "ok";
        });
    }
    const dispatcher = agent.compose(requestIdInterceptor(new Set(["https://control.example"])));

    const app = Fastify({ genReqId: () => "req-12345678" });
    exposeRequestId(app);
    app.get("/", async () => {
      expect(currentRequestId()).toBe("req-12345678");
      await (await request("https://control.example/x", { dispatcher })).body.text();
      await (await request("https://api.resend.com/x", { dispatcher })).body.text();
      return { ok: true };
    });
    const res = await app.inject({ url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("req-12345678");
    expect(seen["https://control.example"]).toBe("req-12345678");
    expect(seen["https://api.resend.com"]).toBeUndefined();
    expect(currentRequestId()).toBeUndefined();
  });
});

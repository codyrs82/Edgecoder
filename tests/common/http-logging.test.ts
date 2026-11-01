import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { exposeRequestId, redactUrl, requestIdFrom, serviceLoggerOptions } from "../../src/common/http-logging.js";
import { redactMeta } from "../../src/common/logger.js";
import { anchorProxyHealth, rpcHostForLog } from "../../src/economy/anchor-proxy-health.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      cb();
    }
  });
  return { lines, stream };
}

describe("service logging (#14)", () => {
  it("keeps a sane incoming request id and generates one otherwise", () => {
    expect(requestIdFrom("abc-12345678")).toBe("abc-12345678");
    expect(requestIdFrom("bad id with spaces")).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom("x".repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs JSON with service + requestId, echoes x-request-id, and redacts secrets", async () => {
    const { lines, stream } = capture();
    const opts = serviceLoggerOptions("test-svc");
    const app = Fastify({ ...opts, logger: { ...(opts.logger as object), stream } });
    exposeRequestId(app);
    app.post("/x", async (req) => {
      req.log.info({ body: req.body, headers: req.headers }, "handled");
      return { ok: true };
    });
    const res = await app.inject({
      method: "POST",
      url: "/x",
      headers: { "x-request-id": "trace-0001-abcd", authorization: "Bearer s3cr3t", "x-mesh-token": "m3sh" },
      payload: { token: "tok-value", password: "pw-value", note: "visible" }
    });
    expect(res.headers["x-request-id"]).toBe("trace-0001-abcd");
    const all = lines.join("\n");
    expect(all).not.toContain("s3cr3t");
    expect(all).not.toContain("m3sh");
    expect(all).not.toContain("tok-value");
    expect(all).not.toContain("pw-value");
    expect(all).toContain("visible");
    const handled = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "handled");
    expect(handled).toMatchObject({ service: "test-svc", requestId: "trace-0001-abcd" });
    await app.close();
  });
});


describe("log meta redaction (#14)", () => {
  it("redacts secret keys at any depth", () => {
    expect(redactMeta({ a: 1, token: "t", nested: { headers: { "x-mesh-token": "m", Authorization: "b" }, list: [{ password: "p" }] } })).toEqual({
      a: 1,
      token: "[redacted]",
      nested: { headers: { "x-mesh-token": "[redacted]", Authorization: "[redacted]" }, list: [{ password: "[redacted]" }] }
    });
  });
});

describe("redaction review fixes (#128)", () => {
  it("catches key variants case-insensitively and keeps numbers", () => {
    const out = redactMeta({ accessToken: "a", refreshToken: "b", api_key: "c", privateKey: "d", xprv: "e", Password: "f", seed: "g", tokensUsed: 42 }) as Record<string, unknown>;
    for (const k of ["accessToken", "refreshToken", "api_key", "privateKey", "xprv", "Password", "seed"]) expect(out[k], k).toBe("[redacted]");
    expect(out.tokensUsed).toBe(42);
  });

  it("truncates instead of leaking past max depth, and keeps Date as ISO", () => {
    let deep: Record<string, unknown> = { mnemonic: "leak" };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(JSON.stringify(redactMeta(deep))).not.toContain("leak");
    expect(JSON.stringify(redactMeta(deep))).toContain("[truncated]");
    expect(redactMeta({ at: new Date(0) })).toEqual({ at: "1970-01-01T00:00:00.000Z" });
  });

  it("masks secret query values", () => {
    expect(redactUrl("/ws?token=abc&room=1")).toBe("/ws?token=%5Bredacted%5D&room=1");
    expect(redactUrl("/plain?room=1")).toBe("/plain?room=1");
  });

  it("deep body secrets and query tokens never reach Fastify logs", async () => {
    const { lines, stream } = capture();
    const opts = serviceLoggerOptions("t");
    const app = Fastify({ ...opts, logger: { ...(opts.logger as object), stream } });
    app.post("/x", async (req) => {
      req.log.info({ body: req.body }, "b");
      return {};
    });
    await app.inject({ method: "POST", url: "/x?apiToken=q1w2e3", payload: { wallet: { keys: { mnemonic: "abandon abandon" } } } });
    const all = lines.join("\n");
    expect(all).not.toContain("abandon abandon");
    expect(all).not.toContain("q1w2e3");
    await app.close();
  });
});

describe("anchor-proxy /health (#128 must-fix)", () => {
  it("returns 503 when bitcoind is unreachable (healthCheck doesn't throw)", async () => {
    const r = await anchorProxyHealth({ healthCheck: async () => ({ reachable: false, provider: "bitcoind" }) }, "signet");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, error: "bitcoind_unreachable" });
  });
  it("returns 503 when healthCheck throws, 200 when reachable", async () => {
    expect((await anchorProxyHealth({ healthCheck: async () => { throw new Error("x"); } }, "signet")).status).toBe(503);
    const ok = await anchorProxyHealth({ healthCheck: async () => ({ reachable: true, chain: "signet", blocks: 5, provider: "bitcoind" }) }, "signet");
    expect(ok).toMatchObject({ status: 200, body: { ok: true, chain: "signet", blocks: 5 } });
  });
  it("logs only the RPC host", () => {
    expect(rpcHostForLog("http://user:pass@10.0.0.5:8332/wallet/x")).toBe("10.0.0.5:8332");
    expect(rpcHostForLog(undefined)).toBe("(invalid url)");
  });
});

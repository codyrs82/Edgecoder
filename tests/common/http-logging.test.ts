import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { exposeRequestId, requestIdFrom, serviceLoggerOptions } from "../../src/common/http-logging.js";

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

import { redactMeta } from "../../src/common/logger.js";

describe("log meta redaction (#14)", () => {
  it("redacts secret keys at any depth", () => {
    expect(redactMeta({ a: 1, token: "t", nested: { headers: { "x-mesh-token": "m", Authorization: "b" }, list: [{ password: "p" }] } })).toEqual({
      a: 1,
      token: "[redacted]",
      nested: { headers: { "x-mesh-token": "[redacted]", Authorization: "[redacted]" }, list: [{ password: "[redacted]" }] }
    });
  });
});

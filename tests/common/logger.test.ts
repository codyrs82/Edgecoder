import { Writable } from "node:stream";
import Fastify from "fastify";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { exposeRequestId, serviceLoggerOptions } from "../../src/common/http-logging.js";
import { createLogger, logLevel, loggerOptions } from "../../src/common/logger.js";
import { scrubText } from "../../src/common/redaction.js";
import { runWithRequestContext } from "../../src/common/request-context.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      cb();
    }
  });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, stream, parsed };
}

function service(name = "test-svc", env: NodeJS.ProcessEnv = {}) {
  const out = capture();
  const opts = serviceLoggerOptions(name, env);
  const app = Fastify({ ...opts, logger: { ...(opts.logger as object), stream: out.stream } });
  exposeRequestId(app);
  return { app, ...out };
}

describe("logger factory (#14)", () => {
  it("writes one JSON object per line with level, time, service and msg", () => {
    const { lines, stream, parsed } = capture();
    const logger = createLogger("svc", { destination: stream, env: {} });
    logger.info({ peers: 3 }, "mesh bootstrapped");
    logger.child({ component: "gossip" }).warn("slow peer");
    expect(lines).toHaveLength(2);
    const [first, second] = parsed();
    expect(first).toMatchObject({ level: 30, service: "svc", msg: "mesh bootstrapped", peers: 3 });
    expect(typeof first!.time).toBe("number");
    expect(second).toMatchObject({ level: 40, service: "svc", component: "gossip", msg: "slow peer" });
    // The platform tags the machine; pid/hostname would only add noise.
    expect(first).not.toHaveProperty("pid");
    expect(first).not.toHaveProperty("hostname");
    expect(first).not.toHaveProperty("requestId");
  });

  it("takes LOG_LEVEL, and falls back to info when it is not a level", () => {
    expect(logLevel({})).toBe("info");
    expect(logLevel({ LOG_LEVEL: "debug" })).toBe("debug");
    expect(logLevel({ LOG_LEVEL: " WARN " })).toBe("warn");
    expect(logLevel({ LOG_LEVEL: "silent" })).toBe("silent");
    expect(logLevel({ LOG_LEVEL: "verbose" })).toBe("info");
    expect(logLevel({ LOG_LEVEL: "" })).toBe("info");

    const { lines, stream } = capture();
    // pino throws on an unknown level; a typo in LOG_LEVEL must not stop a service from starting.
    const logger = createLogger("svc", { destination: stream, env: { LOG_LEVEL: "loud" } });
    logger.debug("hidden");
    logger.info("shown");
    expect(lines).toHaveLength(1);
    const debug = createLogger("svc", { destination: stream, env: { LOG_LEVEL: "debug" } });
    debug.debug("now shown");
    expect(lines).toHaveLength(2);
  });
});

describe("secrets never reach log output (#14)", () => {
  const SECRETS = {
    password: "PW-s3cret",
    token: "TOK-s3cret",
    accessToken: "ACCESS-s3cret",
    secret: "SEC-s3cret",
    clientSecret: "CLIENT-s3cret",
    mnemonic: "abandon ability able about",
    seed: "SEED-s3cret",
    seedPhrase: "SEEDPHRASE-s3cret",
    preimage: "PREIMAGE-s3cret",
    paymentPreimage: "PAYPRE-s3cret",
    apiKey: "APIKEY-s3cret",
    api_key: "API_KEY-s3cret",
    privateKey: "PRIV-s3cret",
    macaroon: "MACAROON-s3cret",
    signature: "SIG-s3cret"
  };
  const HEADERS = {
    authorization: "Bearer AUTHZ-s3cret-0123456789",
    "proxy-authorization": "Basic PROXY-s3cret",
    cookie: "sid=COOKIE-s3cret",
    "set-cookie": "sid=SETCOOKIE-s3cret; HttpOnly",
    "x-admin-token": "ADMIN-s3cret",
    "x-mesh-token": "MESH-s3cret",
    "x-inference-token": "INFER-s3cret",
    "x-portal-service-token": "PORTAL-s3cret",
    "x-api-key": "XAPIKEY-s3cret",
    "x-edgecoder-origin": "ORIGINLOCK-s3cret",
    "x-payment-signature": "PAYSIG-s3cret"
  };

  function expectClean(lines: string[]) {
    const all = lines.join("\n");
    expect(all).not.toContain("s3cret");
    expect(all).not.toContain("abandon ability");
  }

  it("redacts secret fields at the top level and nested, whatever the key they sit under", () => {
    const { lines, stream, parsed } = capture();
    const logger = createLogger("svc", { destination: stream, env: {} });
    logger.info({ ...SECRETS, note: "visible-top" }, "top level");
    logger.info({ body: SECRETS, query: SECRETS, note: "visible-nested" }, "body and query");
    logger.info({ a: { b: { c: { d: { e: [SECRETS, { headers: HEADERS }] } } } } }, "deep");
    logger.info({ wallet: new Map(Object.entries(SECRETS)) }, "map");
    expect(lines).toHaveLength(4);
    expectClean(lines);
    expect(lines.join("\n")).toContain("visible-top");
    expect(lines.join("\n")).toContain("visible-nested");
    expect(parsed()[0]).toMatchObject({ password: "[redacted]", preimage: "[redacted]", apiKey: "[redacted]", mnemonic: "[redacted]" });
  });

  it("redacts credential headers wherever headers are logged", () => {
    const { lines, stream, parsed } = capture();
    const logger = createLogger("svc", { destination: stream, env: {} });
    logger.info({ headers: { ...HEADERS, "user-agent": "curl/8" } }, "headers");
    logger.info({ req: { headers: HEADERS }, res: { headers: HEADERS }, upstream: { headers: HEADERS } }, "wrapped");
    // Node's raw header casing too.
    logger.info({ headers: { Authorization: HEADERS.authorization, Cookie: HEADERS.cookie, "X-Admin-Token": HEADERS["x-admin-token"] } }, "cased");
    expectClean(lines);
    expect((parsed()[0]!.headers as Record<string, string>)["user-agent"]).toBe("curl/8");
    expect((parsed()[0]!.headers as Record<string, string>).authorization).toBe("[redacted]");
  });

  it("scrubs credentials carried inside strings, messages and errors", () => {
    const { lines, stream, parsed } = capture();
    const logger = createLogger("svc", { destination: stream, env: {} });
    const rpc = "http://rpcuser:RPCPASS-s3cret@10.0.0.5:8332/wallet/main";
    logger.info({ url: rpc }, "string field");
    logger.warn(`could not reach ${rpc}`);
    logger.warn("retrying %s with %s", rpc, "Bearer BEARER-s3cret-0123456789");
    logger.error({ err: new Error(`connect failed: ${rpc}`) }, "error object");
    // No message given: pino falls back to the error's own.
    logger.error(new Error(`thrown with Bearer BEARER-s3cret-0123456789abcdef`));
    logger.error({ err: new Error(`wrapped ${rpc}`) });
    expect(lines).toHaveLength(6);
    expectClean(lines);
    expect(parsed()[0]!.url).toBe("http://[redacted]@10.0.0.5:8332/wallet/main");
    expect(parsed()[3]!.err).toMatchObject({ name: "Error", message: "connect failed: http://[redacted]@10.0.0.5:8332/wallet/main" });
    expect(parsed()[4]!.msg).toBe("thrown with Bearer [redacted]");
    expect(parsed()[5]!.msg).toBe("wrapped http://[redacted]@10.0.0.5:8332/wallet/main");
    // Prose about tokens is left alone.
    expect(scrubText("Bearer token required")).toBe("Bearer token required");
  });
});

describe("request logging (#14)", () => {
  it("puts the request id on every request line and echoes it", async () => {
    const { app, parsed } = service();
    app.get("/nodes/:id", async (req) => {
      req.log.info("from req.log");
      req.log.child({ component: "handler" }).info("from a child of req.log");
      app.log.info("from app.log");
      return { ok: true };
    });
    const res = await app.inject({ url: "/nodes/7", headers: { "x-request-id": "trace-0001-abcd" } });
    expect(res.headers["x-request-id"]).toBe("trace-0001-abcd");
    const lines = parsed();
    expect(lines.map((l) => l.msg)).toEqual([
      "incoming request",
      "from req.log",
      "from a child of req.log",
      "from app.log",
      "request completed"
    ]);
    for (const line of lines) expect(line, String(line.msg)).toMatchObject({ service: "test-svc", requestId: "trace-0001-abcd" });
    await app.close();
  });

  it("writes the request id once per line", async () => {
    const { app, lines } = service();
    app.get("/x", async (req) => {
      req.log.info("a");
      app.log.info("b");
      return {};
    });
    await app.inject({ url: "/x" });
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line.match(/"requestId":/g), line).toHaveLength(1);
    await app.close();
  });

  it("accepts an inbound x-request-id only when it matches the strict pattern", async () => {
    const { app, parsed } = service();
    app.get("/x", async () => ({}));
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const good of ["trace-0001-abcd", "01HZX3K4M5N6P7Q8R9S0T1V2W3", "a.b:c_d-1234", "x".repeat(128)]) {
      expect((await app.inject({ url: "/x", headers: { "x-request-id": good } })).headers["x-request-id"], good).toBe(good);
    }
    for (const bad of ["short", "has space 12345", "x".repeat(129), 'quote"12345678', "semi;colon;12345", "<script>alert(1)</script>", "новый-идентификатор", "{json:12345678}", ""]) {
      const echoed = (await app.inject({ url: "/x", headers: { "x-request-id": bad } })).headers["x-request-id"];
      expect(echoed, bad).toMatch(uuid);
    }
    const generated = (await app.inject({ url: "/x" })).headers["x-request-id"];
    expect(generated).toMatch(uuid);
    expect(parsed().filter((l) => l.requestId === generated).map((l) => l.msg)).toEqual(["incoming request", "request completed"]);
    await app.close();
  });

  it("does not log request bodies or headers by default, and masks secret query values", async () => {
    const { app, lines, parsed } = service();
    app.post("/login", async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/login?token=QUERYTOKEN-s3cret&code=OAUTHCODE-s3cret&next=%2Fhome",
      headers: { authorization: "Bearer AUTHZ-s3cret-0123456789", cookie: "sid=COOKIE-s3cret", "x-admin-token": "ADMIN-s3cret", "user-agent": "UA-marker" },
      payload: { email: "BODY-marker@example.com", password: "PW-s3cret" }
    });
    expect(res.statusCode).toBe(200);
    const all = lines.join("\n");
    for (const absent of ["s3cret", "BODY-marker", "UA-marker", "example.com"]) expect(all, absent).not.toContain(absent);
    const incoming = parsed().find((l) => l.msg === "incoming request")!;
    // An allow-list: no headers, no body. (remotePort is absent under inject.)
    const allowed = new Set(["host", "method", "remoteAddress", "remotePort", "url"]);
    expect(Object.keys(incoming.req as object).filter((k) => !allowed.has(k))).toEqual([]);
    expect(incoming).not.toHaveProperty("body");
    expect((incoming.req as { url: string }).url).toBe("/login?token=%5Bredacted%5D&code=%5Bredacted%5D&next=%2Fhome");
    await app.close();
  });

  it("logs a failing request without its body", async () => {
    const { app, lines, parsed } = service();
    app.post("/boom", async () => {
      throw new Error("handler failed for http://u:DBPASS-s3cret@db:5432/app");
    });
    const res = await app.inject({ method: "POST", url: "/boom", payload: { mnemonic: "abandon ability able", note: "BODY-marker" } });
    expect(res.statusCode).toBe(500);
    const all = lines.join("\n");
    for (const absent of ["s3cret", "abandon ability", "BODY-marker"]) expect(all, absent).not.toContain(absent);
    const failed = parsed().find((l) => l.level === 50)!;
    expect(failed.requestId).toBe(res.headers["x-request-id"]);
    expect((failed.err as { message: string }).message).toBe("handler failed for http://[redacted]@db:5432/app");
    await app.close();
  });

  it("stamps module-logger lines with the request id and service of the request being handled", async () => {
    const out = capture();
    // Same options moduleLogger() builds its root from, with a capturing destination.
    const moduleLog = pino(loggerOptions(undefined, {}), out.stream).child({ component: "gossip" });
    const { app } = service("coordinator");
    app.get("/x", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      moduleLog.warn({ peerId: "p1" }, "inside a request");
      return {};
    });
    const res = await app.inject({ url: "/x" });
    moduleLog.info("outside a request");
    const [inside, outside] = out.parsed();
    expect(inside).toMatchObject({ component: "gossip", service: "coordinator", requestId: res.headers["x-request-id"], msg: "inside a request" });
    expect(out.lines[0]!.match(/"requestId":/g)).toHaveLength(1);
    expect(outside).toMatchObject({ component: "gossip", msg: "outside a request" });
    expect(outside).not.toHaveProperty("requestId");
    expect(typeof outside!.service).toBe("string");
    await app.close();
  });

  it("keeps concurrent requests' ids apart", async () => {
    const out = capture();
    const moduleLog = pino(loggerOptions(undefined, {}), out.stream);
    const seen = await Promise.all(
      ["req-aaaaaaa1", "req-bbbbbbb2", "req-ccccccc3"].map((requestId, i) =>
        runWithRequestContext({ requestId, service: "svc" }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5 - i));
          moduleLog.info({ expected: requestId }, "tick");
        })
      )
    );
    expect(seen).toHaveLength(3);
    for (const line of out.parsed()) expect(line.requestId).toBe(line.expected);
  });
});

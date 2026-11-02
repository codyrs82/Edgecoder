import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { IntelligentRouter, SwarmPostSubmitError, submitErrorWasNeverSent } from "../../src/model/router.js";

// #113: distinguish "submit failed" (release reservation) from "accepted, result lost" (count spend).
// #159: a timeout after the request was written is "possibly submitted", not a free release.
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

const SNAPSHOT = "a".repeat(40);

async function coordinator(
  handler: (req: { url: string; method: string; body: string }, res: import("node:http").ServerResponse) => void
): Promise<string> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler({ url: req.url ?? "", method: req.method ?? "", body }, res));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("routeSwarm submit errors (#113, #159)", () => {
  it("a rejected submit is a plain error", async () => {
    const url = await coordinator((_req, res) => json(res, 500, {}));
    const router = new IntelligentRouter({ coordinatorUrl: url, meshAuthToken: "t", agentAccountId: "a", resolveSnapshotRef: () => SNAPSHOT });
    const err = await router.routeSwarm("p").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SwarmPostSubmitError);
  });

  it("an accepted submit with no usable result is SwarmPostSubmitError", async () => {
    const url = await coordinator((_req, res) => json(res, 200, { taskId: "t1", subtasks: [] }));
    const router = new IntelligentRouter({ coordinatorUrl: url, meshAuthToken: "t", agentAccountId: "a", resolveSnapshotRef: () => SNAPSHOT });
    const err = await router.routeSwarm("p").catch((e) => e);
    expect(err).toBeInstanceOf(SwarmPostSubmitError);
    expect(typeof err.swarmTaskId).toBe("string");
  });

  it("a connection refused is a plain error (never sent), a headers timeout after send is post-submit (#159)", async () => {
    const refused = new IntelligentRouter({ coordinatorUrl: "http://127.0.0.1:1", meshAuthToken: "t", agentAccountId: "a", resolveSnapshotRef: () => SNAPSHOT });
    const refusedErr = await refused.routeSwarm("p").catch((e) => e);
    expect(refusedErr).toBeInstanceOf(Error);
    expect(refusedErr).not.toBeInstanceOf(SwarmPostSubmitError);

    expect(submitErrorWasNeverSent(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(submitErrorWasNeverSent(Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }))).toBe(true);
    expect(submitErrorWasNeverSent(Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" }))).toBe(false);
    expect(submitErrorWasNeverSent(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
    expect(submitErrorWasNeverSent(new Error("x"))).toBe(false);
  });

  it("posts to the coordinator's real /submit route with a snapshotRef and polls the result route", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    const url = await coordinator((req, res) => {
      seen.push({ url: req.url, method: req.method, body: req.body ? JSON.parse(req.body) : undefined });
      if (req.method === "POST" && req.url === "/submit") return json(res, 200, { taskId: (JSON.parse(req.body) as any).taskId, subtasks: ["st-1"] });
      if (req.method === "GET" && /^\/tasks\/[^/]+\/subtasks\/st-1\/result$/.test(req.url)) {
        return json(res, 200, { ok: true, output: "print(5)", creditsSpent: 1 });
      }
      json(res, 404, { error: "not_found" });
    });
    const router = new IntelligentRouter({ coordinatorUrl: url, meshAuthToken: "t", agentAccountId: "acct", resolveSnapshotRef: () => SNAPSHOT });
    const res = await router.routeSwarm("add 2 and 3");
    expect(res).toMatchObject({ text: "print(5)", creditsSpent: 1, route: "swarm" });
    const submit = seen.find((s) => s.method === "POST");
    expect(submit?.url).toBe("/submit");
    expect(submit?.body).toMatchObject({ prompt: "add 2 and 3", snapshotRef: SNAPSHOT, submitterAccountId: "acct", language: "python" });
    expect(seen.some((s) => s.method === "GET" && s.url.endsWith("/subtasks/st-1/result"))).toBe(true);
  }, 15_000);

  it("refuses to submit without a valid snapshot reference (nothing is sent)", async () => {
    let hits = 0;
    const url = await coordinator((_req, res) => { hits++; json(res, 200, {}); });
    delete process.env.IDE_SWARM_SNAPSHOT_REF;
    const router = new IntelligentRouter({ coordinatorUrl: url, meshAuthToken: "t", agentAccountId: "a", resolveSnapshotRef: () => "local" });
    const err = await router.routeSwarm("p").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SwarmPostSubmitError);
    expect(err.message).toMatch(/swarm_snapshot_ref_required/);
    expect(hits).toBe(0);
  });
});

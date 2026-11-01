import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { IntelligentRouter, SwarmPostSubmitError } from "../../src/model/router.js";

// #113: distinguish "submit failed" (release reservation) from "accepted, result lost" (count spend).
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function coordinator(status: number, body: string): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

describe("routeSwarm submit errors (#113)", () => {
  it("a rejected submit is a plain error", async () => {
    const url = await coordinator(500, "{}");
    const router = new IntelligentRouter({ coordinatorUrl: url, meshAuthToken: "t", agentAccountId: "a" });
    const err = await router.routeSwarm("p").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SwarmPostSubmitError);
  });

  it("an accepted submit with no usable result is SwarmPostSubmitError", async () => {
    const url = await coordinator(200, JSON.stringify({ taskId: "t1", subtasks: [] }));
    const router = new IntelligentRouter({ coordinatorUrl: url, meshAuthToken: "t", agentAccountId: "a" });
    const err = await router.routeSwarm("p").catch((e) => e);
    expect(err).toBeInstanceOf(SwarmPostSubmitError);
    expect(err.swarmTaskId).toBe("t1");
  });
});

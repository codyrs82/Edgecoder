import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { IntelligentRouter } from "../../src/model/router.js";

describe("IDE swarm route through the local agent", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("submits to the agent's forwarder with the IDE token, not the mesh token", async () => {
    const seen: Array<{ url?: string; auth?: string; mesh?: unknown; body: string }> = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, mesh: req.headers["x-mesh-token"], body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.url === "/forward/submit" ? JSON.stringify({ taskId: "t", subtasks: ["s1"] }) : JSON.stringify({ output: "done", ok: true, creditsSpent: 1 }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const router = new IntelligentRouter({
      localAgentUrl: url,
      localAgentToken: () => "ide-token",
      meshAuthToken: "",
      resolveSnapshotRef: () => "b".repeat(40)
    });
    expect(router.swarmEnabled).toBe(true);
    const result = await router.routeSwarm("write fizzbuzz");
    expect(result.text).toBe("done");
    expect(seen[0].url).toBe("/forward/submit");
    expect(seen[0].auth).toBe("Bearer ide-token");
    expect(seen[0].mesh).toBeUndefined();
    expect(seen[1].url).toMatch(/^\/forward\/tasks\/[^/]+\/subtasks\/s1\/result$/);
  }, 20_000);
});

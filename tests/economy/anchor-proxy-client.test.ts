import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AnchorProxyClientProvider } from "../../src/economy/bitcoin-rpc.js";

// #103 follow-up: reconciliation calls through the anchor proxy.
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

const TXID = "ab".repeat(32);

async function fakeProxy(handler: (method: string, url: string, body: string) => [number, unknown]): Promise<string> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer tok") {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const [status, json] = handler(req.method ?? "", req.url ?? "", body);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

describe("AnchorProxyClientProvider reconciliation (#103)", () => {
  it("find, mempool and abandon map to the proxy endpoints", async () => {
    const calls: string[] = [];
    const url = await fakeProxy((m, u, b) => {
      calls.push(`${m} ${u} ${b}`);
      if (u.startsWith("/anchor/find/")) return [200, { ok: true, txid: TXID }];
      if (u.startsWith("/anchor/mempool/")) return [200, { ok: true, inMempool: false }];
      if (u === "/anchor/abandon") return [200, { ok: true }];
      return [404, { error: "nf" }];
    });
    const p = new AnchorProxyClientProvider(url, "tok");
    expect(await p.findCheckpointTx("6a20ff")).toBe(TXID);
    expect(await p.isInMempool(TXID)).toBe(false);
    await p.abandonTx(TXID);
    expect(calls).toEqual([`GET /anchor/find/6a20ff `, `GET /anchor/mempool/${TXID} `, `POST /anchor/abandon {"txid":"${TXID}"}`]);
  });

  it("a definite miss is null; proxy errors and malformed replies throw", async () => {
    let reply: [number, unknown] = [200, { ok: true, txid: null }];
    const url = await fakeProxy(() => reply);
    const p = new AnchorProxyClientProvider(url, "tok");
    expect(await p.findCheckpointTx("6a")).toBeNull();
    reply = [502, { error: "find_failed" }];
    await expect(p.findCheckpointTx("6a")).rejects.toThrow(/anchor_proxy_error: 502/);
    reply = [200, { ok: true }];
    await expect(p.isInMempool(TXID)).rejects.toThrow(/invalid_response/);
    reply = [200, { done: true }];
    await expect(p.abandonTx(TXID)).rejects.toThrow(/abandon_invalid_response/);
  });
});

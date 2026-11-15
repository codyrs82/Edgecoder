import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A fake Ollama server: /api/version, /api/tags, /api/ps, /api/pull (NDJSON progress), /api/delete, /api/generate. */
export interface FakeOllama {
  url: string;
  models: Map<string, number>;
  loaded: Set<string>;
  calls: Array<{ method: string; path: string; body: any }>;
  /** Bytes a pulled model gets. */
  pullSizes: Map<string, number>;
  close(): Promise<void>;
}

export async function startFakeOllama(initial: Record<string, number> = {}): Promise<FakeOllama> {
  const models = new Map(Object.entries(initial));
  const loaded = new Set<string>();
  const calls: FakeOllama["calls"] = [];
  const pullSizes = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method ?? "", path: req.url ?? "", body });
      const json = (code: number, b: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.url === "/api/version") return json(200, { version: "0.40.7" });
      if (req.url === "/api/tags") return json(200, { models: [...models].map(([name, size]) => ({ name, size, modified_at: "2026-11-15T00:00:00Z" })) });
      if (req.url === "/api/ps") return json(200, { models: [...loaded].map((name) => ({ name, size: models.get(name) ?? 0, size_vram: models.get(name) ?? 0 })) });
      if (req.url === "/api/delete") {
        if (!models.delete(body.model)) return json(404, { error: "not found" });
        return json(200, {});
      }
      if (req.url === "/api/generate") {
        if (body.keep_alive === 0) loaded.delete(body.model);
        else loaded.add(body.model);
        return json(200, { done: true });
      }
      if (req.url === "/api/pull") {
        const total = pullSizes.get(body.model) ?? 1000;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
        res.write(JSON.stringify({ status: "pulling abc", total, completed: total / 2 }) + "\n");
        res.write(JSON.stringify({ status: "pulling abc", total, completed: total }) + "\n");
        models.set(body.model, total);
        res.end(JSON.stringify({ status: "success" }) + "\n");
        return;
      }
      json(404, { error: "no route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    models,
    loaded,
    calls,
    pullSizes,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

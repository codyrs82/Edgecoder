// #525: over the hosted endpoint, a named model's call carries the helper's price ceiling to the
// coordinator, and the reply says where it ran (served) so the client's served line isn't "unknown".
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { hostedBackend } from "../../src/apps/ide/hosted-backend.js";
import type { NetworkDeps } from "../../src/apps/ide/network-inference.js";
import { tentacleCallLine } from "../../src/apps/ide/tentacle-format.js";
import { anthropicStream } from "../../src/inference-api/anthropic.js";
import { namedModelCeiling, networkBackend } from "../../src/inference-api/backends.js";
import { openAiResponse, openAiStream } from "../../src/inference-api/openai.js";
import type { ChatPiece } from "../../src/inference-api/types.js";
import type { ServedBy } from "../../src/swarm/served-by.js";

const SERVED: ServedBy = { label: "lin-•••3f2a", own: false, computeClass: "gpu", tier: "gpu40", hardware: "GPU (gpu40)", region: "nrt", city: "Tokyo", country: "JP", promptTokens: 1100, outputTokens: 90 };

let server: Server | null = null;
afterEach(() => server?.close());

async function* pieces(): AsyncGenerator<ChatPiece> {
  yield { delta: "ok" };
  yield { done: true, cSatsSpent: 0.1, served: SERVED };
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("a named model's price ceiling reaches the coordinator", () => {
  it("takes the lower of the target's and the request's maxCSats", () => {
    expect(namedModelCeiling(undefined, { maxCSats: 25 })).toEqual({ routing: { maxCSats: 25 } });
    expect(namedModelCeiling({ maxCSats: 10 }, { maxCSats: 25 })).toEqual({ routing: { maxCSats: 10 } });
    expect(namedModelCeiling(undefined, {})).toEqual({});
    expect(namedModelCeiling(undefined, { maxCSats: 0 })).toEqual({ routing: { maxCSats: 0.001 } });
  });

  it("networkBackend submits network/<m> with routing.maxCSats from the hints, and passes served on", async () => {
    const submits: Array<Record<string, unknown>> = [];
    const deps: NetworkDeps = {
      forwarder: "",
      token: () => "",
      agentId: "acct-1",
      transport: async (_m, path, body) => {
        if (path === "/inference/submit") {
          submits.push(body as Record<string, unknown>);
          return { status: 200, json: { taskId: "t", subtaskId: "s" } };
        }
        return { status: 200, json: { chunks: ["hi"], next: 1, done: true, creditsSpent: 0.2, served: SERVED } };
      },
    };
    const out = await collect(networkBackend(deps, { model: "qwen2.5-coder:1.5b", computeClass: "any" })({ messages: [{ role: "user", content: "x" }], hints: { job: "code_edit", maxCSats: 24.9, sessionId: "tentacle:t1" } }));
    // Only the ceiling goes with a named model (no best-fit hints).
    expect(submits[0].routing).toEqual({ maxCSats: 24.9 });
    expect(out.at(-1)).toMatchObject({ done: true, cSatsSpent: 0.2, served: { region: "nrt", computeClass: "gpu" } });
  });
});

describe("the hosted reply says where the call ran", () => {
  it("OpenAI and Anthropic replies carry edgecoder.served", async () => {
    const lines = await collect(openAiStream(pieces(), "network/qwen2.5-coder:1.5b"));
    const last = JSON.parse(lines.at(-2)!.slice(6)) as { edgecoder: { served: ServedBy; cSatsSpent: number } };
    expect(last.edgecoder).toMatchObject({ cSatsSpent: 0.1, served: { label: "lin-•••3f2a", region: "nrt" } });
    expect((await openAiResponse(pieces(), "m")).edgecoder).toMatchObject({ served: { city: "Tokyo" } });
    const events = (await collect(anthropicStream(pieces(), "m"))).join("");
    expect(events).toContain('"served":{"label":"lin-•••3f2a"');
  });

  it("the hosted backend reads served and where, so a helper's served line names the class, host and region", async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1100, completion_tokens: 90 }, edgecoder: { cSatsSpent: 0.1, where: "network gpu", served: { ...SERVED, extra: "dropped" } } })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const out = await collect(hostedBackend({ baseUrl: `http://127.0.0.1:${port}`, apiKey: () => "eck_t" }, "network/qwen2.5-coder:1.5b")({ messages: [{ role: "user", content: "x" }] }));
    const done = out.at(-1) as Extract<ChatPiece, { done: true }>;
    expect(done).toMatchObject({ done: true, cSatsSpent: 0.1, where: "network gpu", served: { label: "lin-•••3f2a", computeClass: "gpu", region: "nrt", city: "Tokyo" } });
    expect(done.served).not.toHaveProperty("extra");
    const line = tentacleCallLine({ cSats: 0.1, model: "qwen2.5-coder:1.5b", place: "network", served: done.served, promptTokens: 1100, outputTokens: 90 });
    expect(line).toBe("qwen2.5-coder:1.5b · network gpu · lin-•••3f2a Tokyo · 1.1k in / 90 out tok · 0.1 cSats");
    expect(line).not.toContain("unknown");
  });
});

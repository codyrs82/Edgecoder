import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { contentToText, listNetworkModels, parseNetworkModel, streamNetworkCompletion, type NetworkDeps } from "../../src/apps/ide/network-inference.js";

describe("network model ids", () => {
  it("parses model and class", () => {
    expect(parseNetworkModel("network/qwen2.5-coder:32b@gpu")).toEqual({ model: "qwen2.5-coder:32b", computeClass: "gpu" });
    expect(parseNetworkModel("network/qwen2.5-coder:32b")).toEqual({ model: "qwen2.5-coder:32b", computeClass: "any" });
    expect(parseNetworkModel("network/llama3:8b@gpu.dc")).toEqual({ model: "llama3:8b", computeClass: "gpu.dc" });
    // An @ that isn't a class stays part of the model name.
    expect(parseNetworkModel("network/me@home:1b")).toEqual({ model: "me@home:1b", computeClass: "any" });
    expect(parseNetworkModel("qwen3.5:9b")).toBeNull();
  });
  it("flattens OpenAI content parts to text", () => {
    expect(contentToText("hi")).toBe("hi");
    expect(contentToText([{ type: "text", text: "a" }, { type: "image_url", image_url: {} }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(contentToText(null)).toBe("");
  });
});

describe("streamNetworkCompletion", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function fakeForwarder(handler: (path: string, body: Record<string, unknown>) => { status?: number; json: unknown }): Promise<NetworkDeps> {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const r = handler(req.url ?? "", raw ? JSON.parse(raw) : {});
        res.statusCode = r.status ?? 200;
        res.end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { forwarder: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: () => "tok", agentId: "agent-1" };
  }

  it("submits, then yields the reply piece by piece until done", async () => {
    let submitted: Record<string, unknown> = {};
    const reads: number[] = [];
    const deps = await fakeForwarder((path, body) => {
      if (path === "/forward/inference/submit") {
        submitted = body;
        return { json: { taskId: body.taskId, subtaskId: "st-1", reservedCSats: 10 } };
      }
      reads.push(body.after as number);
      return body.after === 0 ? { json: { chunks: ["Hel", "lo"], next: 2, done: false } } : { json: { chunks: ["!"], next: 3, done: true, creditsSpent: 0.42 } };
    });
    const out = [];
    for await (const p of streamNetworkCompletion(deps, { model: "qwen2.5-coder:32b", computeClass: "gpu", messages: [{ role: "developer", content: "x" }, { role: "user", content: "hi" }], maxTokens: 50 })) out.push(p);
    expect(out).toEqual([{ delta: "Hel" }, { delta: "lo" }, { delta: "!" }, { done: true, creditsSpent: 0.42 }]);
    expect(reads).toEqual([0, 2]);
    expect(submitted).toMatchObject({ submitterAccountId: "agent-1", model: "qwen2.5-coder:32b", computeClass: "gpu", maxTokens: 50 });
    // Roles OpenAI has that the network doesn't (developer, tool) go as user.
    expect((submitted.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("explains why a request couldn't start", async () => {
    const deps = await fakeForwarder(() => ({ status: 409, json: { error: "no_agent_has_model" } }));
    await expect(streamNetworkCompletion(deps, { model: "x", computeClass: "any", messages: [{ role: "user", content: "hi" }] }).next()).rejects.toThrow(/No machine on the network has x/);
  });

  it("lists each model, and per class", async () => {
    const deps = await fakeForwarder(() => ({ json: { models: [{ model: "qwen2.5-coder:32b", agents: 2, classes: ["gpu", "apple"] }] } }));
    expect((await listNetworkModels(deps)).map((m) => m.id)).toEqual(["network/qwen2.5-coder:32b", "network/qwen2.5-coder:32b@gpu", "network/qwen2.5-coder:32b@apple"]);
  });
});

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
  it("reads a hardware tier suffix as its class (calls match by class, never by tier)", () => {
    // The tier the Network page shows for a machine; before, "@gpu.c8" stayed in the model name and no agent matched.
    expect(parseNetworkModel("network/qwen3-coder:30b@gpu.c8")).toEqual({ model: "qwen3-coder:30b", computeClass: "gpu" });
    expect(parseNetworkModel("network/qwen3-coder:30b@gpu.c32")).toEqual({ model: "qwen3-coder:30b", computeClass: "gpu" });
    expect(parseNetworkModel("network/qwen3.5:9b@apple.m.hi")).toEqual({ model: "qwen3.5:9b", computeClass: "apple" });
    expect(parseNetworkModel("network/llama3:70b@gpu.dc80")).toEqual({ model: "llama3:70b", computeClass: "gpu.dc" });
    expect(parseNetworkModel("network/glm-5.3@cloud")).toEqual({ model: "glm-5.3", computeClass: "cloud" });
    expect(parseNetworkModel("network/m@gpu.c9")).toEqual({ model: "m@gpu.c9", computeClass: "any" });
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

  it("a stream read that fails on the way (an edge 502, a reset connection) is read again; nothing is lost or doubled", async () => {
    const reads: number[] = [];
    let failures = 0;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === "/forward/inference/submit") return res.end(JSON.stringify({ taskId: body.taskId, subtaskId: "st-r", reservedCSats: 1 }));
        reads.push(body.after);
        if (body.after === 2 && failures === 0) { failures++; res.statusCode = 502; return res.end("<!DOCTYPE html><title>502: Bad gateway</title>"); }
        if (body.after === 2 && failures === 1) { failures++; return req.socket.destroy(); }
        res.end(JSON.stringify(body.after === 0 ? { chunks: ["Hel", "lo"], next: 2, done: false } : { chunks: [" there"], next: 3, done: true }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const deps: NetworkDeps = { forwarder: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: () => "tok", agentId: "agent-1" };
    const out = [];
    for await (const p of streamNetworkCompletion(deps, { model: "m", computeClass: "any", messages: [{ role: "user", content: "hi" }] })) out.push(p);
    expect(out).toEqual([{ delta: "Hel" }, { delta: "lo" }, { delta: " there" }, { done: true }]);
    expect(reads).toEqual([0, 2, 2, 2]);
  });

  it("what the coordinator answered about the stream itself is not retried", async () => {
    let reads = 0;
    const deps = await fakeForwarder((path, body) => {
      if (path === "/forward/inference/submit") return { json: { taskId: body.taskId, subtaskId: "st-gone", reservedCSats: 1 } };
      reads++;
      return { status: 404, json: { error: "unknown_stream" } };
    });
    await expect(streamNetworkCompletion(deps, { model: "m", computeClass: "any", messages: [{ role: "user", content: "hi" }] }).next()).rejects.toThrow(/unknown_stream/);
    expect(reads).toBe(1);
  });

  it("a call the coordinator cancelled for lack of capacity is a 503 with when to retry", async () => {
    const deps = await fakeForwarder((path, body) =>
      path === "/forward/inference/submit"
        ? { json: { taskId: body.taskId, subtaskId: "st-busy", reservedCSats: 10 } }
        : { status: 503, json: { error: "no_capacity", retryAfterSec: 20 } }
    );
    const err = await (async () => {
      try {
        for await (const _ of streamNetworkCompletion(deps, { model: "m", computeClass: "any", messages: [{ role: "user", content: "hi" }] })) void _;
      } catch (e) {
        return e as { status: number; retryAfterSec?: number; message: string };
      }
    })();
    expect(err).toMatchObject({ status: 503, retryAfterSec: 20 });
    expect(err!.message).toContain("Nothing was charged");
  });

  it("model auto: a busy answer names the model best fit chose, not \"auto\"", async () => {
    const deps = await fakeForwarder((path, body) =>
      path === "/forward/inference/submit"
        ? { json: { taskId: body.taskId, subtaskId: "st-busy", reservedCSats: 10, routing: { model: "qwen3.5:9b", line: "routed to qwen3.5:9b on gpu" } } }
        : { status: 503, json: { error: "no_capacity", retryAfterSec: 20 } }
    );
    const err = await streamNetworkCompletion(deps, { model: "auto", computeClass: "any", messages: [{ role: "user", content: "hi" }] }).next().catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/^Every machine that runs qwen3\.5:9b is busy/);
  });

  it("model auto: a coordinator's \"No machine on the network can run this job\" is shown as is", async () => {
    const detail = "No machine on the network can run this job right now (needs a model ≥ 14B with tools; online: qwen2.5-coder:7b, qwen3.5:9b)";
    const deps = await fakeForwarder(() => ({ status: 409, json: { error: "no_route_fits", reason: "size", detail } }));
    const err = await streamNetworkCompletion(deps, { model: "auto", computeClass: "any", messages: [{ role: "user", content: "hi" }] }).next().catch((e: Error) => e);
    expect((err as Error).message).toBe(`${detail}. Nothing was charged.`);
    expect((err as { info?: unknown }).info).toMatchObject({ code: "no_route_fits", reason: "size" });
  });

  it("explains why a request couldn't start", async () => {
    const deps = await fakeForwarder(() => ({ status: 409, json: { error: "no_agent_has_model" } }));
    await expect(streamNetworkCompletion(deps, { model: "x", computeClass: "any", messages: [{ role: "user", content: "hi" }] }).next()).rejects.toThrow(/No machine on the network has x/);
  });

  it("says when your machine has the model but keeps it off the network and its agent can't run it for you", async () => {
    const deps = await fakeForwarder(() => ({ status: 409, json: { error: "no_own_agent_has_model", reason: "local_only", localOnlyOn: ["nvidia-1-gpu"] } }));
    const err = await streamNetworkCompletion(deps, { model: "qwen3.5:9b", computeClass: "any", target: "mine", messages: [{ role: "user", content: "hi" }] }).next().catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/qwen3.5:9b is installed on your machine nvidia-1-gpu, but it is too big for that machine to share on the network, and its agent is too old/);
    const plain = await fakeForwarder(() => ({ status: 409, json: { error: "no_own_agent_has_model" } }));
    await expect(streamNetworkCompletion(plain, { model: "x", computeClass: "any", target: "mine", messages: [{ role: "user", content: "hi" }] }).next()).rejects.toThrow(/None of your own machines has x/);
  });

  it("a lease that ended (or isn't the caller's) is a 404 that says so, not a 502", async () => {
    const deps = await fakeForwarder(() => ({ status: 404, json: { error: "reservation_not_active" } }));
    const err = await streamNetworkCompletion(deps, { model: "m", computeClass: "any", reservationId: "res-1", messages: [{ role: "user", content: "hi" }] })
      .next()
      .catch((e) => e as { status: number; message: string });
    expect(err).toMatchObject({ status: 404 });
    expect((err as { message: string }).message).toMatch(/reservation isn't active/);
  });

  it("no machine of the requested class is not called busy", async () => {
    // At submit: holders exist, none in the class (the 2x A16 demoted to cpu, an @gpu.dc call).
    const atSubmit = await fakeForwarder(() => ({ status: 409, json: { error: "no_agent_in_class", model: "qwen3-coder:30b", computeClass: "gpu.dc", availableClasses: ["cpu"] } }));
    const e1 = streamNetworkCompletion(atSubmit, { model: "qwen3-coder:30b", computeClass: "gpu.dc", messages: [{ role: "user", content: "hi" }] }).next();
    await expect(e1).rejects.toThrow(/No gpu\.dc machine runs qwen3-coder:30b right now; it runs on: cpu/);
    server?.close();
    // At the claim bound: the coordinator's 503 says which.
    const atClaim = await fakeForwarder((path, body) =>
      path === "/forward/inference/submit"
        ? { json: { taskId: body.taskId, subtaskId: "st-x", reservedCSats: 10 } }
        : { status: 503, json: { error: "no_capacity", reason: "none_in_class", computeClass: "gpu.dc", retryAfterSec: 15 } }
    );
    let msg = "";
    try {
      for await (const _ of streamNetworkCompletion(atClaim, { model: "qwen3-coder:30b", computeClass: "gpu.dc", messages: [{ role: "user", content: "hi" }] })) void _;
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/No gpu\.dc machine runs qwen3-coder:30b right now/);
    expect(msg).not.toMatch(/busy/);
  });

  it("lists each model, and per class", async () => {
    const deps = await fakeForwarder(() => ({ json: { models: [{ model: "qwen2.5-coder:32b", agents: 2, classes: ["gpu", "apple"] }] } }));
    expect((await listNetworkModels(deps)).map((m) => m.id)).toEqual(["network/qwen2.5-coder:32b", "network/qwen2.5-coder:32b@gpu", "network/qwen2.5-coder:32b@apple"]);
  });
});

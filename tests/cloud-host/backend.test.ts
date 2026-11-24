import { afterEach, describe, expect, it } from "vitest";
import { backoffMs, CloudApiError, probeKey, remoteChat, retryAfterMs, type RemoteBackendConfig } from "../../src/cloud-host/backend.js";
import type { OllamaPiece } from "../../src/inference-api/ollama.js";
import { startFakeProvider, streamReply, type FakeProvider } from "./fake-provider.js";

/*
 * The cloud host's backend against a fake OpenAI-compatible provider: streaming, tool calls, the
 * provider's usage (with cached prompt tokens), retries of 429 / 5xx, no retry of 401, and the key
 * never in an error.
 */

const KEY = "fw-test-key-0123456789abcdef";
let fake: FakeProvider | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

function cfg(url: string, extra: Partial<RemoteBackendConfig> = {}): RemoteBackendConfig {
  return { label: "Fireworks", baseUrl: url, apiKey: KEY, maxRetries: 3, sleep: async () => undefined, ...extra };
}

async function collect(gen: AsyncGenerator<OllamaPiece>): Promise<OllamaPiece[]> {
  const out: OllamaPiece[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

const req = { model: "accounts/fireworks/models/glm-5p3", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

describe("remoteChat", () => {
  it("streams text and ends with the provider's token counts, cached prompt tokens included", async () => {
    fake = await startFakeProvider([streamReply({ text: ["Hel", "lo"], usage: { prompt_tokens: 120, completion_tokens: 2, cached: 100 } })]);
    const pieces = await collect(remoteChat(cfg(fake.url), req));
    expect(pieces.filter((p) => "delta" in p).map((p) => (p as { delta: string }).delta).join("")).toBe("Hello");
    const done = pieces.at(-1) as Extract<OllamaPiece, { doneReason: string }>;
    expect(done).toMatchObject({ doneReason: "stop", promptTokens: 120, outputTokens: 2, cachedPromptTokens: 100 });
    // One request: bearer key, the provider's model id, streaming with usage, max_tokens.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].path).toBe("/inference/v1/chat/completions");
    expect(fake.requests[0].auth).toBe(`Bearer ${KEY}`);
    expect(fake.requests[0].body).toMatchObject({ model: "accounts/fireworks/models/glm-5p3", stream: true, stream_options: { include_usage: true }, max_tokens: 100 });
  });

  it("assembles streamed tool calls and passes tools through", async () => {
    fake = await startFakeProvider([streamReply({ toolCalls: [{ name: "read_file", args: '{"path":"src/a.ts"}' }], usage: { prompt_tokens: 50, completion_tokens: 12 } })]);
    const tools = [{ type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
    const pieces = await collect(remoteChat(cfg(fake.url), { ...req, tools }));
    const calls = pieces.find((p) => "toolCalls" in p) as { toolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
    expect(calls.toolCalls).toEqual([{ function: { name: "read_file", arguments: { path: "src/a.ts" } } }]);
    expect(fake.requests[0].body.tools).toEqual(tools);
    expect(pieces.at(-1)).toMatchObject({ outputTokens: 12 });
  });

  it("retries a 429 (honouring Retry-After) and a 503, then streams", async () => {
    fake = await startFakeProvider([
      { status: 429, body: { error: { message: "rate limited" } }, headers: { "retry-after": "2" } },
      { status: 503, body: { error: "overloaded" } },
      streamReply({ text: ["ok"], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    ]);
    const waits: number[] = [];
    const pieces = await collect(remoteChat(cfg(fake.url, { sleep: async (ms) => void waits.push(ms) }), req));
    expect(pieces.some((p) => "delta" in p && p.delta === "ok")).toBe(true);
    expect(fake.requests).toHaveLength(3);
    expect(waits[0]).toBe(2_000); // Retry-After: 2 s
    expect(waits).toHaveLength(2);
  });

  it("gives up after maxRetries with a clear error", async () => {
    fake = await startFakeProvider([{ status: 500, body: { error: "boom" } }]);
    const err = await collect(remoteChat(cfg(fake.url, { maxRetries: 2 }), req)).catch((e) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.kind).toBe("server");
    expect(err.message).toMatch(/^cloud_provider_error: Fireworks HTTP 500: boom/);
    expect(fake.requests).toHaveLength(3);
  });

  it("never retries a 401, and keeps the key out of the error", async () => {
    fake = await startFakeProvider([{ status: 401, body: { error: { message: `invalid api key ${KEY}` } } }]);
    const err = await collect(remoteChat(cfg(fake.url), req)).catch((e) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/^cloud_provider_auth:/);
    expect(err.message).not.toContain(KEY);
    expect(fake.requests).toHaveLength(1);
  });

  it("a prompt longer than the model's window is a context overflow (another host may take it)", async () => {
    fake = await startFakeProvider([{ status: 400, body: { error: { message: "The prompt is too long: 2000000 tokens, maximum context length is 1048576" } } }]);
    const err = await collect(remoteChat(cfg(fake.url), req)).catch((e) => e);
    expect(err.contextOverflow).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it("an error event inside the stream fails the call", async () => {
    fake = await startFakeProvider([{ stream: [{ choices: [{ index: 0, delta: { content: "par" } }] }, { error: { message: "upstream reset" } }] }]);
    const err = await collect(remoteChat(cfg(fake.url), req)).catch((e) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.message).toContain("upstream reset");
  });

  it("probeKey reports whether the key is accepted", async () => {
    fake = await startFakeProvider([{ status: 401, body: {} }, { status: 200, body: { data: [] } }]);
    expect(await probeKey({ baseUrl: fake.url, apiKey: KEY })).toEqual({ ok: false, status: 401 });
    expect(await probeKey({ baseUrl: fake.url, apiKey: KEY })).toEqual({ ok: true, status: 200 });
    expect(fake.requests[0].path).toBe("/inference/v1/models");
  });
});

describe("backoff", () => {
  it("doubles with jitter, honours Retry-After, and is capped", () => {
    expect(backoffMs(0, { retryBaseMs: 500 }, undefined, () => 0.5)).toBe(500);
    expect(backoffMs(2, { retryBaseMs: 500 }, undefined, () => 0.5)).toBe(2_000);
    expect(backoffMs(10, { retryBaseMs: 500, retryMaxMs: 15_000 }, undefined, () => 1)).toBe(15_000);
    expect(backoffMs(0, { retryMaxMs: 15_000 }, 60_000)).toBe(15_000);
    expect(retryAfterMs("3")).toBe(3_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs(undefined)).toBeUndefined();
  });
});

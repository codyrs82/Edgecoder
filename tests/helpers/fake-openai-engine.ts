// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * A fake OpenAI-compatible inference server, shaped like vLLM (`max_model_len` in /v1/models,
 * `vllm:cache_config_info` in /metrics, its error bodies) or like mlx_lm.server (neither, and
 * /v1/models listing every cached model). Streams replies as server-sent events.
 */

import { createServer, type Server } from "node:http";

export interface FakeReply {
  /** Text pieces, streamed one per event. */
  pieces?: string[];
  /** Tool calls, each streamed in fragments (name first, then the arguments in two parts). */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Delay between pieces (ms). */
  pieceDelayMs?: number;
  /** Answer with this HTTP status and body instead. */
  status?: number;
  errorBody?: unknown;
  /** Send an error event after the pieces (vLLM's mid-stream error). */
  midStreamError?: string;
}

export interface FakeEngine {
  url: string;
  requests: Array<{ path: string; body: any; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}

export async function startFakeEngine(opts: {
  flavor: "vllm" | "mlx";
  models: Array<{ id: string; maxModelLen?: number }>;
  /** vLLM: KV cache = blocks × blockSize tokens in /metrics. */
  kvBlocks?: number;
  blockSize?: number;
  /** vLLM: a prompt longer than this many characters gets the context-length 400. */
  maxPromptChars?: number;
  reply: (body: any) => FakeReply;
}): Promise<FakeEngine> {
  const requests: FakeEngine["requests"] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ path: req.url ?? "", body, headers: req.headers });
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: opts.models.map((m) => ({ id: m.id, object: "model", created: 1, owned_by: opts.flavor, ...(opts.flavor === "vllm" && m.maxModelLen ? { root: m.id, max_model_len: m.maxModelLen } : {}) })) }));
        return;
      }
      if (req.method === "GET" && req.url === "/metrics") {
        if (opts.flavor !== "vllm" || !opts.kvBlocks) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.end(`# HELP vllm:cache_config_info Information of the LLMEngine CacheConfig\n# TYPE vllm:cache_config_info gauge\nvllm:cache_config_info{block_size="${opts.blockSize ?? 16}",cache_dtype="auto",enable_prefix_caching="True",gpu_memory_utilization="0.92",num_gpu_blocks="${opts.kvBlocks}",num_cpu_blocks="0"} 1.0\nvllm:num_requests_running{model_name="x"} 0.0\n`);
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: "Not Found" }));
        return;
      }
      const promptChars = JSON.stringify(body.messages ?? []).length;
      if (opts.maxPromptChars !== undefined && promptChars > opts.maxPromptChars) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "error", message: `This model's maximum context length is ${opts.models[0]?.maxModelLen ?? 0} tokens. However, you requested ${promptChars} tokens in the messages, Please reduce the length of the messages.`, type: "BadRequestError", param: null, code: 400 }));
        return;
      }
      const r = opts.reply(body);
      if (r.status) {
        res.statusCode = r.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(r.errorBody ?? { object: "error", message: "boom" }));
        return;
      }
      res.setHeader("content-type", "text/event-stream");
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => send({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      const wait = () => new Promise((ok) => setTimeout(ok, r.pieceDelayMs ?? 0));
      chunk({ role: "assistant", content: "" });
      for (const p of r.pieces ?? []) {
        await wait();
        chunk({ content: p });
      }
      (r.toolCalls ?? []).forEach((c, i) => {
        const args = JSON.stringify(c.arguments);
        const half = Math.floor(args.length / 2);
        chunk({ tool_calls: [{ index: i, id: `chatcmpl-tool-${i}`, type: "function", function: { name: c.name, arguments: "" } }] });
        chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(0, half) } }] });
        chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] });
      });
      if (r.midStreamError) {
        send({ error: { object: "error", message: r.midStreamError, type: "InternalServerError", code: 500 } });
        res.end();
        return;
      }
      chunk({}, r.finishReason ?? (r.toolCalls?.length ? "tool_calls" : "stop"));
      if (body.stream_options?.include_usage && r.usage) send({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { ...r.usage, total_tokens: r.usage.prompt_tokens + r.usage.completion_tokens } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: () => new Promise<void>((ok) => server.close(() => ok()))
  };
}

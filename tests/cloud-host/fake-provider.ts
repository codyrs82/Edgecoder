import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer of the fake OpenAI-compatible provider. */
export type FakeReply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { stream: Array<Record<string, unknown> | "[DONE]">; status?: 200 };

export interface FakeProvider {
  url: string;
  requests: Array<{ path: string; auth: string | undefined; body: any }>;
  /** Answers in order; the last one repeats. */
  script: FakeReply[];
  close: () => Promise<void>;
}

/** A local server speaking the OpenAI chat-completions protocol (SSE streaming), answering from a script. */
export async function startFakeProvider(script: FakeReply[] = []): Promise<FakeProvider> {
  const state: FakeProvider = { url: "", requests: [], script, close: async () => undefined };
  let n = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      state.requests.push({ path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      const reply = state.script[Math.min(n++, state.script.length - 1)] ?? { status: 404 };
      if ("stream" in reply) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const ev of reply.stream) res.write(`data: ${ev === "[DONE]" ? "[DONE]" : JSON.stringify(ev)}\n\n`);
        res.end();
        return;
      }
      res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/inference/v1`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

/** A streamed reply: text pieces, optional tool call pieces, then usage and [DONE]. */
export function streamReply(opts: { text?: string[]; toolCalls?: Array<{ name: string; args: string }>; usage?: { prompt_tokens: number; completion_tokens: number; cached?: number }; finish?: string }): FakeReply {
  const events: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const t of opts.text ?? []) events.push({ choices: [{ index: 0, delta: { content: t } }] });
  (opts.toolCalls ?? []).forEach((c, i) => {
    // Split the arguments in two pieces, as providers do.
    const half = Math.floor(c.args.length / 2);
    events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name: c.name, arguments: c.args.slice(0, half) } }] } }] });
    events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: c.args.slice(half) } }] } }] });
  });
  events.push({ choices: [{ index: 0, delta: {}, finish_reason: opts.finish ?? (opts.toolCalls?.length ? "tool_calls" : "stop") }] });
  if (opts.usage) {
    events.push({ choices: [], usage: { prompt_tokens: opts.usage.prompt_tokens, completion_tokens: opts.usage.completion_tokens, ...(opts.usage.cached !== undefined ? { prompt_tokens_details: { cached_tokens: opts.usage.cached } } : {}) } });
  }
  events.push("[DONE]");
  return { stream: events };
}

// A SessionHub on a scripted model and the real tool executor, for session, terminal and remote tests.
import Fastify from "fastify";
import type { ChatFn, ChatResult } from "../../src/apps/ide/agent-loop.js";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { registerSessionRoutes } from "../../src/apps/ide/session-routes.js";
import { SessionHub } from "../../src/apps/ide/sessions.js";
import { ToolExecutor } from "../../src/apps/ide/tool-executor.js";

export type Reply = ChatResult | ((req: Parameters<ChatFn>[0]) => ChatResult | Promise<ChatResult>);

/** Model replies in order, streamed in small pieces; the requests are kept. */
export function scriptedModel(replies: Reply[]) {
  const requests: Array<Parameters<ChatFn>[0]> = [];
  const chat: ChatFn = async (req, onDelta) => {
    requests.push(structuredClone(req));
    const next = replies.shift();
    if (!next) return { content: "(no more replies)", toolCalls: [] };
    const r = typeof next === "function" ? await next(req) : next;
    if (onDelta) for (const piece of r.content.match(/.{1,5}/gs) ?? []) onDelta(piece);
    return r;
  };
  return { chat, requests, replies };
}

export function makeHub(replies: Reply[], opts: { dir?: string | null; approvalTimeoutMs?: number } = {}) {
  const model = scriptedModel(replies);
  const checkpoints = new CheckpointStore();
  const hub = new SessionHub(
    {
      chat: () => model.chat,
      systemPrompt: async () => () => "system",
      executor: (s) => {
        const ex = new ToolExecutor(s.projectRoot);
        return { execute: (tool, args, o) => ex.execute(tool, args, o) };
      },
      checkpoints,
      branch: () => "main",
    },
    { dir: opts.dir ?? null, approvalTimeoutMs: opts.approvalTimeoutMs },
  );
  return { hub, model, checkpoints };
}

/** The session routes on a loopback port (no auth: the provider's hook is tested elsewhere). */
export async function sessionServer(hub: SessionHub) {
  const app = Fastify({ forceCloseConnections: true });
  registerSessionRoutes(app, hub);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { app, url: `http://127.0.0.1:${port}` };
}

/** Wait until `check` passes (polling), or fail after `ms`. */
export async function until(check: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

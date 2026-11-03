// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Loopback forwarder: the user's IDE (or any local coding agent) sends swarm work to its own
 * agent, which signs it with the agent key and relays it to the coordinator the agent is
 * registered with. The coordinator then bills the agent owner's account (/submit binds the
 * account to the signer), so nothing local needs the shared mesh token or names an account.
 *
 *   POST /forward/submit                                      -> POST {coordinator}/submit (signed)
 *   POST /forward/inference/submit | /forward/inference/stream -> the coordinator's (signed)
 *   GET  /forward/inference/models                            -> GET  {coordinator}/inference/models
 *   GET  /forward/tasks/:taskId/subtasks/:subtaskId/result    -> GET  {coordinator}/tasks/...
 *   GET  /forward/health                                      -> forwarder state
 *
 * Every route needs `Authorization: Bearer <IDE token>`; browser requests (an Origin header)
 * are refused, and the server binds 127.0.0.1 only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request } from "undici";
import { safeTokenEqual } from "../apps/ide/ide-auth.js";

export const LOCAL_FORWARD_DEFAULT_PORT = 4305;
/** POST routes relayed to the coordinator, signed by this agent over the exact body bytes. */
const SIGNED_POSTS: Record<string, string> = {
  "/forward/submit": "/submit",
  "/forward/inference/submit": "/inference/submit",
  "/forward/inference/stream": "/inference/stream",
  "/forward/account/summary": "/account/summary",
  "/forward/account/buy": "/account/buy",
  "/forward/account/intent": "/account/intent",
  "/forward/account/reservations": "/account/reservations",
  "/forward/account/reservations/list": "/account/reservations/list",
  "/forward/account/reservations/cancel": "/account/reservations/cancel",
  "/forward/account/usage": "/account/usage",
};
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const RESULT_PATH_RE = /^\/forward\/tasks\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})\/subtasks\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})\/result$/;

export interface LocalForwarderDeps {
  /** Bearer token callers must present (the IDE token). */
  token: () => string;
  /** The coordinator this agent is registered with right now, or null before registration. */
  coordinatorUrl: () => string | null;
  /** x-mesh-token for the coordinator's global hook. */
  meshHeaders: () => Record<string, string>;
  /** Agent request-signing headers over the exact body bytes. */
  signedHeaders: (path: string, rawBody: string) => Record<string, string>;
  /** The account the coordinator bills for this agent, for /forward/health. */
  agentId: string;
  timeoutMs?: number;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createLocalForwarder(deps: LocalForwarderDeps): Server {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  return createServer(async (req, res) => {
    try {
      if (req.headers.origin) return send(res, 403, { error: "browser_requests_refused" });
      const auth = String(req.headers.authorization ?? "");
      const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const expected = deps.token();
      if (!expected || !presented || !safeTokenEqual(presented, expected)) {
        return send(res, 401, { error: "unauthorized" });
      }
      const path = (req.url ?? "/").split("?")[0];
      const coordinator = deps.coordinatorUrl();

      if (req.method === "GET" && path === "/forward/health") {
        return send(res, 200, { ok: true, agentId: deps.agentId, coordinatorUrl: coordinator, registered: Boolean(coordinator) });
      }
      if (!coordinator) return send(res, 503, { error: "agent_not_registered" });

      const target = req.method === "POST" ? SIGNED_POSTS[path] : undefined;
      if (target) {
        const raw = await readBody(req);
        try {
          JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "invalid_json" });
        }
        const upstream = await request(`${coordinator}${target}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...deps.meshHeaders(), ...deps.signedHeaders(target, raw) },
          body: raw,
          // /submit splits the prompt into subtasks before it answers; a stream read long-polls.
          headersTimeout: Math.max(timeoutMs, 60_000),
          bodyTimeout: Math.max(timeoutMs, 60_000)
        });
        return send(res, upstream.statusCode, await upstream.body.text());
      }

      if (req.method === "GET" && path === "/forward/inference/models") {
        const upstream = await request(`${coordinator}/inference/models`, { method: "GET", headers: deps.meshHeaders(), headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
        return send(res, upstream.statusCode, await upstream.body.text());
      }

      const result = req.method === "GET" ? RESULT_PATH_RE.exec(path) : null;
      if (result) {
        const upstream = await request(`${coordinator}/tasks/${result[1]}/subtasks/${result[2]}/result`, {
          method: "GET",
          headers: deps.meshHeaders(),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs
        });
        return send(res, upstream.statusCode, await upstream.body.text());
      }
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof Error && err.message === "body_too_large") return send(res, 413, { error: "body_too_large" });
      return send(res, 502, { error: "coordinator_unreachable", detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

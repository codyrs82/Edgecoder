// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Loopback forwarder: the user's IDE (or any local coding agent) sends swarm work to its own
 * agent, which signs it with the agent key (GETs included) and relays it to the coordinator the
 * agent is registered with. The coordinator then bills the agent owner's account (/submit binds the
 * account to the signer), so nothing local needs the shared mesh token or names an account.
 *
 *   POST /forward/submit                                      -> POST {coordinator}/submit (signed)
 *   POST /forward/inference/submit | /forward/inference/stream -> the coordinator's (signed)
 *   POST /forward/v1/tools/web/{status,search,read}           -> the coordinator's web tool (signed; billed to the owner)
 *   GET  /forward/inference/models                            -> GET  {coordinator}/inference/models
 *   GET  /forward/network/world                               -> GET  {coordinator}/network/world (anonymized)
 *   GET  /forward/tasks/:taskId/subtasks/:subtaskId/result    -> GET  {coordinator}/tasks/...
 *   GET  /forward/health                                      -> forwarder state (+ coordinator steering,
 *                                                                paused/draining/claims: agent-lifecycle.ts,
 *                                                                serving: the jobs running now, serving-jobs.ts)
 *   POST /forward/drain   {resume?}                           -> stop taking work and hand claims back before
 *                                                                the app restarts (BHV006); resume: take work again
 *   GET  /forward/ble/peers                                   -> nearby devices the user allowed (Bluetooth failover,
 *                                                                src/inference-api/bluetooth-failover.ts)
 *   GET  /forward/ble/nearby                                  -> every EdgeCoder device nearby, for choosing which to allow
 *   POST /forward/ble/run  {agentId, prompt}                  -> run one prompt on an allowed device over Bluetooth (free)
 *   (the /forward/ble routes work while the agent isn't registered: that is when they're needed)
 *
 * Every route needs `Authorization: Bearer <IDE token>`; browser requests (an Origin header)
 * are refused, and the server binds 127.0.0.1 only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request } from "undici";
import { safeTokenEqual } from "../apps/ide/ide-auth.js";
import type { LifecycleStatus } from "./agent-lifecycle.js";
import type { ServingView } from "./serving-jobs.js";

export const LOCAL_FORWARD_DEFAULT_PORT = 4305;
/** POST routes relayed to the coordinator, signed by this agent over the exact body bytes. */
const SIGNED_POSTS: Record<string, string> = {
  "/forward/submit": "/submit",
  "/forward/inference/submit": "/inference/submit",
  "/forward/inference/stream": "/inference/stream",
  "/forward/inference/cancel": "/inference/cancel",
  "/forward/account/summary": "/account/summary",
  "/forward/account/buy": "/account/buy",
  "/forward/account/intent": "/account/intent",
  "/forward/account/reservations": "/account/reservations",
  "/forward/account/reservations/list": "/account/reservations/list",
  "/forward/account/reservations/cancel": "/account/reservations/cancel",
  "/forward/account/usage": "/account/usage",
  "/forward/v1/tools/web/status": "/v1/tools/web/status",
  "/forward/v1/tools/web/search": "/v1/tools/web/search",
  "/forward/v1/tools/web/read": "/v1/tools/web/read",
};
/** GET routes relayed to the coordinator, signed by this agent (no query string). */
const SIGNED_GETS: Record<string, string> = {
  "/forward/inference/models": "/inference/models",
  "/forward/network/world": "/network/world",
};
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const RESULT_PATH_RE = /^\/forward\/tasks\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})\/subtasks\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})\/result$/;

export interface LocalForwarderDeps {
  /** Bearer token callers must present (the IDE token). */
  token: () => string;
  /** The coordinator this agent is registered with right now, or null before registration. */
  coordinatorUrl: () => string | null;
  /** The last coordinator-steering decision (registry pick, region, latency), for the app's Settings. */
  steering?: () => unknown;
  /** Paused (blacklisted) with the coordinator's reason, draining, claims running now. */
  lifecycle?: () => LifecycleStatus;
  /** The network jobs running on this machine now and its model slots (serving-jobs.ts), for Active work. */
  serving?: () => ServingView;
  /** Drain before a restart (hand claims back, pull nothing new for a while), or resume. */
  drain?: (resume: boolean) => Promise<{ draining: boolean; released: number; told: boolean }>;
  /** x-mesh-token, only when the operator configured one (agents are never given the coordinators' token). */
  meshHeaders: () => Record<string, string>;
  /** Agent request-signing headers over the exact body bytes (method defaults to POST). */
  signedHeaders: (path: string, rawBody: string, method?: string) => Record<string, string>;
  /** The account the coordinator bills for this agent, for /forward/health. */
  agentId: string;
  timeoutMs?: number;
  /**
   * A call came in while the agent isn't registered (starting, reconnecting after sleep or a network
   * change, a coordinator restarting): ask it to register now instead of at its next backoff step.
   */
  nudgeRegistration?: () => void;
  /** How long such a call waits for the registration before answering 503 agent_not_registered (default 8 s). */
  registrationWaitMs?: number;
  /** This agent's Bluetooth mesh, once it runs one (macOS with Bluetooth on); null until then. */
  ble?: () => LocalForwarderBle | null;
}

/** A nearby device as the /forward/ble routes describe it (no prompt or account data). */
export interface ForwarderBlePeer {
  agentId: string;
  name: string;
  model: string;
  modelParamSize: number;
  deviceType: "phone" | "laptop" | "workstation";
  rssi: number;
  /** The seal key it publishes (base64; src/mesh/ble/ble-seal.ts), pinned when the user allows it. */
  sealKey?: string;
  /** Usable now: allowed, sending on, and advertising the key pinned for it. */
  allowed: boolean;
  /** On the user's list (whatever key it advertises now). */
  pinned?: boolean;
  /** On the list: whether it advertises the pinned key. */
  keyMatches?: boolean;
}

export interface LocalForwarderBle {
  /** Every EdgeCoder device nearby now, each marked whether the user allowed it. */
  nearby(): ForwarderBlePeer[];
  /** Run `prompt` sealed to `agentId`'s pinned key; refuses (not_allowed, key_mismatch) before sending anything. */
  run(agentId: string, prompt: string): Promise<{ ok: true; output: string; ms: number } | { ok: false; error: "not_allowed" | "key_mismatch" | "failed"; detail?: string }>;
}

const MAX_BLE_PROMPT_BYTES = 64 * 1024;

async function handleBle(deps: LocalForwarderDeps, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const ble = deps.ble?.() ?? null;
  if (!ble) return send(res, 404, { error: "bluetooth_unavailable" });
  if (req.method === "GET" && path === "/forward/ble/nearby") return send(res, 200, { peers: ble.nearby() });
  if (req.method === "GET" && path === "/forward/ble/peers") return send(res, 200, { peers: ble.nearby().filter((p) => p.allowed) });
  if (req.method === "POST" && path === "/forward/ble/run") {
    let body: { agentId?: unknown; prompt?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return send(res, 400, { error: "invalid_json" });
    }
    if (typeof body.agentId !== "string" || typeof body.prompt !== "string" || !body.prompt) return send(res, 400, { error: "agentId_and_prompt_required" });
    if (Buffer.byteLength(body.prompt, "utf8") > MAX_BLE_PROMPT_BYTES) return send(res, 413, { error: "prompt_too_large" });
    const r = await ble.run(body.agentId, body.prompt);
    if (r.ok) return send(res, 200, { output: r.output, ms: r.ms });
    return send(res, r.error === "not_allowed" || r.error === "key_mismatch" ? 403 : 502,{ error: r.error, ...(r.detail ? { detail: r.detail } : {}) });
  }
  return send(res, 404, { error: "not_found" });
}

/** How often a waiting call looks whether the agent has registered. */
const REGISTRATION_POLL_MS = 200;
/** What a 503 agent_not_registered tells the caller to wait before trying again. */
export const NOT_REGISTERED_RETRY_AFTER_MS = 15_000;

/** The coordinator once the agent has registered, or null when it hasn't within `waitMs`. */
async function waitForRegistration(deps: LocalForwarderDeps, waitMs: number): Promise<string | null> {
  deps.nudgeRegistration?.();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const url = deps.coordinatorUrl();
    if (url || Date.now() >= deadline) return url;
    await new Promise((r) => setTimeout(r, Math.min(REGISTRATION_POLL_MS, Math.max(1, deadline - Date.now()))));
  }
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
      let coordinator = deps.coordinatorUrl();

      if (req.method === "GET" && path === "/forward/health") {
        return send(res, 200, { ok: true, agentId: deps.agentId, coordinatorUrl: coordinator, registered: Boolean(coordinator), steering: deps.steering?.() ?? null, ...(deps.lifecycle ? deps.lifecycle() : {}), ...(deps.serving ? { serving: deps.serving() } : {}) });
      }
      if (req.method === "POST" && path === "/forward/drain") {
        if (!deps.drain) return send(res, 404, { error: "not_found" });
        let resume = false;
        try {
          const raw = await readBody(req);
          resume = raw ? Boolean((JSON.parse(raw) as { resume?: unknown }).resume) : false;
        } catch {
          return send(res, 400, { error: "invalid_json" });
        }
        return send(res, 200, { ok: true, ...(await deps.drain(resume)) });
      }
      if (path.startsWith("/forward/ble/")) return await handleBle(deps, req, res, path);
      // Not registered right now: have it register, and give it a few seconds before saying so.
      if (!coordinator) coordinator = await waitForRegistration(deps, deps.registrationWaitMs ?? 8_000);
      if (!coordinator) return send(res, 503, { error: "agent_not_registered", retryAfterMs: NOT_REGISTERED_RETRY_AFTER_MS });

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

      // Signed GETs whose answer the coordinator scopes to the signer (models; the world view marks its own machines).
      const signedGet = req.method === "GET" ? SIGNED_GETS[path] : undefined;
      if (signedGet) {
        const upstream = await request(`${coordinator}${signedGet}`, { method: "GET", headers: { ...deps.meshHeaders(), ...deps.signedHeaders(signedGet, "", "GET") }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
        return send(res, upstream.statusCode, await upstream.body.text());
      }

      const result = req.method === "GET" ? RESULT_PATH_RE.exec(path) : null;
      if (result) {
        const resultPath = `/tasks/${result[1]}/subtasks/${result[2]}/result`;
        const upstream = await request(`${coordinator}${resultPath}`, {
          method: "GET",
          // Signed: the coordinator returns only results of tasks this agent's account submitted.
          headers: { ...deps.meshHeaders(), ...deps.signedHeaders(resultPath, "", "GET") },
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

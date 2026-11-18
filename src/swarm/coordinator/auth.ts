// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Request authentication helpers: mesh token, portal service token, signed agent requests
 * and the admin token.
 */
import {
  readHeaderValue,
  extractClientIp,
  isLoopbackSocket,
  submitterAccountDecision
} from "../coordinator-utils.js";
import { pgStore } from "../../db/store.js";
import { checkTokenSet } from "../../common/env-guard.js";
import { matchesTokenSet } from "../../common/token-rotation.js";
import { adminOriginDecision, socketAddressOf } from "../../common/admin-origin.js";
import { PORTAL_ACTION_HEADER, verifyPortalAction, type PortalAction } from "../../security/portal-action.js";
import { unsignedRequestDecision } from "../result-integrity.js";
import { rawBodyOf, verifySignedRequest, type SignedHeaders } from "../../security/request-signing.js";
import { verifyNonce } from "../../security/nonce-verifier.js";
import { AgentRateLimitedError } from "../../security/agent-rate-limiter.js";
import type { SecurityEventType } from "../../audit/security-events.js";
import {
  MESH_AUTH_TOKENS,
  IS_PROD,
  PORTAL_SERVICE_TOKENS,
  ADMIN_API_TOKENS,
  ADMIN_ORIGIN_POLICY,
  PORTAL_ACTION_KEYS,
  REQUIRE_PORTAL_ACTION_SIGNATURE,
  CLIENT_IP_TRUST,
  preAuthFailures,
  securityLog,
  identity,
  SECURITY_MAX_SKEW_MS,
  agentRateLimiter,
  nonceStore,
  SECURITY_NONCE_TTL_MS,
  CC
} from "./context.js";
import { REQUIRE_SIGNED_AGENT_REQUESTS, agentCapabilities, behaviorTracker } from "./agent-state.js";

// #5: an empty token means "open" only outside production; in production it is 503/denied.
export function requireMeshToken(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => any }) {
  const result = checkTokenSet(MESH_AUTH_TOKENS, req.headers["x-mesh-token"], IS_PROD);
  if (result === "ok") return true;
  reply.code(result === "not_configured" ? 503 : 401);
  return false;
}

export function hasMeshToken(headers: Record<string, unknown>): boolean {
  return checkTokenSet(MESH_AUTH_TOKENS, headers["x-mesh-token"], IS_PROD) === "ok";
}

export function hasPortalServiceToken(headers: Record<string, unknown>): boolean {
  return checkTokenSet(PORTAL_SERVICE_TOKENS, headers["x-portal-service-token"], IS_PROD) === "ok";
}

/*
 * Mesh token scope (docs/security-baseline.md, "Coordinator route authority";
 * docs/security/agent-threat-model.md). MESH_AUTH_TOKEN is held by coordinators and operator
 * tooling only: agents are never given it. An agent passes the global onRequest hook with its own
 * registered Ed25519 key (agentSignatureAtGate), and only on the routes an agent uses
 * (isAgentGateRoute). Routes that act for one agent take the agent from its request signature
 * (requireAgentSelf); operator routes need authorizeAdmin; coordinator-to-coordinator routes
 * verify an allowlisted peer signature.
 */

/** POST routes a signed agent (worker, iOS app, local forwarder) may call without the mesh token. */
const AGENT_POST_ROUTES: ReadonlySet<string> = new Set([
  "/heartbeat",
  "/pull",
  "/result",
  "/benchmark/response",
  "/agent/diagnostics",
  "/credits/ble-sync",
  "/submit",
  "/inference/submit",
  "/inference/stream",
  "/inference/chunks",
  "/account/summary",
  "/account/usage",
  "/account/buy",
  "/account/intent",
  "/account/onchain/address",
  "/account/onchain/deposits",
  "/account/reservations",
  "/account/reservations/list",
  "/account/reservations/cancel",
  // The web tool (routes/web-tools.ts): the signer's owner is the account billed.
  "/v1/tools/web/status",
  "/v1/tools/web/search",
  "/v1/tools/web/read",
  "/economy/market/orders",
  "/agent-mesh/connect",
  "/agent-mesh/accept",
  "/agent-mesh/relay",
  "/agent-mesh/close",
  "/agent-mesh/close-ack",
  "/agent-mesh/direct-work/offer",
  "/agent-mesh/direct-work/accept",
  "/agent-mesh/direct-work/result",
  "/agent-mesh/models/request"
]);
const AGENT_POST_PATTERNS: readonly RegExp[] = [
  /^\/orchestration\/agents\/[^/]+\/(status|ack)$/,
  // Remote model control: the agent's own state and command results (routes/model-control.ts).
  /^\/agent-control\/agents\/[^/]+\/report$/,
  // Bots on the web: the agent's bot snapshot and command results (routes/bot-relay.ts).
  /^\/agent-control\/agents\/[^/]+\/bots\/report$/
];
/** GET routes a signed agent may call; each scopes what it returns to the signer (see the route). */
const AGENT_GET_PATTERNS: readonly RegExp[] = [
  /^\/inference\/models$/,
  // The anonymized world view (routes/network-world.ts): the caller's own machines marked, others masked.
  /^\/network\/world$/,
  /^\/agent-mesh\/peers\/[^/]+$/,
  /^\/tasks\/[^/]+\/subtasks\/[^/]+\/result$/
];

/** Whether `method path` (no query string) is a route a signed agent may reach without the mesh token. */
export function isAgentGateRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "POST") return AGENT_POST_ROUTES.has(path) || AGENT_POST_PATTERNS.some((re) => re.test(path));
  if (m === "GET") return AGENT_GET_PATTERNS.some((re) => re.test(path));
  return false;
}

/**
 * Transport-gate check for agents: the request carries a signature, over this method and path and
 * within the clock-skew window, by the key this coordinator holds for the named agent. Returns the
 * agent id, or null. The body binding, nonce replay check and identity checks stay with the route
 * (verifyAgentRequest / requireAgentSelf), so nothing is consumed or counted here.
 */
export function agentSignatureAtGate(headers: Record<string, unknown>, method: string, path: string): string | null {
  const signed = extractSignedHeaders(headers);
  if (!signed) return null;
  const cap = agentCapabilities.get(signed["x-agent-id"]);
  if (!cap?.publicKeyPem) return null;
  try {
    const result = verifySignedRequest({
      method: method.toUpperCase(),
      path,
      headers: signed,
      publicKeyPem: cap.publicKeyPem,
      maxSkewMs: SECURITY_MAX_SKEW_MS
    });
    return result.valid ? signed["x-agent-id"] : null;
  } catch {
    return null;
  }
}

/** The account an agent works and pays for: its owner's, or the agent itself before it is linked. */
export async function agentAccount(agentId: string): Promise<string> {
  return (await pgStore?.getAgentOwnership(agentId))?.accountId ?? agentId;
}

/**
 * Agent-self routes: the request must be signed by a registered agent key, and when the route
 * names an agent (`claimedAgentId`, from the body or path) it must be the signer. Sends 401/403
 * and returns null otherwise.
 */
export async function requireAgentSelf(
  req: { headers?: unknown; url?: string; ip?: string },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  claimedAgentId?: string
): Promise<string | null> {
  const routePath = String(req.url ?? "").split("?")[0];
  const verified = await verifyAgentRequest((req.headers ?? {}) as Record<string, unknown>, routePath, req.ip, {
    requireSigned: true,
    rawBody: rawBodyOf(req as any)
  });
  if (!verified || verified === "rejected") {
    reply.code(401).send({ error: "agent_signature_required" });
    return null;
  }
  if (claimedAgentId !== undefined && claimedAgentId !== verified.agentId) {
    reply.code(403).send({ error: "agent_identity_mismatch" });
    return null;
  }
  return verified.agentId;
}

/** Routes the portal proxies for logged-in users (market data and standing orders) accept either token. */
export function requireMeshOrPortalToken(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
  const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
  if (hasMeshToken(headers) || hasPortalServiceToken(headers)) return true;
  reply.code(401).send({ error: "mesh_unauthorized" });
  return false;
}

/**
 * Account-scoped money routes (withdraw, set payout address, read a user's balance) require the
 * PORTAL service token specifically. The portal binds accountId = acct-<userId> from the session
 * before calling, so it is the only caller allowed to name an arbitrary accountId. Agents must NOT
 * be able to move another account's funds (audit econ#1).
 */
export function requirePortalServiceToken(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
  const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
  if (hasPortalServiceToken(headers)) return true;
  reply.code(401).send({ error: "portal_service_unauthorized" });
  return false;
}

export function extractSignedHeaders(headers: Record<string, unknown>): SignedHeaders | null {
  const agentId = headers["x-agent-id"];
  const timestampMs = headers["x-timestamp-ms"];
  const nonce = headers["x-nonce"];
  const bodySha256 = headers["x-body-sha256"];
  const signature = headers["x-signature"];
  if (
    typeof agentId !== "string" ||
    typeof timestampMs !== "string" ||
    typeof nonce !== "string" ||
    typeof bodySha256 !== "string" ||
    typeof signature !== "string"
  ) {
    return null;
  }
  return {
    "x-agent-id": agentId,
    "x-timestamp-ms": timestampMs,
    "x-nonce": nonce,
    "x-body-sha256": bodySha256,
    "x-signature": signature,
  };
}

export async function verifyAgentRequest(
  headers: Record<string, unknown>,
  routePath: string,
  sourceIp?: string,
  opts?: { allowUnsigned?: boolean; requireSigned?: boolean; rawBody?: string }
): Promise<{ agentId: string; nonce: string } | "rejected" | null> {
  const signed = extractSignedHeaders(headers);
  // #44: unsigned requests are rejected unless the policy is explicitly relaxed (non-prod),
  // or the route has its own alternative auth for unsigned callers (allowUnsigned).
  // requireSigned: the route acts on behalf of a named agent and has no other auth, so it is
  // signed-only whatever the policy (an unsigned caller could otherwise speak for any agent).
  if (!signed) return unsignedRequestDecision({ requireSignedPolicy: REQUIRE_SIGNED_AGENT_REQUESTS, ...opts });

  // The claimed id is not proven until the signature verifies: nothing before that is counted
  // against the agent (anyone can name it), only against the address the request came from.
  const agentId = signed["x-agent-id"];

  // 1. Skip rate limiting for loopback (embedded worker is trusted)
  const isLoopback = isLoopbackSocket(sourceIp, CLIENT_IP_TRUST);
  const clientIp = extractClientIp(headers, sourceIp, CLIENT_IP_TRUST) ?? "unknown";
  const rejectUnproven = (event: SecurityEventType, reason: string, countFailure = true): "rejected" => {
    if (!isLoopback && countFailure) preAuthFailures.record(clientIp);
    securityLog.log({
      level: securityLog.severity(event),
      event,
      source: { type: "system", id: "unauthenticated", ip: clientIp },
      details: { reason, route: routePath, claimedAgentId: agentId },
      action: "reject_request",
      coordinatorId: identity.peerId,
    });
    return "rejected";
  };

  // 2. An address sending many unverifiable requests is turned away before any checking.
  if (!isLoopback && preAuthFailures.blocked(clientIp)) return rejectUnproven("auth_rate_limit_hit", "too_many_failed_signatures");

  // 3. Look up agent public key (a missing key means the agent needs to re-register, e.g. after a
  //    coordinator restart: not counted as a failure)
  const cap = agentCapabilities.get(agentId);
  if (!cap?.publicKeyPem) return rejectUnproven("invalid_signature", "no_public_key", false);

  // 4. Verify signature
  const sigResult = verifySignedRequest({
    method: "POST",
    path: routePath,
    headers: signed,
    publicKeyPem: cap.publicKeyPem,
    maxSkewMs: SECURITY_MAX_SKEW_MS,
    // Body binding: x-body-sha256 must be the hash of the bytes actually received. Every agent
    // build since signing shipped hashes JSON.stringify(body), the same bytes it sends.
    rawBody: opts?.rawBody ?? "",
  });

  if (!sigResult.valid) {
    // Only a body mismatch comes after the signature checked out (a signed request replayed with a
    // new payload): that one is the agent's key. Skew and bad signatures prove nothing about who sent them.
    if (sigResult.reason !== "body_hash_mismatch") {
      return rejectUnproven(sigResult.reason === "timestamp_skew" ? "replay_attempt" : "invalid_signature", sigResult.reason ?? "invalid_signature");
    }
    securityLog.log({
      level: securityLog.severity("replay_attempt"),
      event: "replay_attempt",
      source: { type: "agent", id: agentId, ip: clientIp },
      details: { reason: sigResult.reason, route: routePath },
      action: "reject_request",
      coordinatorId: identity.peerId,
    });
    behaviorTracker.recordProtocolViolation(agentId, "replay_attempt");
    return "rejected";
  }

  // 5. Per-agent rate limit, now that the request is the agent's own — skip for loopback.
  //    Over the limit is not an authentication failure: the request is refused with 429 and
  //    Retry-After (AgentRateLimitedError, answered by the coordinator's error handler) and is
  //    not recorded as a protocol violation, so it feeds no behaviour rule.
  if (!isLoopback && !agentRateLimiter.check(agentId)) {
    const retryAfterMs = agentRateLimiter.retryAfterMs(agentId);
    securityLog.log({
      level: securityLog.severity("auth_rate_limit_hit"),
      event: "auth_rate_limit_hit",
      source: { type: "agent", id: agentId, ip: clientIp },
      details: { route: routePath, retryAfterMs },
      action: "reject_request",
      coordinatorId: identity.peerId,
    });
    throw new AgentRateLimitedError(retryAfterMs);
  }

  // 6. Nonce replay detection
  const nonceResult = await verifyNonce(nonceStore, {
    nonce: sigResult.nonce!,
    sourceId: agentId,
    timestampMs: Number(signed["x-timestamp-ms"]),
    maxSkewMs: SECURITY_MAX_SKEW_MS,
    ttlMs: SECURITY_NONCE_TTL_MS,
  });

  if (!nonceResult.valid) {
    securityLog.log({
      level: securityLog.severity("replay_attempt"),
      event: "replay_attempt",
      source: { type: "agent", id: agentId },
      details: { nonce: sigResult.nonce, reason: nonceResult.reason, route: routePath },
      action: "reject_request",
      coordinatorId: identity.peerId,
    });
    behaviorTracker.recordProtocolViolation(agentId, "replay_attempt");
    return "rejected";
  }

  return { agentId: sigResult.agentId!, nonce: sigResult.nonce! };
}

/** Whose credits a submitted task spends: see submitterAccountDecision. */
export async function resolveSubmitterAccount(
  req: { headers: Record<string, unknown>; ip: string },
  requested: string,
  routePath = "/submit"
): Promise<{ accountId: string } | { status: number; error: string }> {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const portalService = hasPortalServiceToken(headers);
  const verified = portalService
    ? null
    : await verifyAgentRequest(headers, routePath, req.ip, { allowUnsigned: true, rawBody: rawBodyOf(req as any) });
  const signer = verified && verified !== "rejected" ? verified.agentId : null;
  return submitterAccountDecision({
    requested,
    portalService,
    signature: verified === "rejected" ? "rejected" : signer ? { agentId: signer } : null,
    ownerAccountId: signer ? (await pgStore?.getAgentOwnership(signer))?.accountId : undefined,
    loopback: req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1"
  });
}

/**
 * Whose account an /account/* call is for: the portal (service token) names it; otherwise the
 * signing agent's owner (or the agent itself when it has no owner yet).
 */
/** Who called an account route: the portal (service token, naming the account) or a signed agent (billed to its owner). */
export type CallerAccount = { accountId: string; via: "portal" } | { accountId: string; via: "agent"; agentId: string; ownerAccountId: string | null };

export async function callerAccount(req: any, routePath: string, requested?: string): Promise<CallerAccount | { status: number; error: string }> {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  // The portal path needs the header itself: with no token configured (development) every request
  // would otherwise count as the portal's.
  if (headers["x-portal-service-token"] !== undefined && hasPortalServiceToken(headers)) return requested ? { accountId: requested, via: "portal" } : { status: 400, error: "account_required" };
  const verified = await verifyAgentRequest(headers, routePath, req.ip, { requireSigned: true, rawBody: rawBodyOf(req) });
  if (!verified || verified === "rejected") return { status: 401, error: "signature_invalid" };
  const ownerAccountId = (await pgStore?.getAgentOwnership(verified.agentId))?.accountId ?? null;
  return { accountId: ownerAccountId ?? verified.agentId, via: "agent", agentId: verified.agentId, ownerAccountId };
}

/* ── Admin dashboard (token-gated) ── */
export const ADMIN_API_TOKEN = ADMIN_API_TOKENS.current;

/**
 * Operator routes: the request must come from inside (loopback, Fly's private network, or
 * ADMIN_ALLOWED_CIDRS, decided from the socket; never through the public edge proxy) and carry the
 * admin token (current, or the previous one during a rotation). See src/common/admin-origin.ts.
 */
export function authorizeAdmin(req: any, reply: any): boolean {
  if (!ADMIN_API_TOKENS.current) {
    reply.code(503).send({ error: "admin_dashboard_not_configured" });
    return false;
  }
  const origin = adminOriginDecision(socketAddressOf(req), (req.headers ?? {}) as Record<string, unknown>, ADMIN_ORIGIN_POLICY);
  if (!origin.ok) {
    reply.code(403).send({ error: "admin_internal_only", reason: origin.reason });
    return false;
  }
  const headerToken = readHeaderValue(req.headers ?? {}, "x-admin-token");
  if (!headerToken || !matchesTokenSet(headerToken, ADMIN_API_TOKENS)) {
    reply.code(401).send({ error: "invalid_admin_token" });
    return false;
  }
  return true;
}

/** authorizeAdmin without a reply: true only for an internal request with a valid admin token. */
export function isAdminRequest(req: any): boolean {
  if (!ADMIN_API_TOKENS.current) return false;
  if (!adminOriginDecision(socketAddressOf(req), (req.headers ?? {}) as Record<string, unknown>, ADMIN_ORIGIN_POLICY).ok) return false;
  return matchesTokenSet(readHeaderValue(req.headers ?? {}, "x-admin-token"), ADMIN_API_TOKENS);
}

/**
 * Money routes the portal calls for a logged-in user (withdraw, payout destinations, callback
 * confirmation). The service token is required; on top of it, a portal action assertion
 * (src/security/portal-action.ts) binds the request to the account, the action and its
 * parameters. An assertion that is present is always checked. Without one the request is refused
 * when REQUIRE_PORTAL_ACTION_SIGNATURE is on, and accepted (logged) during the transition.
 * Sends the refusal and returns false.
 */
export async function requirePortalMoneyAction(
  req: any,
  reply: any,
  expected: { accountId: string; action: PortalAction; body: Record<string, unknown> },
  opts: { require?: boolean; keys?: typeof PORTAL_ACTION_KEYS } = {}
): Promise<boolean> {
  const required = opts.require ?? REQUIRE_PORTAL_ACTION_SIGNATURE;
  const keys = opts.keys ?? PORTAL_ACTION_KEYS;
  const header = readHeaderValue(req.headers ?? {}, PORTAL_ACTION_HEADER);
  const log = (req as { log?: { warn: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void } }).log;
  if (!header) {
    if (!required) {
      log?.info({ action: expected.action, accountId: expected.accountId }, "portal_action_unsigned_accepted");
      return true;
    }
    reply.code(401).send({ ok: false, error: "portal_action_signature_required" });
    return false;
  }
  if (keys.length === 0) {
    reply.code(503).send({ ok: false, error: "portal_action_keys_not_configured" });
    return false;
  }
  const result = await verifyPortalAction(header, expected, {
    keys,
    nonceOnce: async (nonce, expiresAtMs) => {
      if (nonceStore.insertIfAbsent) return nonceStore.insertIfAbsent(nonce, "portal", expiresAtMs);
      if (await nonceStore.exists(nonce)) return false;
      await nonceStore.insert(nonce, "portal", expiresAtMs);
      return true;
    }
  });
  if (!result.ok) {
    log?.warn({ action: expected.action, accountId: expected.accountId, reason: result.reason }, "portal_action_refused");
    reply.code(401).send({ ok: false, error: "portal_action_invalid", reason: result.reason });
    return false;
  }
  return true;
}

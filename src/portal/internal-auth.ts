// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { safeTokenEqual } from "../common/crypto-utils.js";
import { checkTokenSet } from "../common/env-guard.js";
import { matchesTokenSet, tokenSet } from "../common/token-rotation.js";
import { hasCoordinatorPortalSignature } from "../security/service-request-signing.js";
import { scopeForRoute, verifyCoordinatorCredential, type CoordinatorCaller, type CoordinatorCredentialDeps } from "./coordinator-credentials.js";

/*
 * Who may call the portal's /internal/* routes.
 *
 * - The platform service token (PORTAL_SERVICE_TOKEN): every route, full answers.
 * - A coordinator, by its own signature (src/portal/coordinator-credentials.ts): the request is signed
 *   with the coordinator's identity key, which the portal trusts for that coordinator (credential row,
 *   registry, or its enrolment). Only the routes its scopes name (nodes:validate, nodes:lookup:self,
 *   stats:read); answers are scoped to that coordinator and never carry owner email, IP or country.
 *   Verified in full once the body is in (verifyInternalCaller, preValidation).
 * - The shared coordinator token (PORTAL_COORDINATOR_TOKEN), deprecated: accepted while
 *   PORTAL_COORDINATOR_TOKEN_ACCEPTED is on (the default during the migration), with a warning in the
 *   log. Scoped like before: /internal/nodes/lookup answers only about nodes its own coordinator
 *   validated (x-coordinator-node-id + registration token), without owner email, IP or country.
 * - Mutation routes (node approval, coordinator credentials) also need the control-plane admin
 *   credential (CONTROL_PLANE_ADMIN_TOKEN, sent as x-admin-token or Authorization: Bearer). A service
 *   or coordinator credential alone is refused.
 */

export interface InternalAuthConfig {
  serviceToken: string;
  /** Deprecated read/validate-only token shared by outside coordinators. */
  coordinatorToken?: string;
  /** false: PORTAL_COORDINATOR_TOKEN is no longer accepted (default true during the migration). */
  acceptCoordinatorToken?: boolean;
  /** Per-coordinator signed credentials; null/absent: coordinator signatures are not checked. */
  coordinatorCredentials?: CoordinatorCredentialDeps | null;
  /** The control-plane admin credential; empty means mutations are refused (503). */
  adminToken: string;
  /** PORTAL_ALLOW_OPEN_INTERNAL=1 outside production: an unset token is open. */
  allowOpenWhenUnset: boolean;
  /** Rotation (docs/security/rotation.md): previous values, accepted until previousUntil. */
  serviceTokenPrevious?: string;
  adminTokenPrevious?: string;
  previousUntil?: string;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  now?: () => number;
}

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };
type Req = { headers: Record<string, unknown> };
type HookReq = Req & { method?: string; url?: string; routeOptions?: { url?: string }; rawBody?: string };

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

/** How often the deprecated-token warning is logged at most (per portal process). */
export const COORDINATOR_TOKEN_WARN_EVERY_MS = 60_000;

export function createInternalAuth(cfg: InternalAuthConfig) {
  const coordinatorToken = (cfg.coordinatorToken ?? "").trim();
  const acceptCoordinatorToken = cfg.acceptCoordinatorToken ?? true;
  const serviceTokens = tokenSet(cfg.serviceToken, cfg.serviceTokenPrevious, cfg.previousUntil);
  const adminTokens = tokenSet(cfg.adminToken, cfg.adminTokenPrevious, cfg.previousUntil);
  const credentials = cfg.coordinatorCredentials ?? null;
  const signed = new WeakMap<object, CoordinatorCaller>();
  const now = cfg.now ?? Date.now;
  let warnedAt = -Infinity;

  const isService = (req: Req) => checkTokenSet(serviceTokens, header(req.headers, "x-portal-service-token"), true) === "ok";
  const hasLegacyCoordinatorToken = (req: Req) => {
    const provided = header(req.headers, "x-portal-service-token");
    return acceptCoordinatorToken && Boolean(coordinatorToken) && typeof provided === "string" && safeTokenEqual(provided, coordinatorToken);
  };
  const carriesSignature = (req: Req) => credentials !== null && hasCoordinatorPortalSignature(req.headers);
  const warnLegacy = (req: HookReq, reason: string) => {
    if (now() - warnedAt < COORDINATOR_TOKEN_WARN_EVERY_MS) return;
    warnedAt = now();
    cfg.log?.warn({ route: String(req.url ?? "").split("?")[0], reason }, "portal_coordinator_token_deprecated");
  };

  /** Read/validate access in a route handler: the service token, a verified coordinator signature, or the deprecated coordinator token. */
  function requireInternalToken(req: Req, reply: Reply): boolean {
    if (signed.has(req)) return true;
    if (hasLegacyCoordinatorToken(req)) return true;
    const provided = header(req.headers, "x-portal-service-token");
    const result = checkTokenSet(serviceTokens, provided, !cfg.allowOpenWhenUnset);
    // An unverified coordinator signature never falls through to an open (unset-token) portal.
    if (result === "ok" && !(carriesSignature(req) && !isService(req))) return true;
    if (result === "not_configured" && !coordinatorToken && !credentials) {
      reply.code(503).send({ error: "internal_auth_not_configured" });
      return false;
    }
    reply.code(401).send({ error: "portal_service_token_required" });
    return false;
  }

  /**
   * The plugin's onRequest gate (before the body is read). A request carrying a coordinator
   * signature is let through to verifyInternalCaller, which checks it in full.
   */
  function gateInternal(req: Req, reply: Reply): boolean {
    if (carriesSignature(req) && !isService(req)) return true;
    return requireInternalToken(req, reply);
  }

  /**
   * preValidation: a coordinator signature is verified in full (key trust, revocation, body hash,
   * nonce) and its scope checked against the route; on success the request is that coordinator's.
   * A failed signature is refused unless the deprecated coordinator token stands in for it.
   */
  async function verifyInternalCaller(req: HookReq, reply: Reply): Promise<boolean> {
    if (isService(req)) return true;
    if (carriesSignature(req)) {
      const decision = await verifyCoordinatorCredential(credentials!, {
        headers: req.headers,
        method: String(req.method ?? "GET"),
        path: String(req.url ?? ""),
        rawBody: req.rawBody ?? ""
      });
      if (!decision.ok) {
        if (hasLegacyCoordinatorToken(req)) {
          warnLegacy(req, decision.error);
          return true;
        }
        reply.code(decision.code).send({ error: decision.error });
        return false;
      }
      const scope = scopeForRoute(String(req.method ?? "GET"), String(req.routeOptions?.url ?? ""));
      if (!scope || !decision.scopes.includes(scope)) {
        reply.code(403).send({ error: "coordinator_scope_denied", ...(scope ? { scope } : {}) });
        return false;
      }
      const { ok: _ok, ...caller } = decision;
      signed.set(req, caller);
      return true;
    }
    if (hasLegacyCoordinatorToken(req)) warnLegacy(req, "token_only");
    return true;
  }

  /** Mutation access: the control-plane admin credential, whatever service token is presented. */
  function requireControlPlaneAdmin(req: Req, reply: Reply): boolean {
    if (!cfg.adminToken) {
      if (cfg.allowOpenWhenUnset) return true;
      reply.code(503).send({ error: "control_plane_admin_not_configured" });
      return false;
    }
    const bearer = header(req.headers, "authorization");
    const provided = header(req.headers, "x-admin-token") ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : undefined);
    if (provided && matchesTokenSet(provided, adminTokens)) return true;
    reply.code(403).send({ error: "control_plane_admin_required" });
    return false;
  }

  /**
   * Which credential a request that passed requireInternalToken carries. The platform service token
   * wins when both values match (a misconfiguration that gives the coordinator token full reach).
   * "coordinator": a signed coordinator or the deprecated coordinator token (scoped answers).
   * "open" only when internal auth is unset and PORTAL_ALLOW_OPEN_INTERNAL allows it.
   */
  function callerKind(req: Req): "service" | "coordinator" | "open" | null {
    if (isService(req)) return "service";
    if (signed.has(req)) return "coordinator";
    if (hasLegacyCoordinatorToken(req)) return "coordinator";
    if (carriesSignature(req)) return null;
    if (checkTokenSet(serviceTokens, header(req.headers, "x-portal-service-token"), !cfg.allowOpenWhenUnset) === "ok") return "open";
    return null;
  }

  /** The coordinator a verified signature came from (null for every other caller). */
  function signedCoordinatorOf(req: Req): CoordinatorCaller | null {
    return signed.get(req) ?? null;
  }

  return { requireInternalToken, gateInternal, verifyInternalCaller, requireControlPlaneAdmin, callerKind, signedCoordinatorOf };
}

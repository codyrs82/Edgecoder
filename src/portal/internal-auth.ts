// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { safeTokenEqual } from "../common/crypto-utils.js";
import { checkTokenSet } from "../common/env-guard.js";
import { matchesTokenSet, tokenSet } from "../common/token-rotation.js";

/*
 * Who may call the portal's /internal/* routes.
 *
 * - Read and validate routes (nodes/validate, nodes/lookup, nodes/pending, stats/counts) accept the
 *   portal service token (PORTAL_SERVICE_TOKEN) or, when set, the coordinator token
 *   (PORTAL_COORDINATOR_TOKEN). Coordinators should be given only the coordinator token.
 * - Callers holding the coordinator token (the one shared by every outside coordinator) are scoped:
 *   /internal/nodes/lookup answers them only about nodes their own coordinator validated, and
 *   never with owner email, IP or country (routes/internal.ts). `callerKind` tells the two apart.
 * - Mutation routes (node approval) also need the control-plane admin credential
 *   (CONTROL_PLANE_ADMIN_TOKEN, sent as x-admin-token or Authorization: Bearer). A service or
 *   coordinator token alone is refused.
 */

export interface InternalAuthConfig {
  serviceToken: string;
  /** Optional read/validate-only token for coordinators. */
  coordinatorToken?: string;
  /** The control-plane admin credential; empty means mutations are refused (503). */
  adminToken: string;
  /** PORTAL_ALLOW_OPEN_INTERNAL=1 outside production: an unset token is open. */
  allowOpenWhenUnset: boolean;
  /** Rotation (docs/security/rotation.md): previous values, accepted until previousUntil. */
  serviceTokenPrevious?: string;
  adminTokenPrevious?: string;
  previousUntil?: string;
}

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };
type Req = { headers: Record<string, unknown> };

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

export function createInternalAuth(cfg: InternalAuthConfig) {
  const coordinatorToken = (cfg.coordinatorToken ?? "").trim();
  const serviceTokens = tokenSet(cfg.serviceToken, cfg.serviceTokenPrevious, cfg.previousUntil);
  const adminTokens = tokenSet(cfg.adminToken, cfg.adminTokenPrevious, cfg.previousUntil);

  /** Read/validate access: the service token or the coordinator token. */
  function requireInternalToken(req: Req, reply: Reply): boolean {
    const provided = header(req.headers, "x-portal-service-token");
    if (coordinatorToken && typeof provided === "string" && safeTokenEqual(provided, coordinatorToken)) return true;
    const result = checkTokenSet(serviceTokens, provided, !cfg.allowOpenWhenUnset);
    if (result === "ok") return true;
    if (result === "not_configured" && !coordinatorToken) {
      reply.code(503).send({ error: "internal_auth_not_configured" });
      return false;
    }
    reply.code(401).send({ error: "portal_service_token_required" });
    return false;
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
   * "open" only when internal auth is unset and PORTAL_ALLOW_OPEN_INTERNAL allows it.
   */
  function callerKind(req: Req): "service" | "coordinator" | "open" | null {
    const provided = header(req.headers, "x-portal-service-token");
    if (checkTokenSet(serviceTokens, provided, true) === "ok") return "service";
    if (coordinatorToken && typeof provided === "string" && safeTokenEqual(provided, coordinatorToken)) return "coordinator";
    if (checkTokenSet(serviceTokens, provided, !cfg.allowOpenWhenUnset) === "ok") return "open";
    return null;
  }

  return { requireInternalToken, requireControlPlaneAdmin, callerKind };
}

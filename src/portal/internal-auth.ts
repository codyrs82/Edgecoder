// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { safeTokenEqual } from "../common/crypto-utils.js";
import { checkInternalServiceToken } from "../common/env-guard.js";

/*
 * Who may call the portal's /internal/* routes.
 *
 * - Read and validate routes (nodes/validate, nodes/lookup, nodes/pending, stats/counts) accept the
 *   portal service token (PORTAL_SERVICE_TOKEN) or, when set, the coordinator token
 *   (PORTAL_COORDINATOR_TOKEN). Coordinators should be given only the coordinator token.
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

  /** Read/validate access: the service token or the coordinator token. */
  function requireInternalToken(req: Req, reply: Reply): boolean {
    const provided = header(req.headers, "x-portal-service-token");
    if (coordinatorToken && typeof provided === "string" && safeTokenEqual(provided, coordinatorToken)) return true;
    const result = checkInternalServiceToken(cfg.serviceToken, provided, { allowOpenWhenUnset: cfg.allowOpenWhenUnset });
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
    if (provided && safeTokenEqual(provided, cfg.adminToken)) return true;
    reply.code(403).send({ error: "control_plane_admin_required" });
    return false;
  }

  return { requireInternalToken, requireControlPlaneAdmin };
}

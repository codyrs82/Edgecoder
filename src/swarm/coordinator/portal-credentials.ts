// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { safeTokenEqual } from "../../common/crypto-utils.js";
import { checkTokenSet, type SharedTokenCheck } from "../../common/env-guard.js";
import type { TokenSet } from "../../common/token-rotation.js";

/**
 * Inbound "this request is from the portal" check (x-portal-service-token). PORTAL_COORDINATOR_TOKEN
 * is the outbound-only credential every outside coordinator shares for the portal's /internal reads,
 * so it never counts as the portal here, even when PORTAL_SERVICE_TOKEN (or its previous value) was
 * set to the same value. Everything else is the usual PORTAL_SERVICE_TOKEN check.
 */
export function checkPortalInboundToken(serviceTokens: TokenSet, outboundOnlyToken: string, provided: unknown, isProd: boolean): SharedTokenCheck {
  const outbound = outboundOnlyToken.trim();
  if (outbound && typeof provided === "string" && safeTokenEqual(provided, outbound)) return "unauthorized";
  return checkTokenSet(serviceTokens, provided, isProd);
}

/**
 * Headers for the portal's /internal/nodes routes: the outbound token and, when this coordinator is
 * enrolled (COORDINATOR_REGISTRATION_TOKEN), its node id and registration token. With the shared
 * coordinator token the portal records which coordinator validated a node and answers lookups only
 * about those nodes (src/portal/routes/internal.ts).
 */
export function portalOutboundHeaders(peerId: string, registrationToken: string, outboundToken: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (outboundToken) headers["x-portal-service-token"] = outboundToken;
  if (registrationToken) {
    headers["x-coordinator-node-id"] = peerId;
    headers["x-coordinator-registration-token"] = registrationToken;
  }
  return headers;
}

/**
 * Whether a portal validation named the node's owner. Portals answer the shared coordinator token
 * with the owner's user id only (no email), so either one counts.
 */
export function portalOwnerKnown(activation: { ownerEmail?: string; ownerUserId?: string }): boolean {
  return Boolean(activation.ownerEmail || activation.ownerUserId);
}

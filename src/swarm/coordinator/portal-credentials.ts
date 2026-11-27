// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { KeyObject } from "node:crypto";
import { safeTokenEqual } from "../../common/crypto-utils.js";
import { checkTokenSet, type SharedTokenCheck } from "../../common/env-guard.js";
import type { TokenSet } from "../../common/token-rotation.js";
import {
  audienceOf,
  hasPortalRequestSignature,
  signCoordinatorPortalRequest,
  verifyPortalRequest,
  type PortalRequestDecision
} from "../../security/service-request-signing.js";

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
 * The legacy service-token path, behind the migration flag PORTAL_SERVICE_TOKEN_INBOUND: off, the
 * token never counts as the portal (only a portal-signed request does).
 */
export function legacyPortalTokenAccepted(serviceTokens: TokenSet, outboundOnlyToken: string, provided: unknown, isProd: boolean, acceptToken: boolean): boolean {
  return acceptToken && checkPortalInboundToken(serviceTokens, outboundOnlyToken, provided, isProd) === "ok";
}

/**
 * Inbound portal auth (src/security/service-request-signing.ts): a request the portal signed for
 * this coordinator. `keys` are PORTAL_ACTION_VERIFY_KEYS; `audiences` are this coordinator's own
 * origins (COORDINATOR_PUBLIC_URL plus PORTAL_REQUEST_AUDIENCES). With no keys configured nothing
 * can be checked, so a signature is ignored and the token rules decide, as before.
 */
export interface PortalInboundSignatureConfig {
  keys: readonly KeyObject[];
  audiences: ReadonlySet<string> | null;
}

/**
 * The origins a portal-signed request may name as its audience. Outside production with no origin
 * configured any audience passes (local development); in production with none, no signature does.
 */
export function portalRequestAudiences(publicUrl: string | undefined, extra: string | undefined, isProd: boolean): ReadonlySet<string> | null {
  const set = new Set<string>();
  for (const u of [publicUrl ?? "", ...(extra ?? "").split(",")]) {
    const a = audienceOf(u);
    if (a) set.add(a);
  }
  if (set.size === 0) return isProd ? set : null;
  return set;
}

/** Whether portal signatures are checked at all (PORTAL_ACTION_VERIFY_KEYS is set). */
export function portalSignaturesChecked(cfg: PortalInboundSignatureConfig): boolean {
  return cfg.keys.length > 0;
}

/**
 * Transport-gate check (before the body is read): a fresh portal signature over this method, path
 * and audience. The body hash and the nonce are checked once the body is in (verifyPortalInFull).
 */
export async function portalSignatureAtGate(headers: Record<string, unknown>, method: string, url: string, cfg: PortalInboundSignatureConfig): Promise<boolean> {
  if (!portalSignaturesChecked(cfg) || !hasPortalRequestSignature(headers)) return false;
  return (await verifyPortalRequest({ headers, method, path: url, keys: cfg.keys, audiences: cfg.audiences })).ok;
}

/** Full check of a portal signature: headers, audience, body hash against the bytes received, single-use nonce. */
export function verifyPortalInFull(
  headers: Record<string, unknown>,
  method: string,
  url: string,
  rawBody: string,
  cfg: PortalInboundSignatureConfig,
  replay: (nonce: string, issuedAtMs: number) => boolean | Promise<boolean>
): Promise<PortalRequestDecision> {
  return verifyPortalRequest({ headers, method, path: url, rawBody, keys: cfg.keys, audiences: cfg.audiences, replay });
}

/**
 * What a request that carries a portal signature gets once the body is in:
 * - "signed": the signature verified in full; the request is the portal's.
 * - "token": the signature failed, but the legacy service token is valid and still accepted
 *   (PORTAL_SERVICE_TOKEN_INBOUND); the token decides, as before.
 * - "refuse": the signature failed and nothing else stands in for it.
 */
export function portalSignatureOutcome(decision: PortalRequestDecision, legacyTokenOk: boolean): "signed" | "token" | "refuse" {
  if (decision.ok) return "signed";
  return legacyTokenOk ? "token" : "refuse";
}

/**
 * Headers for the portal's /internal/nodes routes: the outbound token and, when this coordinator is
 * enrolled (COORDINATOR_REGISTRATION_TOKEN), its node id and registration token. With the shared
 * coordinator token the portal records which coordinator validated a node and answers lookups only
 * about those nodes (src/portal/routes/internal.ts).
 */
export function portalOutboundHeaders(peerId: string, registrationToken: string, outboundToken: string, signing?: PortalOutboundSigning): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (outboundToken) headers["x-portal-service-token"] = outboundToken;
  if (registrationToken) {
    headers["x-coordinator-node-id"] = peerId;
    headers["x-coordinator-registration-token"] = registrationToken;
  }
  if (signing) Object.assign(headers, signCoordinatorPortalRequest({ coordinatorId: peerId, ...signing }));
  return headers;
}

/**
 * Outbound portal auth: the coordinator signs each call to the portal with its own identity key
 * (COORDINATOR_PRIVATE_KEY_PEM), so it needs no shared token for /internal/nodes/validate,
 * /internal/nodes/lookup and /internal/stats/counts. The token, when one is still configured,
 * goes along during the migration.
 */
export interface PortalOutboundSigning {
  privateKeyPem: string;
  publicKeyPem: string;
  method: string;
  url: string;
  body?: string | null;
}

/**
 * Whether a portal validation named the node's owner. Portals answer the shared coordinator token
 * with the owner's user id only (no email), so either one counts.
 */
export function portalOwnerKnown(activation: { ownerEmail?: string; ownerUserId?: string }): boolean {
  return Boolean(activation.ownerEmail || activation.ownerUserId);
}

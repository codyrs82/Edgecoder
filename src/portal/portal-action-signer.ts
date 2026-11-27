// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { KeyObject } from "node:crypto";
import { PORTAL_ACTION_HEADER, parseSigningKey, signPortalAction, type PortalAction } from "../security/portal-action.js";

/*
 * The portal's side of portal action assertions (src/security/portal-action.ts): every request
 * that withdraws or changes a payout destination for a logged-in user carries a short-lived
 * assertion signed with PORTAL_ACTION_SIGNING_KEY, bound to that user's account, the action and
 * its parameters. Without the key no header is added (the coordinators accept that only while
 * REQUIRE_PORTAL_ACTION_SIGNATURE is off).
 */

let cache: { raw: string; key: KeyObject | null } | undefined;

/** PORTAL_ACTION_SIGNING_KEY, parsed once; also signs the portal's calls to coordinators (coordinator-request.ts). */
export function signingKey(env: NodeJS.ProcessEnv = process.env): KeyObject | null {
  const raw = (env.PORTAL_ACTION_SIGNING_KEY ?? "").trim();
  if (cache?.raw === raw) return cache.key;
  cache = { raw, key: raw ? parseSigningKey(raw) : null };
  return cache.key;
}

/** `{ "x-portal-action": <assertion> }`, or {} when no signing key is configured. */
export function portalActionHeaders(accountId: string, action: PortalAction, body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = signingKey(env);
  if (!key) return {};
  return { [PORTAL_ACTION_HEADER]: signPortalAction(key, { accountId, action, body }) };
}

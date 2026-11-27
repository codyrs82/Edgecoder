// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { KeyObject } from "node:crypto";
import { request } from "undici";
import { moduleLogger } from "../common/logger.js";
import { PORTAL_ACCOUNT_HEADER, signPortalRequest } from "../security/service-request-signing.js";
import { coordinatorUrlAllowed, type CoordinatorUrlPolicy } from "./coordinator-url-policy.js";
import { signingKey } from "./portal-action-signer.js";

/*
 * Every call the portal makes to a coordinator goes through coordinatorRequest (a drop-in for
 * undici's request):
 * - it is signed with the portal's key (PORTAL_ACTION_SIGNING_KEY) for that coordinator's origin,
 *   covering the method, path, body and the account the call acts for (x-edgecoder-account), so the
 *   coordinator can tell it is the portal's and a copy is useless anywhere else
 *   (src/security/service-request-signing.ts);
 * - PORTAL_SERVICE_TOKEN (x-portal-service-token) goes only to the platform's own coordinators: the
 *   static allowlist (PORTAL_COORDINATOR_HOSTS, else the COORDINATOR_DISCOVERY_URLS hosts), and never
 *   to a host the signed registry lists as an outside member. Outside coordinators therefore never
 *   receive anything that works on the seeds.
 */

const logger = moduleLogger("portal-coordinator-request");

export interface PortalCoordinatorAuth {
  /** The portal's signing key; null: calls are not signed (coordinators then rely on the token). */
  signingKey: () => KeyObject | null;
  /** Whether PORTAL_SERVICE_TOKEN may be sent to this URL. */
  tokenAllowed: (url: string) => boolean;
}

const defaults: PortalCoordinatorAuth = { signingKey: () => signingKey(process.env), tokenAllowed: () => true };
let auth: PortalCoordinatorAuth = defaults;

export function configurePortalCoordinatorAuth(next: Partial<PortalCoordinatorAuth>): void {
  auth = { ...defaults, ...next };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * Where the service token may go: hosts the static policy allows (any, outside production without
 * PORTAL_COORDINATOR_HOSTS), minus every host of an outside registry member.
 */
export function serviceTokenHostPolicy(staticPolicy: CoordinatorUrlPolicy, outsideHosts: () => ReadonlySet<string>): (url: string) => boolean {
  return (url) => {
    const host = hostOf(url);
    if (!host || outsideHosts().has(host)) return false;
    return coordinatorUrlAllowed(url, staticPolicy);
  };
}

type Opts = NonNullable<Parameters<typeof request>[1]>;

function plainHeaders(h: Opts["headers"]): Record<string, string> | null {
  if (h === undefined || h === null) return {};
  if (Array.isArray(h) || typeof h !== "object" || typeof (h as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** The headers one portal call to `url` carries: the token only where allowed, plus the portal's signature. */
export function portalCoordinatorHeaders(method: string, url: string, headers: Record<string, string>, body?: string | Buffer | null, cfg: PortalCoordinatorAuth = auth): Record<string, string> {
  const out = { ...headers };
  if (out["x-portal-service-token"] !== undefined && !cfg.tokenAllowed(url)) delete out["x-portal-service-token"];
  const key = cfg.signingKey();
  if (key) Object.assign(out, signPortalRequest({ key, url, method, body, account: out[PORTAL_ACCOUNT_HEADER] }));
  return out;
}

/** undici's request, as the portal calling a coordinator (see above). */
export function coordinatorRequest(url: string, opts: Opts = {}): ReturnType<typeof request> {
  const method = String(opts.method ?? "GET").toUpperCase();
  const headers = plainHeaders(opts.headers);
  const body = opts.body;
  if (!headers || (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body))) {
    // Never sent unsigned with the token by accident: only plain headers and string bodies are supported.
    logger.warn({ url: url.split("?")[0] }, "portal_coordinator_request_unsupported_shape");
    const stripped = headers ? { ...headers } : {};
    delete stripped["x-portal-service-token"];
    return request(url, { ...opts, headers: stripped });
  }
  return request(url, { ...opts, headers: portalCoordinatorHeaders(method, url, headers, body as string | Buffer | null | undefined) });
}

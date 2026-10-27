// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { safeTokenEqual } from "./crypto-utils.js";

/**
 * #5: bind to localhost unless HOST is set explicitly (Fly/Docker set HOST=0.0.0.0).
 */
export function resolveListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = (env.HOST ?? "").trim();
  return host || "127.0.0.1";
}

export const LISTEN_HOST = resolveListenHost();

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

/** Throws in production when any of `names` is empty/whitespace; no-op elsewhere. */
export function requireProdEnv(service: string, names: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const missing = names.filter((n) => !(env[n] ?? "").trim());
  if (missing.length) {
    throw new Error(`[${service}] missing required production env: ${missing.join(", ")}`);
  }
}

export type SharedTokenCheck = "ok" | "unauthorized" | "not_configured";

/**
 * Shared-secret header check that is safe when the secret is empty:
 * - configured: constant-time compare -> "ok" | "unauthorized"
 * - empty in production: "not_configured" (callers answer 503, never open)
 * - empty outside production: "ok" (local-dev convenience, unchanged behaviour)
 */
export function checkSharedToken(
  configured: string,
  provided: unknown,
  isProd: boolean = isProduction()
): SharedTokenCheck {
  if (!configured) return isProd ? "not_configured" : "ok";
  return typeof provided === "string" && safeTokenEqual(provided, configured) ? "ok" : "unauthorized";
}

/**
 * #40: portal /internal/* auth. Unlike checkSharedToken, an empty token is never
 * open unless explicitly allowed (PORTAL_ALLOW_OPEN_INTERNAL=1, non-production only).
 */
export function checkInternalServiceToken(
  configured: string,
  provided: unknown,
  opts: { allowOpenWhenUnset: boolean }
): SharedTokenCheck {
  return checkSharedToken(configured, provided, !opts.allowOpenWhenUnset);
}

export function portalAllowOpenInternal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.PORTAL_ALLOW_OPEN_INTERNAL === "1";
}

/** #40: /debug/* routes exist only outside production and only when ENABLE_DEBUG_ROUTES=1. */
export function debugRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.ENABLE_DEBUG_ROUTES === "1";
}

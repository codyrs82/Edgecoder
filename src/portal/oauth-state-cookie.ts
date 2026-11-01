// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * #88: bind the OAuth `state` to the browser that started the flow (login CSRF / session
 * fixation). /start sets a __Host- cookie holding provider, state and an HMAC of both; the
 * callback requires the cookie, checks it in constant time against the state it received and
 * the provider in the URL, and clears it. The server-side state row stays single-use, and it is
 * consumed before the cookie check, so a failed callback still burns the state.
 *
 * GET-redirect providers (Google, Microsoft, GitHub) use SameSite=Lax. Apple's form_post
 * callback arrives as a cross-site POST, so Apple gets its own SameSite=None cookie
 * (__Host-oauth_state_apple). Apple stays disabled until it is wired (#30).
 *
 * The HMAC key is OAUTH_STATE_SECRET (32+ chars). Production refuses to start without it
 * (oauthStateSecretProblem). Outside production a random per-process key is used when it is
 * unset, which only works for one portal instance.
 */

export const OAUTH_STATE_TTL_SECONDS = 600;
export const OAUTH_STATE_COOKIE = "__Host-oauth_state";
export const OAUTH_STATE_COOKIE_APPLE = "__Host-oauth_state_apple";

export type OauthStateProvider = "google" | "microsoft" | "github" | "apple";

export function oauthStateCookieName(provider: OauthStateProvider): string {
  return provider === "apple" ? OAUTH_STATE_COOKIE_APPLE : OAUTH_STATE_COOKIE;
}

export function oauthStateKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.OAUTH_STATE_SECRET?.trim();
  return configured ? Buffer.from(configured, "utf8") : randomBytes(32);
}

export const OAUTH_STATE_SECRET_MIN_LENGTH = 32;

/** Startup check: null when OK, else the reason the portal must not start. */
export function oauthStateSecretProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.NODE_ENV ?? "development") !== "production") return null;
  const configured = env.OAUTH_STATE_SECRET?.trim() ?? "";
  if (!configured) return "OAUTH_STATE_SECRET is required in production.";
  if (configured.length < OAUTH_STATE_SECRET_MIN_LENGTH) {
    return `OAUTH_STATE_SECRET must be at least ${OAUTH_STATE_SECRET_MIN_LENGTH} characters in production.`;
  }
  return null;
}

/** Throws oauthStateSecretProblem() at portal startup. */
export function assertOauthStateSecret(env: NodeJS.ProcessEnv = process.env): void {
  const problem = oauthStateSecretProblem(env);
  if (problem) throw new Error(problem);
}

function mac(key: Buffer, provider: string, state: string): string {
  return createHmac("sha256", key).update(`${provider}.${state}`).digest("base64url");
}

function cookieAttrs(provider: OauthStateProvider, maxAge: number): string {
  const sameSite = provider === "apple" ? "None" : "Lax";
  return `Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

/** Set-Cookie value for /start. */
export function oauthStateSetCookie(key: Buffer, provider: OauthStateProvider, state: string): string {
  const value = `${provider}.${state}.${mac(key, provider, state)}`;
  return `${oauthStateCookieName(provider)}=${value}; ${cookieAttrs(provider, OAUTH_STATE_TTL_SECONDS)}`;
}

/** Set-Cookie value that clears the state cookie (always sent by the callback). */
export function oauthStateClearCookie(provider: OauthStateProvider): string {
  return `${oauthStateCookieName(provider)}=; ${cookieAttrs(provider, 0)}`;
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True only if the cookie was issued by this server for this provider and this state. */
export function oauthStateCookieMatches(
  key: Buffer,
  cookieValue: string | undefined,
  provider: OauthStateProvider,
  state: string
): boolean {
  if (!cookieValue) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return false;
  const [p, s, m] = parts;
  // evaluate every comparison so timing doesn't reveal which part differed
  const okProvider = eq(p, provider);
  const okState = eq(s, state);
  const okMac = eq(m, mac(key, p, s));
  return okProvider && okState && okMac;
}

/** Append a Set-Cookie header instead of replacing earlier ones. */
export function appendSetCookie(reply: { getHeader(name: string): unknown; header(name: string, value: unknown): unknown }, cookie: string): void {
  const prev = reply.getHeader("set-cookie");
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  reply.header("set-cookie", [...list, cookie]);
}

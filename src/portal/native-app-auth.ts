// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Native-app (desktop/iOS) OAuth hand-off. The app opens /auth/oauth/:provider/start with
 * appRedirect (its custom-scheme callback) and, in current builds, appChallenge: base64url
 * sha256 of a random verifier the app keeps. The mobile token in the deep link is bound to that
 * challenge, and /auth/oauth/mobile/complete needs the verifier, so a deep link carrying a token
 * from a sign-in the app did not start is refused.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** base64url sha256: 43 characters. */
export const APP_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 verifier alphabet and length. */
export const APP_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export function appChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/**
 * True when the verifier fits the token's binding: a bound token needs its verifier, and a
 * verifier is only accepted for a token bound to it. Neither (older apps) is accepted.
 */
export function appVerifierMatches(challenge: string | undefined, verifier: string | undefined): boolean {
  if (!challenge && !verifier) return true;
  if (!challenge || !verifier) return false;
  const a = Buffer.from(appChallengeFor(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The app's callback must be exactly the configured scheme, host and path (query allowed). */
export function nativeRedirectMatches(candidate: string, configured: string): boolean {
  let c: URL;
  let want: URL;
  try {
    c = new URL(candidate);
    want = new URL(configured);
  } catch {
    return false;
  }
  if (c.protocol === "http:" || c.protocol === "https:") return false;
  if (c.username || c.password || c.hash) return false;
  const path = (u: URL) => u.pathname.replace(/\/+$/, "");
  return c.protocol === want.protocol && c.host === want.host && path(c) === path(want);
}

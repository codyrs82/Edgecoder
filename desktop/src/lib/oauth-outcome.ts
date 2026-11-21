// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What the portal's OAuth deep link (edgecoder://oauth-callback?...) means for the sign-in screen.
 * The portal (src/portal/routes/auth.ts) answers with:
 *  - status=ok&mobile_token=...[&linked=1]: signed in (linked=1: the provider was just connected
 *    automatically because both sides verified the address; the account was emailed a notice);
 *  - status=link_pending&email_hint=c…@example.com: an account has this address, and its inbox got
 *    a link to confirm connecting the provider (nothing is signed in yet);
 *  - status=error&error=<code>: refused, with the reason.
 */

export type OAuthOutcome =
  | { kind: "signed_in"; token: string; linked: boolean }
  | { kind: "check_email"; message: string }
  | { kind: "error"; message: string };

export function providerLabel(provider: string | null): string {
  return provider === "microsoft" ? "Microsoft" : provider === "google" ? "Google" : provider === "github" ? "GitHub" : "this provider";
}

/** Messages for status=error (codes as in portal routes/auth.ts refuse()). */
export function oauthFailureMessage(code: string | null, provider: string | null): string {
  const p = providerLabel(provider);
  switch (code) {
    case "oauth_link_rate_limited":
      return `We already sent several emails to connect ${p} to this account. Check your inbox, wait a while before trying again, or sign in with your password instead.`;
    case "oauth_link_email_failed":
      return `We could not send the email to connect ${p} right now. Try again in a few minutes, or sign in with your password instead.`;
    case "oauth_identity_linked_elsewhere":
      return `This ${p} account is already connected to a different EdgeCoder account.`;
    case "email_not_verified":
      return `Verify your email address before connecting ${p}.`;
    case "oauth_connect_session_mismatch":
      return `Your session changed while connecting ${p}. Sign in again and retry.`;
    default:
      return code ? `${p} sign-in was not completed (${code}).` : "OAuth sign-in was not completed";
  }
}

export function oauthOutcomeFromUrl(url: URL): OAuthOutcome {
  const status = url.searchParams.get("status");
  const provider = url.searchParams.get("provider");
  const p = providerLabel(provider);
  const token = url.searchParams.get("mobile_token");
  if (status === "ok" && token) return { kind: "signed_in", token, linked: url.searchParams.get("linked") === "1" };
  if (status === "link_pending") {
    const hint = url.searchParams.get("email_hint") || "your email address";
    return {
      kind: "check_email",
      message: `We sent a link to ${hint} to connect ${p} to your account. Open it, then choose Continue with ${p} here again. Or sign in with your password instead.`
    };
  }
  return { kind: "error", message: oauthFailureMessage(url.searchParams.get("error"), provider) };
}

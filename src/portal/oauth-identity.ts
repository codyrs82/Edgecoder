// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Which account an OAuth login may use. An OAuth login reaches an existing account only when
 * (a) the provider identity was linked to it before, or (b) the provider positively verified
 * the email address and that account's address is verified too. Anything else that collides
 * with an existing email is refused, and the user connects the provider from Settings instead.
 */

import { claimIsTrue } from "./portal-utils.js";
import { messagePage } from "./assets.js";

export type OauthProvider = "google" | "microsoft" | "github";

export const OAUTH_PROVIDER_LABEL: Record<OauthProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
  github: "GitHub"
};

export type OauthProfile = {
  /** Stable key for portal_oauth_links.provider_subject. Microsoft: "<tid>:<oid>". */
  subject?: string;
  /** Microsoft only: the Entra tenant (tid), recorded with the link. */
  tenantId?: string;
  /** Microsoft only: the per-app `sub` that older links were keyed on. */
  legacySubject?: string;
  email?: string;
  /** True only when the provider itself vouches for the address. Never true for Microsoft. */
  emailVerified: boolean;
  githubLogin?: string;
  githubAvatarUrl?: string;
};

type Claims = Record<string, unknown> | null | undefined;
export type GithubEmail = { email: string; primary: boolean; verified: boolean };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Builds the profile from the id_token claims, the userinfo response and (GitHub) /user/emails. */
export function oauthProfileFrom(provider: OauthProvider, idClaims: Claims, userInfo: Claims, githubEmails?: GithubEmail[] | null): OauthProfile {
  if (provider === "github") {
    const id = userInfo?.id;
    // Only the primary address, and only when GitHub marks it verified. The public profile
    // email and secondary addresses are never used for matching.
    const primary = (githubEmails ?? []).find((e) => e && e.primary === true && e.verified === true && str(e.email));
    return {
      subject: typeof id === "number" || typeof id === "string" ? String(id) : undefined,
      email: primary ? primary.email : str(userInfo?.email),
      emailVerified: Boolean(primary),
      githubLogin: str(userInfo?.login),
      githubAvatarUrl: str(userInfo?.avatar_url)
    };
  }
  if (provider === "microsoft") {
    // /common accepts any tenant, and a tenant admin controls the email claim, so the address
    // is never trusted: the identity is the (tid, oid) pair.
    const tid = str(idClaims?.tid);
    const oid = str(idClaims?.oid);
    return {
      subject: tid && oid ? `${tid}:${oid}` : undefined,
      tenantId: tid,
      legacySubject: str(idClaims?.sub),
      email: str(idClaims?.email) ?? str(idClaims?.preferred_username) ?? str(userInfo?.email),
      emailVerified: false
    };
  }
  // Google: email_verified must be true (id_token, or userinfo for the same address).
  const idEmail = str(idClaims?.email);
  const infoEmail = str(userInfo?.email);
  const email = idEmail ?? infoEmail;
  const verified =
    (idEmail !== undefined && claimIsTrue(idClaims?.email_verified)) ||
    (infoEmail !== undefined && infoEmail === email && claimIsTrue(userInfo?.email_verified));
  return { subject: str(idClaims?.sub) ?? str(userInfo?.sub), email, emailVerified: verified };
}

export type ExistingAccount = { userId: string; email: string; emailVerified: boolean };

export type OauthLoginDecision =
  | { kind: "use_existing" }
  | { kind: "create" }
  /** An account has this email and the provider did not verify it (always the case for Microsoft). */
  | { kind: "account_exists" }
  /** The provider verified the email, but the account holding it never did: it is unclaimed. */
  | { kind: "account_unclaimed" };

/** For a provider identity that is not linked yet: may it sign in to the account holding its email? */
export function decideUnlinkedOauthLogin(profile: OauthProfile, existing: ExistingAccount | null): OauthLoginDecision {
  if (!existing) return { kind: "create" };
  if (!profile.emailVerified) return { kind: "account_exists" };
  if (!existing.emailVerified) return { kind: "account_unclaimed" };
  return { kind: "use_existing" };
}

export function oauthErrorMessage(kind: "account_exists" | "account_unclaimed" | "already_linked" | "connect_session", provider: OauthProvider): string {
  const p = OAUTH_PROVIDER_LABEL[provider];
  switch (kind) {
    case "account_exists":
      return `An account with this email already exists. Sign in with your password (or the way you usually sign in), then connect ${p} from Settings.`;
    case "account_unclaimed":
      return `An account with this email already exists, but its email address has not been verified. If it is yours, verify it or use "Forgot password" (the link goes to this address), sign in, then connect ${p} from Settings.`;
    case "already_linked":
      return `This ${p} account is already connected to a different EdgeCoder account.`;
    case "connect_session":
      return `Your session changed while connecting ${p}. Sign in again and retry from Settings.`;
  }
}

export function oauthErrorPage(message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  return messagePage("Sign-in not completed", `<p>${safe}</p><p><a href="/portal">Return to sign in</a></p>`);
}

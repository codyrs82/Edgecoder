// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Which account an OAuth login may use. An OAuth login reaches an existing account only when
 * (a) the provider identity was linked to it before, or (b) the provider positively verified
 * the email address and that account's address is verified too (automatic link, with a security
 * email). Anything else that collides with an existing email is never signed in: the account's
 * own inbox is asked to confirm the link (oauth-pending-link.ts), so whoever finishes it holds
 * both that inbox and this browser (or the provider identity itself).
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
  /**
   * True only when the provider itself vouches for the address: Google `email_verified`, GitHub's
   * verified primary address, Microsoft `xms_edov` (or a UPN on a verified domain of the tenant,
   * checked by the route through Graph; see microsoftDomainCandidate).
   */
  emailVerified: boolean;
  /**
   * Microsoft work/school account whose address is not proven by `xms_edov`: its UPN
   * (preferred_username / upn). The route may prove it by finding the UPN's domain among the
   * tenant's verified domains (microsoftUpnOnVerifiedDomain); until then emailVerified is false.
   */
  microsoftDomainCandidate?: string;
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
    // /common accepts any tenant, and a tenant admin can set the `email` claim to any address, so
    // the identity is the (tid, oid) pair and the address is trusted only with proof:
    //  - `xms_edov` (email domain owner verified, an optional ID-token claim configured on the app
    //    registration) is true, for a work/school tenant;
    //  - otherwise the route may check the UPN against the tenant's verified domains.
    // Personal Microsoft accounts (the consumer tenant) are never treated as verified.
    const tid = str(idClaims?.tid);
    const oid = str(idClaims?.oid);
    const consumer = tid?.toLowerCase() === MICROSOFT_CONSUMER_TENANT_ID;
    const idEmail = str(idClaims?.email);
    const edov = Boolean(tid) && !consumer && idEmail !== undefined && claimIsTrue(idClaims?.xms_edov);
    const upn = str(idClaims?.preferred_username) ?? str(idClaims?.upn);
    return {
      subject: tid && oid ? `${tid}:${oid}` : undefined,
      tenantId: tid,
      legacySubject: str(idClaims?.sub),
      email: idEmail ?? upn ?? str(userInfo?.email),
      emailVerified: edov,
      ...(!edov && tid && !consumer && upn && upn.includes("@") ? { microsoftDomainCandidate: upn } : {})
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

/** The Entra tenant of personal Microsoft accounts (outlook.com, hotmail.com, ...). */
export const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * Graph `GET /organization` (the signed-in user's tenant): is the UPN's domain one of the tenant's
 * verified domains? Exact, case-insensitive domain match, and only for the tenant the token names.
 * Anything unexpected (no answer, another tenant, no list) is "not proven".
 */
export function microsoftUpnOnVerifiedDomain(upn: string, tenantId: string, organization: unknown): boolean {
  const at = upn.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = upn.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  const orgs = (organization as { value?: unknown } | null)?.value;
  if (!Array.isArray(orgs)) return false;
  const org = orgs.find((o) => o && typeof o === "object" && String((o as { id?: unknown }).id ?? "").toLowerCase() === tenantId.toLowerCase()) as
    | { verifiedDomains?: unknown }
    | undefined;
  if (!org || !Array.isArray(org.verifiedDomains)) return false;
  return org.verifiedDomains.some((d) => d && typeof d === "object" && typeof (d as { name?: unknown }).name === "string" && (d as { name: string }).name.trim().toLowerCase() === domain);
}

export type ExistingAccount = { userId: string; email: string; emailVerified: boolean };

export type OauthLoginDecision =
  | { kind: "use_existing" }
  | { kind: "create" }
  /** A verified account has this email and the provider did not prove it: the account's inbox confirms the link. */
  | { kind: "confirm_by_email" }
  /**
   * The account holding this email never verified it (it may have been registered by someone
   * else): nothing is linked. The inbox gets a notice explaining how to claim it (Forgot password).
   * The person on screen sees the same "check your email" state as confirm_by_email.
   */
  | { kind: "account_unclaimed" };

/** For a provider identity that is not linked yet: may it sign in to the account holding its email? */
export function decideUnlinkedOauthLogin(profile: OauthProfile, existing: ExistingAccount | null): OauthLoginDecision {
  if (!existing) return { kind: "create" };
  if (!existing.emailVerified) return { kind: "account_unclaimed" };
  const same = typeof profile.email === "string" && profile.email.trim().toLowerCase() === existing.email.trim().toLowerCase();
  if (profile.emailVerified && same) return { kind: "use_existing" };
  return { kind: "confirm_by_email" };
}

export function oauthErrorMessage(kind: "already_linked" | "connect_session" | "connect_unverified" | "link_rate_limited" | "link_wrong_identity" | "link_email_failed", provider: OauthProvider): string {
  const p = OAUTH_PROVIDER_LABEL[provider];
  switch (kind) {
    case "link_rate_limited":
      return `We already sent several emails to connect ${p} to this account. Check your inbox (and spam folder), wait a while before trying again, or sign in with your password instead.`;
    case "link_wrong_identity":
      return `This is not the ${p} account waiting to be connected. Open the emailed link again and continue with the same ${p} account you used before.`;
    case "link_email_failed":
      return `We could not send the email to connect ${p} right now. Try again in a few minutes, or sign in with your password instead.`;
    case "already_linked":
      return `This ${p} account is already connected to a different EdgeCoder account.`;
    case "connect_unverified":
      return `Verify your email address before connecting ${p}: open the link we sent you, or connect a ${p} account that uses this same address.`;
    case "connect_session":
      return `Your session changed while connecting ${p}. Sign in again and retry from Settings.`;
  }
}

export function oauthErrorPage(message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  return messagePage("Sign-in not completed", `<p>${safe}</p><p><a href="/portal">Return to sign in</a></p>`);
}

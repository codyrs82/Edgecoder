// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Versions of the legal documents (docs/legal/*.md, served at /terms, /privacy, /acceptable-use,
 * /host-agreement) and the short notices the UI shows (docs/legal/ai-notices.md). Bump the version
 * when a document changes in substance: accounts record the version they accepted, so a new one
 * can be asked for. A version whose text is the same as the current one (only relabelled) goes in
 * the *_EQUIVALENT_VERSIONS lists, so acceptances of it still count.
 *
 * Kept byte-identical in desktop/src/lib/legal-notices.ts; tests/common/legal-notices.test.ts checks.
 */

/** Terms of Service, Privacy Policy and Acceptable Use Policy, accepted together at sign-up. */
export const TERMS_VERSION = "2026-11-16";
/** Host Agreement, accepted on the Install agent page (and by installing the agent). */
export const HOST_AGREEMENT_VERSION = "2026-11-16";

/**
 * Earlier versions with the same text as the current ones. "2026-11-15-draft" is the same documents
 * under a draft label, so an account that accepted it has accepted the current version.
 */
export const TERMS_EQUIVALENT_VERSIONS: readonly string[] = ["2026-11-15-draft"];
export const HOST_AGREEMENT_EQUIVALENT_VERSIONS: readonly string[] = ["2026-11-15-draft"];

/** Whether an accepted Terms version (stored on the account) covers the current Terms. */
export function termsVersionIsCurrent(version: string | null | undefined): boolean {
  return !!version && (version === TERMS_VERSION || TERMS_EQUIVALENT_VERSIONS.includes(version));
}

/** Whether an accepted Host Agreement version covers the current Host Agreement. */
export function hostAgreementVersionIsCurrent(version: string | null | undefined): boolean {
  return !!version && (version === HOST_AGREEMENT_VERSION || HOST_AGREEMENT_EQUIVALENT_VERSIONS.includes(version));
}

export const LEGAL_LINKS = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/acceptable-use", label: "Acceptable Use Policy" },
  { href: "/host-agreement", label: "Host Agreement" }
] as const;

export const NOTICES = {
  signupAgreement: "I agree to the Terms, Privacy Policy and Acceptable Use Policy.",
  aiOutput: "AI can be wrong. Check answers and review code before you run it. Prompts may be processed on machines run by other people: don't send secrets.",
  networkJob: "This runs on a machine operated by another EdgeCoder user, not by EdgeCoder. They can see what you send. Don't include passwords, keys or other secrets.",
  testMode: "Test mode: balances and payouts use Bitcoin test funds and have no real value. They may be reset.",
  payments: "Bitcoin and Lightning payments can't be reversed. Check the invoice or address before you pay or save it; network fees may apply.",
  hosting: "Hosting runs other people's AI and code jobs on this machine. The sandbox reduces risk but doesn't guarantee isolation. Make sure your ISP and employer allow it, and you're responsible for taxes on what you earn."
} as const;

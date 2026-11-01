// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// #16: shared by server.ts and the page modules (same env + defaults as before).
export const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL ?? "https://github.com/codyrs82/Edgecoder";
export const DOCS_SITE_URL = process.env.DOCS_SITE_URL ?? "http://127.0.0.1:5173";

// #22: self-hosters set these; the defaults are the EdgeCoder-run instance.
export function supportEmail(raw: string | undefined = process.env.SUPPORT_EMAIL): string {
  const value = raw?.trim() ?? "";
  // Plain address only: it is interpolated into HTML and mailto: links.
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) ? value : "support@edgecoder.io";
}
export const SUPPORT_EMAIL = supportEmail();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * Label for "Back to …" links: the PORTAL_PUBLIC_URL host, e.g. "edgecoder.io", HTML-escaped
 * (WHATWG URL lets characters like ' and " through in hostnames).
 */
export function siteLabel(publicUrl: string | undefined = process.env.PORTAL_PUBLIC_URL): string {
  try {
    return publicUrl ? escapeHtml(new URL(publicUrl).host) : "home";
  } catch {
    return "home";
  }
}

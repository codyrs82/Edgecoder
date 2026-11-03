// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Output escaping shared by every portal page.
 *
 * Server side: `escapeHtml` for values interpolated into HTML text or quoted attributes.
 * Client side: `CLIENT_ESCAPE_JS` defines the same `escapeHtml` in the browser; page scripts that
 * build markup strings for innerHTML pass every user- or agent-supplied value through it.
 */

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Escape a value for HTML text or a quoted attribute. null/undefined become "". */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c] as string);
}

/**
 * Browser twin of `escapeHtml`. It is a function declaration, so a page may include it more than
 * once; the app shell and every page script that builds markup for innerHTML include it.
 */
export const CLIENT_ESCAPE_JS = `
    function escapeHtml(s) {
      if (s === null || s === undefined) return "";
      return String(s).replace(/[&<>"'\`]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\`": "&#96;" }[c];
      });
    }
`;

/**
 * Node and agent ids accepted at enrolment: letters, digits, dot, underscore and hyphen, 3 to 128
 * characters. Hostnames, `ios-<uuid>` ids and the installer's `<host>-gpu0` ids all fit.
 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{3,128}$/;

/** Enrolment tokens minted by /nodes/enroll: two UUIDs without hyphens, i.e. 64 hex characters. */
export const ENROLLMENT_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

/** The token to show in install commands: a well-formed enrolment token, else the placeholder. */
export function displayEnrollmentToken(raw: unknown): string {
  const token = typeof raw === "string" ? raw.trim() : "";
  return ENROLLMENT_TOKEN_PATTERN.test(token) ? token : "YOUR_TOKEN";
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Per-request CSP nonces for the portal's inline <script> and <style> blocks.
 *
 * Page templates write `<script nonce="${CSP_NONCE}">` and `<style nonce="${CSP_NONCE}">`.
 * CSP_NONCE is a marker that is random per process and never leaves the server:
 * registerPortalSecurity's onSend hook replaces it in every HTML response with that request's
 * nonce, which is also the one in the Content-Security-Policy header. Markup that reaches a page
 * from user or agent data cannot carry a valid nonce, so an injected <script> does not run and an
 * injected <style> or style attribute does not apply under the enforced policy.
 *
 * The static mirror has no per-request header, so static-site.ts drops the attribute and lists the
 * hash of each <style> block instead.
 */
import { randomBytes } from "node:crypto";

export const CSP_NONCE = `csp-nonce-marker-${randomBytes(16).toString("hex")}`;

/** A fresh nonce (128 bits, base64). */
export function newCspNonce(): string {
  return randomBytes(16).toString("base64");
}

/** Replace the marker in an HTML body with the request's nonce. */
export function applyCspNonce(html: string, nonce: string): string {
  return html.split(CSP_NONCE).join(nonce);
}

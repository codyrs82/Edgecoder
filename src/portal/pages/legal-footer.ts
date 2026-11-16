// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { LEGAL_LINKS } from "../../common/legal-notices.js";
import { escapeHtml } from "./escape.js";

/**
 * The legal documents as footer links (Terms of Service · Privacy Policy · Acceptable Use Policy ·
 * Host Agreement). The apps don't show a legal section; the documents are linked from the bottom
 * of every website and portal page instead (tests/portal/legal-footer.test.ts).
 */
export function legalLinksHtml(): string {
  return LEGAL_LINKS.map((l) => `<a href="${l.href}">${escapeHtml(l.label)}</a>`).join("");
}

/** Styles for legalFooterHtml(), for pages that don't already have a footer of their own. */
export const LEGAL_FOOTER_CSS = `
        .legal-footer { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 14px; padding: 18px 16px 24px; font-size: 12px; color: var(--muted); }
        .legal-footer a { color: var(--muted); } .legal-footer a:hover { color: var(--text); }`;

/** A small footer: copyright and the four legal documents. */
export function legalFooterHtml(): string {
  return `<footer class="legal-footer" aria-label="Legal"><span>&copy; 2026 EdgeCoder</span>${legalLinksHtml()}</footer>`;
}

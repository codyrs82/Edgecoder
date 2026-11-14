# ADR 0002: The Portal Stays Server-Rendered

Status: Accepted

## Context

Issue #27 asked for the portal pages to be rebuilt as a single-page app on the shared design system. The aim was one consistent UI: the same tokens, layout and theme on every page, instead of pages that had each grown their own styles.

A rewrite is not the only way to get that, and it would cost things the portal has today:

- Each page is an HTML string built by a module in `src/portal/pages/`. The browser gets a complete page in one response.
- The Content-Security-Policy is strict: scripts and styles need the per-request nonce, and there is no `'unsafe-inline'` or `'unsafe-eval'`.
- There is no front-end build. The server is compiled with `tsc`, the shared tokens are copied in as one CSS file, and that is the whole pipeline.
- The public pages (home, privacy, terms) ship no inline script, so they can be exported as static files and served from a mirror when the portal is down.

PR #264 (issue #89) had already moved the pages onto `@edgecoder/tokens` with a light / dark / system toggle, which was most of what #27 wanted from the design system.

## Decision

1. The portal stays server-rendered. Issue #27 is re-scoped: no SPA, no client-side router, no bundler, no UI framework.
2. Every page starts with `htmlOpenTag()` and `themeHeadTags()` and takes its base styles from `design-system.ts`. Signed-in pages use `portalAuthedPageHtml` or `settingsPage`; single-card pages use `portalCardPageHtml`. The sign-in page and the public pages keep their own page shells on the same base styles.
3. Colors, shadows and scrims come from token variables. Raw color values live only in the tokens package and `design-system.ts`.
4. Inline `<script>` and `<style>` blocks carry the request nonce (`CSP_NONCE`). Pages have no `style="..."` attributes, in markup or in the HTML their scripts build. Scripts that need a computed value set it through `element.style`.
5. Page behavior stays in small inline scripts that call the portal's JSON routes. A page that needs more than that gets its own ADR.

## What was done instead

- Every page module was audited against rules 2 to 4. Reset-password and verify-email moved onto a shared card layout. The remaining raw colors moved to tokens. Text on tinted backgrounds was brought to 4.5:1 in both themes, and the market charts now follow the theme toggle.
- `/portal-legacy`, the first single-page portal, was still routed but nothing linked to it. The page is gone; the URL redirects to `/portal`.
- `style-src` lost `'unsafe-inline'`. The one stylesheet the chart library injects is allowed by its hash, computed from the installed library. The static mirror cannot use nonces, so its `_headers` file lists the hash of each exported `<style>` block.
- The review diff's syntax highlighter, which printed its own markup as text, was rewritten as a single pass.
- Tests walk every GET route the page modules register (`tests/portal/page-audit.test.ts`, `tests/portal/csp-styles.test.ts`), so a page added later is held to the same rules without being added to a list.

## Consequences

- The security posture is kept and tightened: an injected `<style>` or style attribute is now blocked, as an injected script already was.
- No new dependencies and no new build step. A page change is a TypeScript change.
- Navigation between pages is a full page load. Shared state lives in the session and `localStorage` (the theme), not in a client store.
- Client code is plain JavaScript inside template strings: no type checking, and backslashes are doubled. Logic worth testing has to be pulled out of the rendered page, as the highlighter test does.
- Sign-in with email and password, password reset and the signed-in pages still need JavaScript. Only the public pages and the SSO links work without it.
- A new page must follow rules 2 to 4 or the route-walking tests fail. A new third-party script that injects styles needs its hash added the way `src/portal/chart-lib.ts` does it.
- After any change to a public page, the static mirror must be exported again, and its host must not minify or rewrite the HTML, or the style hashes stop matching.
- If the portal later needs rich client state (offline use, live collaborative views), this decision should be revisited rather than worked around page by page.

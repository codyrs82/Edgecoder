// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Portal design system: one set of tokens, base styles and icons shared by the app shell
 * (layout.ts), the sign-in page (home.ts) and the public pages (public.ts).
 *
 * Direction: an infrastructure / trading console. Graphite surfaces, hairline borders, one
 * accent (Bitcoin orange) reserved for primary actions and the active nav item, semantic
 * green/red only for money and status, tabular monospace numerals, no gradients, no blur,
 * no hover-lift, no emoji. Page styles are inline (CSP: style-src inline); scripts are nonce'd or
 * external.
 *
 * #89: colors come from the shared @edgecoder/tokens stylesheet (/assets/tokens.css, see
 * ../assets.ts), the same tokens as the desktop app, with light and dark values selected by
 * <html data-theme>. Its portal aliases (--bg, --text, --brand, --ok, --danger, ...) are the names
 * used here. TOKENS_CSS below only adds the few portal-only tokens, derived from the shared ones.
 */

/**
 * Portal-only tokens on top of /assets/tokens.css (which must be linked first): tints derived from
 * the shared colors, so they follow light/dark, plus the portal's layout scale.
 */
export const TOKENS_CSS = `
:root {
  --brand-soft: color-mix(in srgb, var(--brand) 12%, transparent);
  --brand-border: color-mix(in srgb, var(--brand) 35%, transparent);
  --info: var(--accent-secondary);
  --hover-wash: color-mix(in srgb, var(--text) 4%, transparent);
  /* the shared stack plus fallbacks that exist on the web (SF Mono is not exposed to pages) */
  --font-mono: "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px;
  --sidebar-w: 232px;
  --topbar-h: 56px;
  --content-max: 1320px;
  --transition-fast: 0.12s ease;
  --transition-med: 0.2s ease;
  --shadow-1: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-2: 0 8px 24px rgba(0,0,0,0.35);
}`;

/** Base styles shared by every page: reset, type, buttons, inputs, tables, cards, badges, KPIs, utilities. */
export const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; font-family: var(--font-sans); font-size: 14px; line-height: 1.5;
  color: var(--text); background: var(--bg); min-height: 100vh;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  font-feature-settings: "cv11", "ss01", "tnum";
}
a { color: var(--text); text-decoration: none; }
a:hover { color: var(--brand-2); }
h1, h2, h3, h4 { margin: 0; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; }
h1 { font-size: 22px; } h2 { font-size: 16px; } h3 { font-size: 14px; } h4 { font-size: 13px; }
p { margin: 0 0 var(--sp-3); }
code, pre, .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
::selection { background: var(--brand-soft); }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* Text */
.muted { color: var(--muted); font-size: 12px; }
.secondary { color: var(--text-secondary); }
.mono { font-size: 12.5px; }
.eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.pos { color: var(--ok); } .neg { color: var(--danger); }

/* Buttons */
button, .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 7px 12px; min-height: 32px;
  border-radius: var(--radius-sm); border: 1px solid var(--border-strong);
  background: var(--bg-elevated); color: var(--text);
  font: inherit; font-size: 13px; font-weight: 500; line-height: 1;
  cursor: pointer; white-space: nowrap;
  transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}
button:hover, .btn:hover { background: var(--bg-surface); border-color: var(--text-secondary); color: var(--text); }
button:disabled, .btn[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
button.primary, .btn.primary, .dl-btn { background: var(--brand); border-color: var(--brand); color: var(--on-accent); font-weight: 600; }
button.primary:hover, .btn.primary:hover, .dl-btn:hover { background: var(--brand-2); border-color: var(--brand-2); color: var(--on-accent); }
button.ghost, .btn.ghost { background: transparent; border-color: transparent; color: var(--text-secondary); }
button.ghost:hover, .btn.ghost:hover { background: var(--bg-elevated); color: var(--text); }
button.danger { border-color: color-mix(in srgb, var(--danger) 50%, transparent); color: var(--danger); background: transparent; }
button.danger:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
button.sm, .btn.sm { padding: 4px 9px; min-height: 26px; font-size: 12px; }
button svg, .btn svg { width: 14px; height: 14px; flex: none; }

/* Inputs */
input, select, textarea {
  width: 100%; padding: 8px 10px; min-height: 34px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--bg-input); color: var(--text);
  font: inherit; font-size: 13px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
input:hover, select:hover, textarea:hover { border-color: var(--text-secondary); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
input::placeholder, textarea::placeholder { color: var(--muted); }
select { appearance: none; -webkit-appearance: none; padding-right: 28px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237c8794' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>");
  background-repeat: no-repeat; background-position: right 10px center; }
label { display: block; margin: var(--sp-3) 0 var(--sp-1); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.field { margin-bottom: var(--sp-3); }

/* Cards & layout */
.card {
  background: var(--card); border: 1px solid var(--card-border); border-radius: var(--radius-md);
  padding: var(--sp-4); margin-bottom: var(--sp-3);
}
.card > h2:first-child, .card > h3:first-child { margin-bottom: var(--sp-3); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
.card-head h2, .card-head h3 { margin: 0; }
.row { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
.stack { display: flex; flex-direction: column; gap: var(--sp-3); }
.hidden { display: none !important; }
.divider { height: 1px; background: var(--card-border); margin: var(--sp-3) 0; }

/* KPIs */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-2); margin-top: var(--sp-2); }
.kpi { border: 1px solid var(--card-border); border-radius: var(--radius-sm); padding: var(--sp-3); background: var(--bg-surface); }
.kpi .label { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.kpi .value { font-size: 20px; font-weight: 600; margin-top: 4px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.kpi .delta { font-size: 12px; margin-top: 2px; color: var(--muted); }

/* Tables */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid var(--card-border); text-align: left; padding: 8px 10px; vertical-align: middle; }
th { color: var(--muted); font-weight: 600; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
tbody tr:hover { background: var(--hover-wash); }
td.num, th.num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.table-controls { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; margin: 0 0 var(--sp-3); }
.table-controls input, .table-controls select { width: auto; min-width: 160px; }

/* Badges */
.status-badge, .pill {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; min-height: 20px;
  border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  border: 1px solid var(--border-strong); background: var(--bg-elevated); color: var(--text-secondary);
}
.status-badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.status-badge.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: color-mix(in srgb, var(--yellow) 10%, transparent); }
.status-badge.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.status-badge.info { color: var(--info); border-color: color-mix(in srgb, var(--info) 40%, transparent); background: color-mix(in srgb, var(--info) 10%, transparent); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
.dot.green { background: var(--ok); } .dot.yellow { background: var(--yellow); } .dot.red { background: var(--danger); } .dot.gray { background: var(--muted); }

/* Brand mark (brandMark()) and the theme toggle (assets.ts themeToggleButton()) */
.mark { color: var(--on-accent); }
.theme-toggle [data-theme-label] { font-size: 12px; }

/* Misc */
.token-box { border: 1px dashed var(--brand-border); border-radius: var(--radius-sm); padding: 10px; background: var(--bg-input); word-break: break-all; font-family: var(--font-mono); font-size: 12px; }
.loading-spinner { width: 18px; height: 18px; border: 2px solid var(--card-border); border-top-color: var(--brand); border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block; vertical-align: middle; }
.loading-spinner.sm { width: 12px; height: 12px; } .loading-spinner.lg { width: 28px; height: 28px; border-width: 3px; }
@keyframes spin { to { transform: rotate(360deg); } }
.loading-state { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; padding: 12px 0; }
.callout { border: 1px solid var(--card-border); border-left: 3px solid var(--brand); border-radius: var(--radius-sm); padding: var(--sp-3) var(--sp-4); background: var(--bg-surface); margin-bottom: var(--sp-3); }
.callout.warn { border-left-color: var(--yellow); } .callout.danger { border-left-color: var(--danger); } .callout.ok { border-left-color: var(--ok); }
.callout h3 { margin-bottom: 4px; }
#toast {
  position: fixed; top: 16px; right: 16px; width: min(420px, calc(100vw - 32px)); z-index: 100; margin: 0;
  padding: 12px 14px; font-size: 13px; border-left-width: 3px; box-shadow: var(--shadow-2);
}
.empty { color: var(--muted); font-size: 13px; padding: var(--sp-6); text-align: center; border: 1px dashed var(--card-border); border-radius: var(--radius-sm); }
@media (max-width: 920px) { .grid2, .grid3 { grid-template-columns: 1fr; } }
`;

/** Inline SVG icons (24x24 viewBox, stroke-based, currentColor). */
const ICON_PATHS: Record<string, string> = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-4.6A8 8 0 1 1 21 12z"/>',
  reviews: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  wallet: '<path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 3H6a2 2 0 0 0-2 2v2"/><circle cx="16.5" cy="13.5" r="1.5"/>',
  market: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  docs: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bitcoin: '<path d="M9 4v16"/><path d="M12 4v2"/><path d="M12 18v2"/><path d="M7 8h7a2.5 2.5 0 0 1 0 5H7"/><path d="M7 13h8a2.5 2.5 0 0 1 0 5H7"/><path d="M7 8V6"/><path d="M7 18v2"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01M6 17.5h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1L21 2"/><path d="M15 8l3 3"/><path d="M18 5l3 3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  zap: '<path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7l10-5z"/><path d="M2 12l10 5 10-5"/><path d="M2 17l10 5 10-5"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 2v6h6"/>',
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  apple: '<path d="M16.5 12.6c0-2.4 2-3.5 2-3.6-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.3c.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.7z"/><path d="M14.4 5.3c.6-.8 1.1-1.9.9-3-.9.1-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3z"/>',
  windows: '<path d="M3 5.5l7.5-1v7H3z"/><path d="M12 4.3L21 3v8.5h-9z"/><path d="M3 12.5h7.5v7L3 18.5z"/><path d="M12 12.5h9V21l-9-1.3z"/>',
  terminal: '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  code: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
};

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: string, size = 16, className = ""): string {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.info;
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** The brand mark: an orange square with a monogram, no gradient. */
export function brandMark(size = 28): string {
  const r = Math.round(size * 0.22);
  return `<span class="mark" style="width:${size}px;height:${size}px;border-radius:${r}px;" aria-hidden="true"><svg width="${Math.round(size * 0.6)}" height="${Math.round(size * 0.6)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h14"/><path d="M4 12h10"/><path d="M4 18h14"/><path d="M20 10l-3 2 3 2"/></svg></span>`;
}

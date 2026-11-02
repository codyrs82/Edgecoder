// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BASE_CSS, TOKENS_CSS, THEME_SCRIPT, brandMark, icon } from "./design-system.js";
import { DOCS_SITE_URL } from "./urls.js";

/**
 * Authenticated app shell: left sidebar (brand, navigation, balance, sign-out), top bar (page
 * title, subtitle, actions), content area. Pages supply `content` (HTML) and `script` (JS) and
 * keep using the shell's helpers: api(), requireAuth(), showToast(), statusBadge(), boolBadge(),
 * applyTheme(). Element ids used by pages are unchanged: toast, topTickerCredits, reviewsBadge,
 * logoutBtn, hamburgerBtn, topbarNav.
 */
export function portalAuthedPageHtml(input: {
  title: string;
  activeTab: "chat" | "dashboard" | "wallet" | "market" | "settings" | "download" | "reviews";
  heading: string;
  subtitle: string;
  content: string;
  script: string;
  /** Optional HTML rendered on the right of the top bar (buttons, filters). */
  actions?: string;
}): string {
  const groups: Array<{ label: string; items: Array<{ key: string; href: string; label: string; icon: string; badge?: string; external?: boolean }> }> = [
    {
      label: "Workspace",
      items: [
        { key: "dashboard", href: "/portal/dashboard", label: "Dashboard", icon: "dashboard" },
        { key: "chat", href: "/portal/chat", label: "Chat", icon: "chat" },
        { key: "reviews", href: "/portal/reviews", label: "Reviews", icon: "reviews", badge: "reviewsBadge" }
      ]
    },
    {
      label: "Economy",
      items: [
        { key: "market", href: "/portal/market", label: "Market", icon: "market" },
        { key: "wallet", href: "/portal/wallet", label: "Wallet", icon: "wallet" }
      ]
    },
    {
      label: "Account",
      items: [
        { key: "download", href: "/portal/download", label: "Install agent", icon: "download" },
        { key: "settings", href: "/portal/settings", label: "Settings", icon: "settings" },
        { key: "docs", href: DOCS_SITE_URL, label: "Documentation", icon: "docs", external: true }
      ]
    }
  ];
  const navHtml = groups
    .map(
      (g) => `
      <div class="nav-group">
        <div class="nav-group-label">${g.label}</div>
        ${g.items
          .map((item) => {
            const active = item.key === input.activeTab ? " active" : "";
            const badge = item.badge ? `<span class="nav-badge" id="${item.badge}" style="display:none;">0</span>` : "";
            const ext = item.external ? ` target="_blank" rel="noreferrer"` : "";
            return `<a class="nav-link${active}" href="${item.href}"${ext} title="${item.label}"${active ? ' aria-current="page"' : ""}>${icon(item.icon, 16)}<span class="nav-label">${item.label}</span>${badge}${item.external ? icon("external", 12, "nav-ext") : ""}</a>`;
          })
          .join("")}
      </div>`
    )
    .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${input.title}</title>
      <style>
        ${TOKENS_CSS}
        ${BASE_CSS}
        /* ── Shell ── */
        .app { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 100vh; }
        .sidebar {
          position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column;
          background: var(--bg-soft); border-right: 1px solid var(--card-border);
        }
        .sidebar-brand { display: flex; align-items: center; gap: 10px; padding: 14px 16px; height: var(--topbar-h); border-bottom: 1px solid var(--card-border); }
        .sidebar-brand a { display: flex; align-items: center; gap: 10px; color: var(--text); }
        .mark { display: inline-flex; align-items: center; justify-content: center; background: var(--brand); flex: none; }
        .brand-name { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; }
        .brand-sub { font-size: 10px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin-top: 1px; }
        .sidebar-nav { padding: 10px 10px; flex: 1; overflow-y: auto; }
        .nav-group { margin-bottom: 14px; }
        .nav-group-label { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); padding: 6px 10px; }
        .nav-link {
          position: relative; display: flex; align-items: center; gap: 10px;
          padding: 8px 10px; margin: 1px 0; border-radius: var(--radius-sm);
          font-size: 13px; font-weight: 500; color: var(--text-secondary);
          transition: background var(--transition-fast), color var(--transition-fast);
        }
        .nav-link:hover { background: var(--bg-elevated); color: var(--text); }
        .nav-link.active { background: var(--brand-soft); color: var(--brand-2); }
        .nav-link.active::before { content: ""; position: absolute; left: -10px; top: 7px; bottom: 7px; width: 3px; border-radius: 0 2px 2px 0; background: var(--brand); }
        .nav-link .icon { flex: none; opacity: 0.9; }
        .nav-link .nav-ext { margin-left: auto; opacity: 0.5; }
        .nav-badge {
          margin-left: auto; background: var(--brand); color: #111; font-size: 10px; font-weight: 700;
          min-width: 18px; height: 18px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; padding: 0 5px;
        }
        .sidebar-foot { border-top: 1px solid var(--card-border); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
        .balance-chip { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--card-border); border-radius: var(--radius-sm); background: var(--bg-surface); }
        .balance-chip .k { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
        .balance-chip .v { font-family: var(--font-mono); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
        .signout { justify-content: flex-start; width: 100%; }
        /* ── Top bar + content ── */
        .main { min-width: 0; display: flex; flex-direction: column; }
        .topbar {
          position: sticky; top: 0; z-index: 40; height: var(--topbar-h);
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 0 24px; background: var(--bg); border-bottom: 1px solid var(--card-border);
        }
        .topbar-title h1 { font-size: 16px; font-weight: 600; }
        .topbar-title .sub { font-size: 12px; color: var(--muted); margin-top: 1px; }
        .topbar-actions { display: flex; align-items: center; gap: 8px; }
        .hamburger-btn { display: none; }
        .scrim { display: none; }
        .shell { width: 100%; max-width: var(--content-max); margin: 0 auto; padding: 20px 24px 40px; }
        .content-stack { min-width: 0; }
        /* ── Mobile ── */
        @media (max-width: 900px) {
          .app { grid-template-columns: 1fr; }
          .sidebar { position: fixed; inset: 0 auto 0 0; width: min(300px, 86vw); transform: translateX(-100%); transition: transform var(--transition-med); z-index: 60; box-shadow: var(--shadow-2); }
          .sidebar.mobile-open { transform: translateX(0); }
          .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 55; display: none; }
          .scrim.show { display: block; }
          .hamburger-btn { display: inline-flex; }
          .topbar { padding: 0 14px; }
          .shell { padding: 14px 14px 32px; }
        }
      </style>
    </head>
    <body>
      <div class="app">
        <aside class="sidebar" id="topbarNav">
          <div class="sidebar-brand">
            <a href="/portal/dashboard">${brandMark(28)}<span><div class="brand-name">EdgeCoder</div><div class="brand-sub">Compute network</div></span></a>
          </div>
          <nav class="sidebar-nav" aria-label="Primary">${navHtml}</nav>
          <div class="sidebar-foot">
            <div class="balance-chip" title="Credit balance"><span class="k">Credits</span><span class="v" id="topTickerCredits"><span class="loading-spinner sm"></span></span></div>
            <a class="btn ghost signout" id="logoutBtn" href="#">${icon("logout", 16)}<span>Sign out</span></a>
          </div>
        </aside>
        <div class="scrim" id="navScrim"></div>
        <div class="main">
          <header class="topbar">
            <div style="display:flex;align-items:center;gap:10px;min-width:0;">
              <button class="hamburger-btn ghost" id="hamburgerBtn" aria-label="Open navigation">${icon("menu", 18)}</button>
              <div class="topbar-title"><h1>${input.heading}</h1><div class="sub">${input.subtitle}</div></div>
            </div>
            <div class="topbar-actions">${input.actions ?? ""}</div>
          </header>
          <div class="shell">
            <div class="content-stack">
              ${input.content}
            </div>
          </div>
        </div>
      </div>
      <div id="toast" class="card hidden" role="status" aria-live="polite"></div>
      <script>
        const toast = document.getElementById("toast");
        ${THEME_SCRIPT}
        function showToast(message, isError = false) {
          toast.textContent = message;
          toast.classList.remove("hidden");
          toast.style.borderLeftColor = isError ? "var(--danger)" : "var(--ok)";
          clearTimeout(toast._t);
          toast._t = setTimeout(() => toast.classList.add("hidden"), 5000);
        }
        async function api(path, options = {}) {
          const res = await fetch(path, {
            credentials: "include",
            headers: { "content-type": "application/json", ...(options.headers || {}) },
            ...options
          });
          let payload = null;
          try { payload = await res.json(); } catch {}
          if (!res.ok) throw new Error(payload && payload.error ? payload.error : String(res.status));
          return payload;
        }
        async function requireAuth() {
          try {
            return await api("/me", { method: "GET", headers: {} });
          } catch {
            window.location.href = "/portal";
            throw new Error("not_authenticated");
          }
        }
        function statusBadge(text, tone = "neutral") {
          const toneClass = tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "danger" ? "danger" : tone === "info" ? "info" : "";
          return "<span class='status-badge " + toneClass + "'>" + String(text) + "</span>";
        }
        function boolBadge(value, trueLabel = "YES", falseLabel = "NO") {
          return value ? statusBadge(trueLabel, "ok") : statusBadge(falseLabel, "warn");
        }
        /* ── Mobile navigation ── */
        (function() {
          var btn = document.getElementById("hamburgerBtn");
          var nav = document.getElementById("topbarNav");
          var scrim = document.getElementById("navScrim");
          function close() { nav.classList.remove("mobile-open"); scrim.classList.remove("show"); }
          if (btn && nav) {
            btn.addEventListener("click", function() { nav.classList.toggle("mobile-open"); scrim.classList.toggle("show", nav.classList.contains("mobile-open")); });
            scrim.addEventListener("click", close);
            document.addEventListener("keydown", function(e) { if (e.key === "Escape") close(); });
          }
        })();
        /* ── Balance chip and reviews badge ── */
        async function loadTopTicker() {
          try {
            await requireAuth();
            var summary = await api("/dashboard/summary", { method: "GET", headers: {} });
            var credits = (summary.walletSnapshot || {}).credits;
            var creditVal = credits && typeof credits.balance !== "undefined" ? Number(credits.balance).toLocaleString(undefined, { maximumFractionDigits: 3 }) : "n/a";
            document.getElementById("topTickerCredits").textContent = creditVal;
          } catch {
            document.getElementById("topTickerCredits").textContent = "-";
          }
        }
        async function loadReviewsBadge() {
          try {
            var res = await api("/portal/api/reviews");
            var reviews = res.reviews || [];
            var badge = document.getElementById("reviewsBadge");
            if (badge && reviews.length > 0) {
              badge.textContent = String(reviews.length);
              badge.style.display = "inline-flex";
            }
          } catch { /* noop */ }
        }
        document.getElementById("logoutBtn").addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            await api("/auth/logout", { method: "POST", body: JSON.stringify({}) });
          } finally {
            window.location.href = "/";
          }
        });
        loadTopTicker();
        loadReviewsBadge();
      </script>
      <script>
        ${input.script}
      </script>
    </body>
  </html>`;
}

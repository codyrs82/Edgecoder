// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BASE_CSS, TOKENS_CSS, THEME_SCRIPT, brandMark, icon } from "./design-system.js";
import { DOCS_SITE_URL } from "./urls.js";
import { CSP_NONCE } from "../csp-nonce.js";
import { CLIENT_ESCAPE_JS } from "./escape.js";

/**
 * Authenticated app shell: left sidebar (brand, navigation, profile row with account menu), top bar (page
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
  // The account menu above the profile row (like Cursor's): where you manage yourself, not the network.
  const accountMenuItems: Array<{ href: string; label: string; icon: string; external?: boolean }> = [
    { href: "/portal/settings#profile", label: "Profile", icon: "user" },
    { href: "/portal/settings", label: "Settings", icon: "settings" },
    { href: "/portal/settings#compute", label: "Compute &amp; usage", icon: "cpu" },
    { href: "/portal/settings#tools", label: "Connect your tools", icon: "key" },
    { href: "/portal/download", label: "Install agent", icon: "download" },
    { href: DOCS_SITE_URL, label: "Docs", icon: "docs", external: true }
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
        /* ── Profile row + account menu (bottom of the sidebar) ── */
        .sidebar-foot { position: relative; border-top: 1px solid var(--card-border); padding: 8px; }
        .profile-row { display: flex; align-items: center; gap: 4px; border-radius: var(--radius-sm); }
        .profile-row:hover, .profile-row.open { background: var(--bg-elevated); }
        .profile-btn {
          flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 7px 8px;
          background: none; border: none; border-radius: var(--radius-sm); color: var(--text); text-align: left; cursor: pointer; min-height: 0;
        }
        .profile-btn:hover { background: none; }
        .avatar {
          flex: none; width: 30px; height: 30px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
          background: var(--brand); color: #111; font-weight: 700; font-size: 13px; text-transform: uppercase; user-select: none;
        }
        .profile-text { min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
        .profile-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .profile-sub { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .profile-gear { flex: none; width: 30px; height: 30px; min-height: 0; padding: 0; margin-right: 4px; background: none; border: none; color: var(--muted); border-radius: var(--radius-sm); }
        .profile-gear:hover { color: var(--text); background: var(--bg-surface); }
        .account-menu {
          position: absolute; left: 8px; right: 8px; bottom: calc(100% + 6px); z-index: 70;
          background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: var(--radius-md);
          box-shadow: var(--shadow-2, 0 12px 32px rgba(0,0,0,0.45)); padding: 5px;
        }
        .account-menu[hidden] { display: none; }
        .account-menu .menu-head { padding: 8px 10px 6px; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .account-menu a[role="menuitem"], .account-menu button[role="menuitem"] {
          display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; min-height: 0;
          background: none; border: none; border-radius: var(--radius-sm); color: var(--text-secondary); font: inherit; font-size: 13px; text-align: left; cursor: pointer;
        }
        .account-menu [role="menuitem"]:hover, .account-menu [role="menuitem"]:focus-visible { background: var(--bg-elevated); color: var(--text); outline: none; }
        .account-menu [role="menuitem"] .icon { flex: none; opacity: 0.85; }
        .account-menu [role="menuitem"] .nav-ext { margin-left: auto; opacity: 0.5; }
        .account-menu hr { border: none; border-top: 1px solid var(--card-border); margin: 5px 2px; }
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
            <div class="account-menu" id="accountMenu" role="menu" aria-labelledby="profileBtn" hidden>
              <div class="menu-head" id="accountMenuEmail"></div>
              ${accountMenuItems.map((m) => `<a role="menuitem" tabindex="-1" href="${m.href}"${m.external ? ' target="_blank" rel="noreferrer"' : ""}>${icon(m.icon, 15)}<span>${m.label}</span>${m.external ? icon("external", 12, "nav-ext") : ""}</a>`).join("")}
              <hr />
              <button type="button" role="menuitem" tabindex="-1" id="logoutBtn">${icon("logout", 15)}<span>Log out</span></button>
            </div>
            <div class="profile-row" id="profileRow">
              <button type="button" class="profile-btn" id="profileBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="accountMenu">
                <span class="avatar" id="profileAvatar" aria-hidden="true"></span>
                <span class="profile-text"><span class="profile-name" id="profileName">&nbsp;</span><span class="profile-sub" id="topTickerCredits" title="cSats balance"><span class="loading-spinner sm"></span></span></span>
              </button>
              <button type="button" class="profile-gear" id="profileGear" aria-label="Account menu" aria-haspopup="menu" aria-expanded="false" aria-controls="accountMenu">${icon("settings", 16)}</button>
            </div>
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
      <script nonce="${CSP_NONCE}">
        const toast = document.getElementById("toast");
        ${THEME_SCRIPT}
        ${CLIENT_ESCAPE_JS}
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
          return "<span class='status-badge " + toneClass + "'>" + escapeHtml(text) + "</span>";
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
        /* ── Profile row: who you are and your cSats balance ── */
        function formatCSats(n) {
          var v = Number(n);
          if (!isFinite(v)) return "";
          return v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }) + " cSats";
        }
        function profileDisplayName(user) {
          var name = String((user && user.displayName) || "").trim();
          if (name) return name;
          var email = String((user && user.email) || "");
          return email ? email.split("@")[0] : "Account";
        }
        async function loadTopTicker() {
          var sub = document.getElementById("topTickerCredits");
          try {
            var me = await requireAuth();
            var user = (me && me.user) || {};
            var name = profileDisplayName(user);
            document.getElementById("profileName").textContent = name;
            document.getElementById("profileAvatar").textContent = name.charAt(0) || "?";
            document.getElementById("accountMenuEmail").textContent = user.email || "";
            document.getElementById("profileBtn").setAttribute("title", user.email || name);
          } catch { return; }
          // The balance lives on the coordinator (cSats); the control plane's credits are a fallback.
          try {
            var s = await api("/portal/api/compute/summary", { method: "GET", headers: {} });
            if (s && s.connected && typeof s.cSats === "number") { sub.textContent = formatCSats(s.cSats); return; }
          } catch {}
          try {
            var summary = await api("/dashboard/summary", { method: "GET", headers: {} });
            var credits = (summary.walletSnapshot || {}).credits;
            if (credits && typeof credits.balance !== "undefined") { sub.textContent = formatCSats(credits.balance); return; }
          } catch {}
          sub.textContent = "Balance unavailable";
        }
        /* ── Account menu: opens above the profile row; Esc, outside click or Tab closes ── */
        (function() {
          var menu = document.getElementById("accountMenu");
          var row = document.getElementById("profileRow");
          var triggers = [document.getElementById("profileBtn"), document.getElementById("profileGear")];
          var lastTrigger = triggers[0];
          function items() { return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]')); }
          function isOpen() { return !menu.hidden; }
          function setExpanded(v) { triggers.forEach(function(t) { t.setAttribute("aria-expanded", v ? "true" : "false"); }); row.classList.toggle("open", v); }
          function openMenu(trigger, focusLast) {
            lastTrigger = trigger || lastTrigger;
            menu.hidden = false; setExpanded(true);
            var list = items(); var target = focusLast ? list[list.length - 1] : list[0];
            if (target) target.focus();
          }
          function closeMenu(restoreFocus) {
            if (!isOpen()) return;
            menu.hidden = true; setExpanded(false);
            if (restoreFocus && lastTrigger) lastTrigger.focus();
          }
          triggers.forEach(function(t) {
            t.addEventListener("click", function(e) { e.stopPropagation(); if (isOpen()) closeMenu(true); else openMenu(t); });
            t.addEventListener("keydown", function(e) {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); openMenu(t, e.key === "ArrowUp"); }
            });
          });
          menu.addEventListener("keydown", function(e) {
            var list = items(); var i = list.indexOf(document.activeElement);
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
            else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
            else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
            else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
            else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
            else if (e.key === "Tab") { closeMenu(false); }
          });
          document.addEventListener("click", function(e) { if (isOpen() && !menu.contains(e.target) && !row.contains(e.target)) closeMenu(false); });
          document.addEventListener("keydown", function(e) { if (e.key === "Escape" && isOpen()) closeMenu(true); });
          // Same-page anchors (Settings sections) still navigate; close the menu after.
          menu.addEventListener("click", function(e) { if (e.target.closest && e.target.closest("a[role=menuitem]")) closeMenu(false); });
        })();
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
      <script nonce="${CSP_NONCE}">
        ${input.script}
      </script>
    </body>
  </html>`;
}

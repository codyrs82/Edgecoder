// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BASE_CSS, TOKENS_CSS, brandMark, icon } from "./design-system.js";
import { htmlOpenTag, themeHeadTags, themeToggleButton } from "../assets.js";
import { DOCS_SITE_URL } from "./urls.js";
import { CSP_NONCE } from "../csp-nonce.js";
import { CLIENT_ESCAPE_JS } from "./escape.js";

/** Account menu entries (the popup above the avatar row), in the desktop app's order. */
export const ACCOUNT_MENU_ITEMS: Array<{ href: string; label: string; icon: string; external?: boolean; adminOnly?: boolean; separatorBefore?: boolean }> = [
  { href: "/portal/settings#profile", label: "Profile", icon: "user" },
  { href: "/portal/settings/plan", label: "Plan &amp; usage", icon: "wallet" },
  { href: "/portal/settings#usage", label: "Usage", icon: "zap" },
  { href: "/portal/settings/compute", label: "Compute", icon: "cpu" },
  { href: "/portal/settings#tools", label: "Connect your tools", icon: "key" },
  { href: "/portal/settings/install", label: "Install agent", icon: "download" },
  { href: "/portal/settings", label: "Settings", icon: "settings" },
  { href: "/portal/settings/admin", label: "Admin", icon: "shield", adminOnly: true },
  { href: DOCS_SITE_URL, label: "Docs", icon: "docs", external: true, separatorBefore: true }
];

/** The short primary list under New chat and Search. Everything about the account and the economy lives in Settings. */
export const PRIMARY_NAV_ITEMS: Array<{ key: string; href: string; label: string; icon: string; badge?: string }> = [
  { key: "chat", href: "/portal/chat", label: "Chat", icon: "chat" },
  { key: "dashboard", href: "/portal/dashboard", label: "Overview", icon: "dashboard" },
  { key: "reviews", href: "/portal/reviews", label: "Reviews", icon: "reviews", badge: "reviewsBadge" }
];

/**
 * Authenticated app shell, laid out like the desktop app: a left sidebar with New chat and Search,
 * a short primary list (Chat, Overview, Reviews), your recent chats grouped by date, and an avatar
 * row at the bottom (name and cSats balance, a gear that opens Settings). Clicking the avatar opens
 * the account menu. Market, Wallet, Install agent and the rest live in Settings. Top bar (page
 * title, subtitle, actions) and content area on the right; on mobile the sidebar slides in behind
 * the menu button.
 *
 * Pages supply `content` (HTML) and `script` (JS) and keep using the shell's helpers: api(),
 * requireAuth(), showToast(), statusBadge(), boolBadge(), sidebarConversationsHtml(). The theme
 * toggle is /assets/theme.js (window.edgecoderTheme).
 * Element ids used by pages: toast, topTickerCredits, reviewsBadge, logoutBtn, hamburgerBtn,
 * topbarNav, and on the chat page newChatBtn, convSearch and convList (the chat page drives the
 * recent-chats list itself; other pages show it as links into the chat). Elements marked
 * data-admin-only are revealed for system admins once /me has loaded; the APIs behind them enforce
 * authorization server-side. No inline event handlers: everything is wired in the scripts.
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
  const onChat = input.activeTab === "chat";
  // On the chat page New chat starts a chat in place; elsewhere it opens the chat page on a new chat.
  const newChat = onChat
    ? `<button type="button" class="nav-link nav-action" id="newChatBtn">${icon("edit", 16)}<span class="nav-label">New chat</span></button>`
    : `<a class="nav-link nav-action" id="newChatBtn" href="/portal/chat?new=1">${icon("edit", 16)}<span class="nav-label">New chat</span></a>`;
  const primaryHtml = PRIMARY_NAV_ITEMS.map((item) => {
    const active = item.key === input.activeTab;
    const badge = item.badge ? `<span class="nav-badge" id="${item.badge}" style="display:none;">0</span>` : "";
    return `<a class="nav-link${active ? " active" : ""}" href="${item.href}" title="${item.label}"${active ? ' aria-current="page"' : ""}>${icon(item.icon, 16)}<span class="nav-label">${item.label}</span>${badge}</a>`;
  }).join("");
  const menuHtml = ACCOUNT_MENU_ITEMS.map((m) => {
    const sep = m.separatorBefore ? "<hr />" : "";
    const ext = m.external ? ' target="_blank" rel="noreferrer"' : "";
    const admin = m.adminOnly ? ' data-admin-only hidden' : "";
    return `${sep}<a role="menuitem" tabindex="-1" href="${m.href}"${ext}${admin}>${icon(m.icon, 15)}<span>${m.label}</span>${m.external ? icon("external", 12, "nav-ext") : ""}</a>`;
  }).join("");

  return `<!doctype html>
  ${htmlOpenTag()}
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${input.title}</title>
      ${themeHeadTags()}
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
        .nav-group { margin-bottom: 10px; }
        .nav-group-label { font-size: 11px; font-weight: 600; color: var(--muted); padding: 10px 10px 4px; }
        button.nav-link { width: 100%; min-height: 0; padding: 8px 10px; gap: 10px; justify-content: flex-start; background: none; border: none; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
        .profile-btn, .account-menu button[role="menuitem"] { justify-content: flex-start; }
        .nav-link.nav-action { color: var(--text); }
        .sidebar-search { padding: 2px 0 6px; }
        .sidebar-search[hidden] { display: none; }
        .sidebar-search input { font-size: 12.5px; padding: 6px 10px; min-height: 30px; background: var(--bg-input); }
        .conv-list { display: flex; flex-direction: column; }
        .conv-group-label { font-size: 11px; font-weight: 600; color: var(--muted); padding: 10px 10px 4px; }
        .conv-item {
          position: relative; display: block; padding: 6px 28px 6px 10px; margin: 1px 0; border-radius: var(--radius-sm);
          font-size: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
          transition: background var(--transition-fast), color var(--transition-fast);
        }
        .conv-item:hover { background: var(--bg-elevated); color: var(--text); }
        .conv-item.active { background: var(--bg-elevated); color: var(--text); }
        .conv-delete {
          position: absolute; right: 4px; top: 50%; transform: translateY(-50%); min-height: 0; padding: 2px 6px;
          opacity: 0; background: none; border: none; cursor: pointer; color: var(--text-secondary); font-size: 14px;
          transition: opacity var(--transition-fast), color var(--transition-fast);
        }
        .conv-item:hover .conv-delete, .conv-delete:focus-visible { opacity: 0.6; }
        .conv-delete:hover { opacity: 1 !important; color: var(--danger); background: none; }
        .conv-empty { padding: 6px 10px; font-size: 12px; color: var(--muted); }
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
          margin-left: auto; background: var(--brand); color: var(--on-accent); font-size: 10px; font-weight: 700;
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
          background: var(--brand); color: var(--on-accent); font-weight: 700; font-size: 13px; text-transform: uppercase; user-select: none;
        }
        .profile-text { min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
        .profile-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .profile-sub { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .profile-gear { flex: none; width: 30px; height: 30px; min-height: 0; padding: 0; margin-right: 4px; background: none; border: none; color: var(--muted); border-radius: var(--radius-sm); }
        .profile-gear { display: inline-flex; align-items: center; justify-content: center; }
        .profile-gear:hover, .profile-gear[aria-current="page"] { color: var(--text); background: var(--bg-surface); }
        .account-menu {
          position: absolute; left: 8px; right: 8px; bottom: calc(100% + 6px); z-index: 70;
          background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: var(--radius-md);
          box-shadow: var(--shadow-2, 0 12px 32px rgba(0,0,0,0.45)); padding: 5px;
        }
        .account-menu[hidden], .account-menu [role="menuitem"][hidden] { display: none; }
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
            <a href="/portal/chat">${brandMark(28)}<span><div class="brand-name">EdgeCoder</div><div class="brand-sub">Compute network</div></span></a>
          </div>
          <nav class="sidebar-nav" aria-label="Primary">
            <div class="nav-group">
              ${newChat}
              <button type="button" class="nav-link" id="sidebarSearchBtn" aria-expanded="false" aria-controls="sidebarSearch">${icon("search", 16)}<span class="nav-label">Search</span></button>
              <div class="sidebar-search" id="sidebarSearch" hidden><input id="convSearch" type="search" placeholder="Search chats" aria-label="Search chats" autocomplete="off" /></div>
            </div>
            <div class="nav-group">${primaryHtml}</div>
            <div class="nav-group" aria-label="Recent chats">
              <div class="conv-list" id="convList"></div>
            </div>
          </nav>
          <div class="sidebar-foot">
            <div class="account-menu" id="accountMenu" role="menu" aria-labelledby="profileBtn" hidden>
              <div class="menu-head" id="accountMenuEmail"></div>
              ${menuHtml}
              <hr />
              <button type="button" role="menuitem" tabindex="-1" id="logoutBtn">${icon("logout", 15)}<span>Log out</span></button>
            </div>
            <div class="profile-row" id="profileRow">
              <button type="button" class="profile-btn" id="profileBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="accountMenu">
                <span class="avatar" id="profileAvatar" aria-hidden="true"></span>
                <span class="profile-text"><span class="profile-name" id="profileName">&nbsp;</span><span class="profile-sub" id="topTickerCredits" title="cSats balance"><span class="loading-spinner sm"></span></span></span>
              </button>
              <a class="profile-gear" id="profileGear" href="/portal/settings" title="Settings" aria-label="Settings"${input.activeTab === "settings" ? ' aria-current="page"' : ""}>${icon("settings", 16)}</a>
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
            <div class="topbar-actions">${input.actions ?? ""}${themeToggleButton()}</div>
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
          window.closeMobileNav = close;
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
            if (user.roles && user.roles.isSystemAdmin) {
              document.querySelectorAll("[data-admin-only]").forEach(function(e) { e.hidden = false; e.classList.remove("hidden"); });
            }
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
          var triggers = [document.getElementById("profileBtn")];
          var lastTrigger = triggers[0];
          function items() { return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]:not([hidden])')); }
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
        /* ── Recent chats, grouped like the desktop: Today, Yesterday, Previous 7 days, Older ── */
        function sidebarConversationsHtml(list, activeId, opts) {
          opts = opts || {};
          if (!list || !list.length) return '<div class="conv-empty">' + escapeHtml(opts.emptyText || "No chats yet") + "</div>";
          var start = new Date(); start.setHours(0, 0, 0, 0);
          var t0 = start.getTime(), day = 86400000;
          var groups = [["Today", []], ["Yesterday", []], ["Previous 7 days", []], ["Older", []]];
          list.forEach(function(c) {
            var t = Number(c.updatedAtMs || c.createdAtMs || 0);
            var g = t >= t0 ? 0 : t >= t0 - day ? 1 : t >= t0 - 7 * day ? 2 : 3;
            groups[g][1].push(c);
          });
          return groups.filter(function(g) { return g[1].length; }).map(function(g) {
            return '<div class="conv-group-label">' + g[0] + "</div>" + g[1].map(function(c) {
              var id = escapeHtml(c.conversationId), title = escapeHtml(c.title || "New chat");
              var cls = "conv-item" + (c.conversationId === activeId ? " active" : "");
              if (opts.links) return '<a class="' + cls + '" href="/portal/chat?c=' + encodeURIComponent(c.conversationId) + '" title="' + title + '">' + title + "</a>";
              return '<div class="' + cls + '" data-id="' + id + '" title="' + title + '">' + title + '<button type="button" class="conv-delete" data-delete-id="' + id + '" title="Delete" aria-label="Delete chat">&times;</button></div>';
            }).join("");
          }).join("");
        }
        (function() {
          var btn = document.getElementById("sidebarSearchBtn");
          var wrap = document.getElementById("sidebarSearch");
          var input = document.getElementById("convSearch");
          btn.addEventListener("click", function() {
            wrap.hidden = !wrap.hidden;
            btn.setAttribute("aria-expanded", wrap.hidden ? "false" : "true");
            if (!wrap.hidden) input.focus();
            else if (input.value) { input.value = ""; input.dispatchEvent(new Event("input")); }
          });
          input.addEventListener("keydown", function(e) { if (e.key === "Escape") { e.stopPropagation(); btn.click(); btn.focus(); } });
          document.getElementById("convList").addEventListener("click", function(e) {
            if (e.target.closest && e.target.closest(".conv-item") && !e.target.closest(".conv-delete") && window.closeMobileNav) window.closeMobileNav();
          });
          ${onChat ? "// The chat page renders the list and handles search and New chat itself." : `
          var all = [];
          function render() {
            var q = input.value.trim().toLowerCase();
            var shown = all.filter(function(c) { return !q || String(c.title || "").toLowerCase().indexOf(q) !== -1; }).slice(0, 30);
            document.getElementById("convList").innerHTML = sidebarConversationsHtml(shown, null, { links: true, emptyText: q ? "No matching chats" : "No chats yet" });
          }
          input.addEventListener("input", render);
          fetch("/portal/api/conversations", { credentials: "include" })
            .then(function(r) { return r.ok ? r.json() : { conversations: [] }; })
            .then(function(res) { all = (res && res.conversations) || []; render(); })
            .catch(function() {});`}
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

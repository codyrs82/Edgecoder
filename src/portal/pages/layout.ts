// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { BASE_CSS, TOKENS_CSS, brandMark, icon } from "./design-system.js";
import { htmlOpenTag, themeHeadTags, themeToggleButton } from "../assets.js";
import { DOCS_SITE_URL } from "./urls.js";
import { CSP_NONCE } from "../csp-nonce.js";
import { CLIENT_ESCAPE_JS } from "./escape.js";
import { CLIENT_BOT_HELPERS_JS } from "./bot-helpers.js";
import { LEGAL_FOOTER_CSS, legalFooterHtml } from "./legal-footer.js";

/** Account menu entries (the popup above the avatar row), in the desktop app's order. */
export const ACCOUNT_MENU_ITEMS: Array<{ href: string; label: string; icon: string; external?: boolean; adminOnly?: boolean; separatorBefore?: boolean }> = [
  { href: "/portal/welcome", label: "Getting started", icon: "check" },
  { href: "/portal/settings#profile", label: "Profile", icon: "user" },
  { href: "/portal/settings/plan", label: "Wallet", icon: "wallet" },
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
  { key: "code", href: "/portal/code", label: "Code", icon: "code" },
  { key: "dashboard", href: "/portal/dashboard", label: "Overview", icon: "dashboard" },
  { key: "reviews", href: "/portal/reviews", label: "Reviews", icon: "reviews", badge: "reviewsBadge" }
];

/**
 * Authenticated app shell, laid out like the desktop app: a left sidebar with New chat and Search,
 * a short primary list (Chat, Code, Overview, Reviews), your recent chats grouped by date, and an avatar
 * row at the bottom (name and cSats balance, a gear that opens Settings). Clicking the avatar opens
 * the account menu. Market, Wallet, Install agent and the rest live in Settings. Top bar (page
 * title, subtitle, actions) and content area on the right; on mobile the sidebar slides in behind
 * the menu button. Every page but the chat (which fills the window) ends with the legal footer.
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
  activeTab: "chat" | "code" | "dashboard" | "wallet" | "market" | "settings" | "download" | "reviews" | "bots";
  heading: string;
  subtitle: string;
  content: string;
  script: string;
  /** Optional HTML rendered on the right of the top bar (buttons, filters). */
  actions?: string;
  /**
   * Replaces the sidebar's navigation (chat, search, recent chats) with this HTML. Settings uses it
   * so its sections take over the left pane, as in Claude and Cursor, with a way back to the app.
   */
  sidebarNav?: string;
}): string {
  const onChat = input.activeTab === "chat";
  // On the chat page New chat starts a chat in place; elsewhere it opens the chat page on a new chat.
  const newChat = onChat
    ? `<button type="button" class="nav-link nav-action" id="newChatBtn">${icon("edit", 16)}<span class="nav-label">New chat</span></button>`
    : `<a class="nav-link nav-action" id="newChatBtn" href="/portal/chat?new=1">${icon("edit", 16)}<span class="nav-label">New chat</span></a>`;
  const primaryHtml = PRIMARY_NAV_ITEMS.map((item) => {
    const active = item.key === input.activeTab;
    const badge = item.badge ? `<span class="nav-badge hidden" id="${item.badge}">0</span>` : "";
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
      <style nonce="${CSP_NONCE}">
        ${TOKENS_CSS}
        ${BASE_CSS}
        /* ── Shell ── */
        .app { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 100vh; min-height: 100dvh; }
        .sidebar {
          position: sticky; top: 0; height: 100vh; height: 100dvh; display: flex; flex-direction: column;
          background: var(--bg-soft); border-right: 1px solid var(--card-border);
        }
        .sidebar-brand { display: flex; align-items: center; gap: 10px; padding: 14px 16px; height: var(--topbar-h); border-bottom: 1px solid var(--card-border); }
        .sidebar-brand a { display: flex; align-items: center; gap: 10px; color: var(--text); }
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
        /* ── Bots: the bots on your desktop machines (pages/bots.ts) ── */
        .nav-group-link { display: flex; align-items: center; gap: 6px; border-radius: var(--radius-sm); }
        .nav-group-link:hover, .nav-group-link.active { color: var(--text); background: var(--bg-elevated); }
        .bot-nav-list { display: flex; flex-direction: column; }
        .bot-nav-item {
          display: flex; align-items: center; gap: 8px; padding: 5px 10px; margin: 1px 0; border-radius: var(--radius-sm);
          color: var(--text-secondary); font-size: 13px; min-width: 0;
        }
        .bot-nav-item:hover, .bot-nav-item.active { background: var(--bg-elevated); color: var(--text); }
        .bot-nav-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
        .bot-nav-name, .bot-nav-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bot-nav-sub { font-size: 11px; color: var(--muted); }
        .bot-ava {
          --bot-color: var(--brand);
          flex: none; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
          background: color-mix(in srgb, var(--bot-color) 22%, var(--bg-surface)); color: var(--text); border: 1.5px solid var(--bot-color);
          font-size: 11px; font-weight: 700; position: relative; user-select: none;
        }
        .bot-ava.shape-block { border-radius: 6px; } .bot-ava.shape-hex { border-radius: 30%; } .bot-ava.shape-robot { border-radius: 8px 8px 50% 50%; }
        .bot-ava .bot-dot { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--bg-soft); background: var(--muted); }
        .bot-dot.tone-accent { background: var(--brand); } .bot-dot.tone-warn { background: var(--yellow); } .bot-dot.tone-err { background: var(--danger); } .bot-dot.tone-ok { background: var(--ok); }
        .bot-dot.offline { background: var(--bg-elevated); border-color: var(--muted); }
        .nav-badge {
          margin-left: auto; background: var(--brand); color: var(--on-accent); font-size: 10px; font-weight: 700;
          min-width: 18px; height: 18px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; padding: 0 5px;
        }
        .topbar-lead { display: flex; align-items: center; gap: 10px; min-width: 0; }
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
          box-shadow: var(--shadow-2); padding: 5px;
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
        .verify-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .verify-banner[hidden] { display: none; }
        .verify-banner-text { font-size: 13px; }
        .verify-banner .link-btn { background: none; border: none; padding: 0; min-height: 0; color: var(--brand-2); text-decoration: underline; font: inherit; cursor: pointer; }
        .verify-banner-close { flex: none; min-height: 0; padding: 4px; }
        ${LEGAL_FOOTER_CSS}
        .main > .legal-footer { margin-top: auto; }
        /* ── Mobile ── */
        @media (max-width: 900px) {
          .app { grid-template-columns: 1fr; }
          .sidebar { position: fixed; inset: 0 auto 0 0; width: min(300px, 86vw); transform: translateX(-100%); transition: transform var(--transition-med); z-index: 60; box-shadow: var(--shadow-2); }
          .sidebar.mobile-open { transform: translateX(0); }
          .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 55; display: none; }
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
          ${input.sidebarNav ?? `<nav class="sidebar-nav" aria-label="Primary">
            <div class="nav-group">
              ${newChat}
              <button type="button" class="nav-link" id="sidebarSearchBtn" aria-expanded="false" aria-controls="sidebarSearch">${icon("search", 16)}<span class="nav-label">Search</span></button>
              <div class="sidebar-search" id="sidebarSearch" hidden><input id="convSearch" type="search" placeholder="Search chats" aria-label="Search chats" autocomplete="off" /></div>
            </div>
            <div class="nav-group">${primaryHtml}</div>
            <div class="nav-group bots-nav" role="group" aria-labelledby="botsNavLabel">
              <a class="nav-group-label nav-group-link${input.activeTab === "bots" ? " active" : ""}" id="botsNavLabel" href="/portal/bots"${input.activeTab === "bots" ? ' aria-current="page"' : ""}>${icon("bot", 14)}<span>Bots</span></a>
              <div class="bot-nav-list" id="botNavList"></div>
            </div>
            <div class="nav-group" aria-label="Recent chats">
              <div class="conv-list" id="convList"></div>
            </div>
          </nav>`}
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
            <div class="topbar-lead">
              <button class="hamburger-btn ghost" id="hamburgerBtn" aria-label="Open navigation">${icon("menu", 18)}</button>
              <div class="topbar-title"><h1>${input.heading}</h1><div class="sub">${input.subtitle}</div></div>
            </div>
            <div class="topbar-actions">${input.actions ?? ""}${themeToggleButton()}</div>
          </header>
          <div class="shell">
            <div id="verifyEmailBanner" class="callout warn verify-banner" role="status" hidden>
              <div class="verify-banner-text"><strong>Verify your email:</strong> we sent a link to <span id="verifyEmailMasked"></span>. <button type="button" class="link-btn" id="verifyEmailResend">Resend</button></div>
              <button type="button" class="ghost verify-banner-close" id="verifyEmailDismiss" aria-label="Dismiss">${icon("x", 14)}</button>
            </div>
            <div id="admin2faBanner" class="callout warn verify-banner" role="status" hidden>
              <div class="verify-banner-text"><strong>Turn on two-factor authentication:</strong> admins must have it. <span id="admin2faWhen"></span> <a href="/portal/settings#profile">Set it up in Settings, Profile</a>.</div>
            </div>
            <div class="content-stack">
              ${input.content}
            </div>
          </div>
          ${onChat ? "" : legalFooterHtml()}
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
        /* ── Two-factor step-up: a protected action answered 403 two_factor_required (routes/account-security.ts).
           Ask for a code (or the passkey), make the step-up, and send the request once more. ── */
        (function() {
          if (typeof window.fetch !== "function") return;
          var origFetch = window.fetch.bind(window);
          var post = function(path, body) { return origFetch(path, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); };
          var toBuf = function(v) { v = String(v).replace(/-/g, "+").replace(/_/g, "/"); v += "=".repeat((4 - (v.length % 4)) % 4); var bin = atob(v); var a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a.buffer; };
          var toB64u = function(buf) { var b = new Uint8Array(buf); var str = ""; for (var i = 0; i < b.length; i++) str += String.fromCharCode(b[i]); return btoa(str).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, ""); };
          async function passkeyStepUp() {
            if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("passkeys_unsupported");
            var r = await post("/portal/api/security/2fa/passkey/options");
            var o = await r.json();
            if (!r.ok) throw new Error(o.error || "passkey_options_failed");
            var opts = o.options || {};
            var cred = await navigator.credentials.get({ publicKey: {
              challenge: toBuf(opts.challenge), rpId: opts.rpId, timeout: opts.timeout, userVerification: opts.userVerification || "required",
              allowCredentials: (opts.allowCredentials || []).map(function(c) { return { id: toBuf(c.id), type: "public-key", transports: c.transports }; })
            } });
            var response = { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, clientExtensionResults: {}, response: {
              clientDataJSON: toB64u(cred.response.clientDataJSON), authenticatorData: toB64u(cred.response.authenticatorData),
              signature: toB64u(cred.response.signature), userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : undefined } };
            var v = await post("/portal/api/security/2fa/passkey/verify", { challengeId: o.challengeId, credentialId: cred.id, response: response });
            if (!v.ok) throw new Error("passkey_verification_failed");
          }
          async function stepUp(methods) {
            methods = methods || [];
            var hasCode = methods.indexOf("totp") >= 0;
            var hasPasskey = methods.indexOf("passkey") >= 0;
            if (hasCode) {
              var code = window.prompt("Two-factor authentication: enter the 6-digit code from your authenticator app, or a recovery code." + (hasPasskey ? " Leave it empty to use your passkey instead." : ""));
              if (code === null) return false;
              if (code.trim()) {
                var r = await post("/portal/api/security/2fa/verify", { code: code.trim() });
                if (r.ok) return true;
                var j = {}; try { j = await r.json(); } catch {}
                window.alert(j.error === "two_factor_rate_limited" ? "Too many wrong codes. Wait 15 minutes and try again." : "That code is not right.");
                return false;
              }
            }
            if (hasPasskey) {
              try { await passkeyStepUp(); return true; } catch { window.alert("Passkey confirmation did not complete."); return false; }
            }
            return false;
          }
          window.edgecoderStepUp = stepUp;
          window.fetch = async function(input, init) {
            var res = await origFetch(input, init);
            if (res.status !== 403) return res;
            var j = null; try { j = await res.clone().json(); } catch {}
            if (!j || j.error !== "two_factor_required") return res;
            if (!(await stepUp(j.methods))) return res;
            return origFetch(input, init);
          };
        })();
        /* ── Admins without 2FA: a banner until they turn it on (enforced after ADMIN_2FA_GRACE_DAYS) ── */
        async function showAdmin2faBanner() {
          try {
            var st = await api("/portal/api/security/2fa", { method: "GET", headers: {} });
            if (!st || !st.admin || st.enabled) return;
            var when = document.getElementById("admin2faWhen");
            when.textContent = st.admin.enforced ? "Admin changes are paused until you do." : st.admin.graceEndsAtMs ? "Admin changes stop working on " + new Date(st.admin.graceEndsAtMs).toLocaleDateString() + " without it." : "";
            document.getElementById("admin2faBanner").hidden = false;
          } catch {}
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
        /* ── Unverified address: a banner on every page until verified (dismissible for this browser session) ── */
        function maskEmail(email) {
          var at = email.lastIndexOf("@");
          return at > 0 ? email.slice(0, 1) + "\u2026@" + email.slice(at + 1) : "your email address";
        }
        function showVerifyEmailBanner(user) {
          var banner = document.getElementById("verifyEmailBanner");
          var email = String((user && user.email) || "");
          // Agent accounts (store.ts AGENT_EMAIL_DOMAIN) have no inbox to verify.
          if (!banner || !user || user.emailVerified !== false || !email || /@agents\\.invalid$/i.test(email)) return;
          try { if (sessionStorage.getItem("edgecoder-verify-banner-dismissed") === "1") return; } catch {}
          document.getElementById("verifyEmailMasked").textContent = maskEmail(email);
          banner.hidden = false;
          document.getElementById("verifyEmailDismiss").addEventListener("click", function() {
            banner.hidden = true;
            try { sessionStorage.setItem("edgecoder-verify-banner-dismissed", "1"); } catch {}
          });
          var resend = document.getElementById("verifyEmailResend");
          resend.addEventListener("click", async function() {
            resend.disabled = true;
            try {
              await api("/auth/resend-verification", { method: "POST", body: JSON.stringify({ email: email }) });
              showToast("Verification email sent to " + maskEmail(email) + ". Check your inbox.");
            } catch (err) {
              showToast("Could not resend: " + String((err && err.message) || err), true);
            } finally {
              setTimeout(function() { resend.disabled = false; }, 30000);
            }
          });
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
            showVerifyEmailBanner(user);
            if (user.roles && user.roles.isSystemAdmin) showAdmin2faBanner();
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
          if (!document.getElementById("convList")) return;
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
              badge.classList.remove("hidden");
            }
          } catch { /* noop */ }
        }
        /* ── Bots in the sidebar: the bots on your desktop machines (pages/bots.ts) ── */
        ${CLIENT_BOT_HELPERS_JS}
        async function loadBotsNav() {
          var list = document.getElementById("botNavList");
          if (!list) return;
          try {
            var res = await api("/portal/api/bots", { method: "GET", headers: {} });
            var bots = (res && res.bots) || [];
            window.edgecoderBots = res;
            var here = new URLSearchParams(location.search);
            list.innerHTML = bots.length ? bots.map(function(b) {
              var active = location.pathname === "/portal/bots" && here.get("m") === b.machine.agentId && here.get("b") === b.id;
              var sub = (b.machine.online ? botStatusChip(b).text : "offline") + " · " + b.machine.machineName;
              return '<a class="bot-nav-item' + (active ? " active" : "") + '" href="' + botHref(b.machine.agentId, b.id) + '"' + (active ? ' aria-current="page"' : "") + ' title="' + escapeHtml(botTitle(b) + " · on " + b.machine.machineName + (b.machine.online ? "" : " · offline")) + '">' +
                botAvatarHtml(b, b.machine.online) +
                '<span class="bot-nav-text"><span class="bot-nav-name">' + escapeHtml(b.name) + '</span><span class="bot-nav-sub">' + escapeHtml(sub) + "</span></span></a>";
            }).join("") : '<div class="conv-empty">Bots on your desktop show here</div>';
            paintBotAvatars(list);
          } catch { /* signed out, or no machines yet */ }
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
        if (document.getElementById("botNavList")) { loadBotsNav(); setInterval(function() { if (!document.hidden) loadBotsNav(); }, 30000); }
      </script>
      <script nonce="${CSP_NONCE}">
        ${input.script}
      </script>
    </body>
  </html>`;
}

/**
 * #27: the signed-out single-card page (reset password, verify email): brand, one card, a way back
 * to sign-in and the theme toggle. Pages supply `content` (HTML) and `script` (JS); `show(text,
 * kind)` writes to the `#msg` callout, which starts hidden unless `message` is given. These pages
 * read a token from the URL, so they send no referrer.
 */
export function portalCardPageHtml(input: {
  title: string;
  content: string;
  script: string;
  /** Initial text of the #msg callout. */
  message?: string;
  /** Optional small print (HTML) under the callout. */
  note?: string;
}): string {
  return `<!doctype html>
  ${htmlOpenTag()}
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="no-referrer" />
      <title>${input.title}</title>
      ${themeHeadTags()}
      <style nonce="${CSP_NONCE}">
        ${TOKENS_CSS}
        ${BASE_CSS}
        .wrap { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 36px 16px; }
        ${LEGAL_FOOTER_CSS}
        .page-card { width: min(420px, 100%); }
        .page-card .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; margin-bottom: 24px; }
        .page-card h2 { font-size: 20px; margin-bottom: 4px; }
        .page-card .sub { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
        .page-card button.primary { width: 100%; margin-top: 14px; }
        .msg { margin-top: 14px; }
        .page-note { margin: 16px 0 0; }
        .page-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; font-size: 12px; color: var(--muted); }
        .page-foot .theme-toggle { min-height: 0; padding: 0 4px; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="page-card">
          <div class="brand">${brandMark(28)}<span>EdgeCoder</span></div>
          ${input.content}
          <div id="msg" class="callout msg${input.message ? "" : " hidden"}" role="status" aria-live="polite">${input.message ?? ""}</div>
          ${input.note ? `<p class="muted page-note">${input.note}</p>` : ""}
          <div class="page-foot"><a href="/portal">Back to sign in</a>${themeToggleButton()}</div>
        </div>
        ${legalFooterHtml()}
      </div>
      <script nonce="${CSP_NONCE}">
        const msg = document.getElementById("msg");
        function show(text, kind) {
          msg.textContent = text;
          msg.className = "callout msg " + (kind || "");
        }
        ${input.script}
      </script>
    </body>
  </html>`;
}

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { icon } from "./design-system.js";

/**
 * The Chat / Code switch at the top of the portal sidebar, like the desktop app's. Chat mode lists
 * your web chats; Code mode lists the coding sessions on your Macs (the same relay as /portal/code,
 * routes/code.ts), grouped by project, newest first, each marked with a remote-computer icon and
 * the Mac's name, since the session runs on that Mac and not here.
 *
 * The chat and code pages fix the mode; every other page shows the one you picked last
 * (localStorage "edgecoder-sidebar-mode"). The switch is two links: Chat opens /portal/chat, Code
 * opens /portal/code. Elements carry .chat-only / .code-only and the sidebar's data-mode hides the
 * other set, so nothing is fetched or shown for the mode you're not in.
 */
export type SidebarMode = "chat" | "code";

export const SIDEBAR_MODE_KEY = "edgecoder-sidebar-mode";

export function sidebarModeSwitchHtml(current: SidebarMode | null): string {
  const tab = (mode: SidebarMode, href: string, label: string, ic: string) =>
    `<a class="mode-tab" href="${href}" data-mode-tab="${mode}"${current === mode ? ' aria-current="page"' : ""}>${icon(ic, 14)}<span>${label}</span></a>`;
  return `<div class="mode-switch" role="group" aria-label="Chat or Code">${tab("chat", "/portal/chat", "Chat", "chat")}${tab("code", "/portal/code", "Code", "code")}</div>`;
}

export const SIDEBAR_MODE_CSS = `
        .mode-switch { display: flex; gap: 2px; padding: 2px; margin: 0 0 8px; border-radius: var(--radius-sm); background: var(--bg-elevated); }
        .mode-tab {
          flex: 1 1 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 0;
          padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12.5px; font-weight: 500; color: var(--text-secondary);
          transition: background var(--transition-fast), color var(--transition-fast);
        }
        .mode-tab:hover { color: var(--text); }
        .sidebar[data-mode="chat"] .mode-tab[data-mode-tab="chat"], .sidebar[data-mode="code"] .mode-tab[data-mode-tab="code"] { background: var(--bg-surface); color: var(--text); box-shadow: var(--shadow-1); }
        .sidebar[data-mode="chat"] .code-only, .sidebar[data-mode="code"] .chat-only { display: none; }
        .code-nav-item { display: flex; align-items: center; gap: 8px; padding-right: 10px; }
        .code-nav-item .icon { flex: none; color: var(--muted); }
        .code-nav-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
        .code-nav-title, .code-nav-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .code-nav-sub { font-size: 11px; color: var(--muted); }
        .code-nav-sub .waiting { color: var(--yellow); }
        .code-nav-hint { line-height: 1.5; }
`;

/**
 * Browser JS, run by the shell after its helpers (escapeHtml). `fixed` is the page's own mode, or
 * null on the other pages. Exposes renderCodeNav() for the shell's search box.
 */
export function sidebarModeJs(fixed: SidebarMode | null): string {
  return String.raw`
        var SIDEBAR_MODE_ICON = ${JSON.stringify(icon("monitor", 14))};
        var sidebarMode = (function() {
          var fixed = ${JSON.stringify(fixed)}, mode = fixed;
          if (!mode) { try { mode = localStorage.getItem("${SIDEBAR_MODE_KEY}"); } catch (_e) { mode = null; } }
          if (mode !== "code") mode = "chat";
          if (fixed) { try { localStorage.setItem("${SIDEBAR_MODE_KEY}", fixed); } catch (_e) { /* storage unavailable */ } }
          var side = document.getElementById("topbarNav");
          if (side && document.getElementById("codeNavList")) side.setAttribute("data-mode", mode);
          var search = document.getElementById("convSearch");
          if (search && mode === "code") { search.placeholder = "Search sessions"; search.setAttribute("aria-label", "Search sessions"); }
          document.querySelectorAll("[data-mode-tab]").forEach(function(a) {
            a.addEventListener("click", function() { try { localStorage.setItem("${SIDEBAR_MODE_KEY}", a.getAttribute("data-mode-tab")); } catch (_e) { /* storage unavailable */ } });
          });
          return mode;
        })();
        /* Code mode: sessions on your Macs, grouped by project (newest first), each with its Mac. */
        var codeNavMachines = null;
        function codeNavAgo(ms) {
          var s = Math.max(0, Math.round((Date.now() - (ms || 0)) / 1000));
          if (!ms) return "";
          if (s < 60) return "just now";
          if (s < 3600) return Math.round(s / 60) + " min ago";
          if (s < 86400) return Math.round(s / 3600) + " h ago";
          return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        }
        function codeNavHtml(machines, q, activePath) {
          var sharing = machines.filter(function(m) { return m.controls === "on" || m.controls === "view"; });
          if (!sharing.length) return '<div class="conv-empty code-nav-hint">Turn on <strong>Code from your phone</strong> in the EdgeCoder app on your Mac</div>';
          var groups = {}, order = [];
          sharing.forEach(function(m) {
            (m.sessions || []).forEach(function(s) {
              var p = (m.projects || []).find(function(x) { return x.projectId === s.projectId; });
              var name = (p && p.name) || "Project";
              var hay = (s.title + " " + name + " " + m.name).toLowerCase();
              if (q && hay.indexOf(q) === -1) return;
              var key = m.agentId + "\u0000" + s.projectId;
              if (!groups[key]) { groups[key] = { name: name, rows: [], newest: 0 }; order.push(key); }
              groups[key].rows.push({ m: m, s: s });
              groups[key].newest = Math.max(groups[key].newest, s.updatedAtMs || 0);
            });
          });
          if (!order.length) return '<div class="conv-empty">' + (q ? "No matching sessions" : "No sessions yet. Start one with New session.") + "</div>";
          order.sort(function(a, b) { return groups[b].newest - groups[a].newest; });
          return order.map(function(key) {
            var g = groups[key];
            g.rows.sort(function(a, b) { return (b.s.updatedAtMs || 0) - (a.s.updatedAtMs || 0); });
            return '<div class="conv-group-label">' + escapeHtml(g.name) + "</div>" + g.rows.map(function(r) {
              var href = "/portal/code/" + encodeURIComponent(r.m.agentId) + "/" + encodeURIComponent(r.s.sessionId);
              var active = href === activePath;
              var title = r.s.title || "Untitled session";
              var wait = r.s.status === "waiting" ? '<span class="waiting">Waiting for you</span> · ' : r.s.status === "running" ? "Working · " : "";
              var ago = codeNavAgo(r.s.updatedAtMs);
              return '<a class="conv-item code-nav-item' + (active ? " active" : "") + '" href="' + href + '"' + (active ? ' aria-current="page"' : "") +
                ' title="' + escapeHtml(title + " · runs on " + r.m.name + (r.m.online ? "" : " (offline)")) + '">' + SIDEBAR_MODE_ICON +
                '<span class="code-nav-text"><span class="code-nav-title">' + escapeHtml(title) + '</span><span class="code-nav-sub">' + wait + escapeHtml(r.m.name + (r.m.online ? "" : " · offline") + (ago ? " · " + ago : "")) + "</span></span></a>";
            }).join("");
          }).join("");
        }
        function renderCodeNav() {
          var list = document.getElementById("codeNavList");
          if (!list || !codeNavMachines) return;
          var input = document.getElementById("convSearch");
          var path = location.pathname.replace(/\/$/, "");
          list.innerHTML = codeNavHtml(codeNavMachines, input ? input.value.trim().toLowerCase() : "", path);
        }
        async function loadCodeNav() {
          try {
            var res = await fetch("/portal/api/code/machines", { credentials: "include" });
            if (!res.ok) return;
            codeNavMachines = ((await res.json()) || {}).machines || [];
            renderCodeNav();
          } catch (_e) { /* offline, or signed out */ }
        }
        if (sidebarMode === "code" && document.getElementById("codeNavList")) {
          var convSearchEl = document.getElementById("convSearch");
          if (convSearchEl) convSearchEl.addEventListener("input", renderCodeNav);
          loadCodeNav();
          setInterval(function() { if (!document.hidden) loadCodeNav(); }, 20000);
        }
`;
}

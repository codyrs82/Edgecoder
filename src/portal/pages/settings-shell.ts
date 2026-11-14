// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from "fastify";
import { icon } from "./design-system.js";
import { portalAuthedPageHtml } from "./layout.js";

/**
 * The Settings frame (like the desktop app's): a left sub-navigation with icons and a "Search
 * settings" box, and a pane of sections made of rounded cards whose rows put a title and
 * description on the left and the control on the right. Settings is the home for everything about
 * the account and the economy. General, Profile, Usage and Connect your tools live on
 * /portal/settings (one shown at a time, chosen by #hash); Plan & usage (the wallet), Compute (the
 * market and reservations), Nodes, Install agent and Admin have their own URLs under
 * /portal/settings/. Admin is revealed client-side for system admins only; its APIs enforce
 * authorization server-side.
 */
export type SettingsSection = "general" | "profile" | "plan" | "usage" | "compute" | "tools" | "nodes" | "install" | "admin";

export const SETTINGS_NAV: Array<{ key: SettingsSection; label: string; icon: string; href: string; adminOnly?: boolean }> = [
  { key: "general", label: "General", icon: "layers", href: "/portal/settings#general" },
  { key: "profile", label: "Profile", icon: "user", href: "/portal/settings#profile" },
  { key: "plan", label: "Plan &amp; usage", icon: "wallet", href: "/portal/settings/plan" },
  { key: "usage", label: "Usage", icon: "zap", href: "/portal/settings#usage" },
  { key: "compute", label: "Compute", icon: "cpu", href: "/portal/settings/compute" },
  { key: "tools", label: "Connect your tools", icon: "key", href: "/portal/settings#tools" },
  { key: "nodes", label: "Nodes", icon: "server", href: "/portal/settings/nodes" },
  { key: "install", label: "Install agent", icon: "download", href: "/portal/settings/install" },
  { key: "admin", label: "Admin", icon: "shield", href: "/portal/settings/admin", adminOnly: true }
];

/**
 * Old top-level pages now live in Settings. Each old URL redirects (302) to its section and keeps
 * the query string (the install page reads ?token=).
 */
export const LEGACY_SETTINGS_REDIRECTS: Record<string, string> = {
  "/portal/wallet": "/portal/settings/plan",
  "/portal/market": "/portal/settings/compute",
  "/portal/download": "/portal/settings/install",
  "/portal/nodes": "/portal/settings/nodes",
  "/portal/coordinator-ops": "/portal/settings/admin"
};

export function redirectKeepingQuery(target: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.url.indexOf("?");
    return reply.redirect(target + (q >= 0 ? req.url.slice(q) : ""));
  };
}

/** One settings row: title and description on the left, the control on the right. */
export function settingRow(title: string, desc: string, control: string, opts: { keywords?: string; id?: string; wide?: boolean } = {}): string {
  const kw = opts.keywords ? ` data-keywords="${opts.keywords}"` : "";
  const id = opts.id ? ` id="${opts.id}"` : "";
  return `<div class="set-row${opts.wide ? " wide" : ""}"${id}${kw}><div class="set-text"><div class="set-label">${title}</div>${desc ? `<div class="set-desc">${desc}</div>` : ""}</div><div class="set-control">${control}</div></div>`;
}

export const SETTINGS_CSS = `
  <style>
    .settings-layout { display: grid; grid-template-columns: 216px minmax(0, 1fr); gap: 36px; max-width: 1060px; margin: 4px auto 0; }
    .settings-nav { position: sticky; top: calc(var(--topbar-h) + 20px); align-self: start; }
    .settings-search { position: relative; margin-bottom: 10px; }
    .settings-search .icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
    .settings-search input { padding-left: 32px; background: var(--bg-soft); }
    .settings-links { display: flex; flex-direction: column; gap: 1px; }
    .settings-link {
      display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: var(--radius-sm);
      font-size: 13px; font-weight: 500; color: var(--text-secondary);
    }
    .settings-link:hover { background: var(--bg-elevated); color: var(--text); }
    .settings-link[aria-current="page"] { background: var(--bg-elevated); color: var(--text); }
    .settings-link .icon { flex: none; opacity: 0.85; }
    .settings-link.dim { opacity: 0.35; }
    .settings-pane { min-width: 0; max-width: 780px; }
    .settings-layout.wide { max-width: none; }
    .settings-layout.wide .settings-pane { max-width: none; }
    .set-section { margin-bottom: 28px; }
    .set-title { font-size: 20px; font-weight: 600; letter-spacing: -0.015em; margin-bottom: 4px; }
    .set-lead { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
    .set-group { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 20px 0 8px 2px; }
    .set-card { border: 1px solid var(--card-border); border-radius: var(--radius-lg); background: var(--card); margin-bottom: 14px; overflow: hidden; }
    .set-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 16px; }
    .set-row + .set-row { border-top: 1px solid var(--card-border); }
    .set-row.wide { flex-direction: column; align-items: stretch; gap: 10px; }
    .set-text { min-width: 0; flex: 1; }
    .set-label { font-size: 13.5px; font-weight: 500; color: var(--text); }
    .set-desc { font-size: 12.5px; color: var(--muted); margin-top: 2px; line-height: 1.45; }
    .set-desc code, .set-row code { font-size: 12px; background: var(--bg-elevated); padding: 1px 5px; border-radius: 4px; }
    .set-control { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; max-width: 60%; }
    .set-row.wide .set-control { max-width: none; justify-content: flex-start; }
    .set-control select { width: auto; min-width: 190px; }
    .set-control input[type="text"], .set-control input:not([type]) { width: 240px; }
    .set-control input[type="number"] { width: 110px; }
    .set-value { font-family: var(--font-mono); font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
    .set-big { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .set-avatar { width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--brand); color: var(--on-accent); font-weight: 700; font-size: 17px; text-transform: uppercase; }
    .set-row pre { margin: 6px 0 0; padding: 10px 12px; background: var(--bg-input); border: 1px solid var(--card-border); border-radius: var(--radius-sm); font-size: 12px; overflow-x: auto; }
    .set-row table { font-size: 12.5px; }
    .set-empty { color: var(--muted); font-size: 12.5px; padding: 4px 0; }
    .lease { display: flex; align-items: center; gap: 12px; }
    .lease .set-text .set-label { display: flex; align-items: center; gap: 8px; }
    #settingsNoMatch { color: var(--muted); font-size: 13px; padding: 24px 0; }
    @media (max-width: 900px) {
      .settings-layout { grid-template-columns: 1fr; gap: 16px; }
      .settings-nav { position: static; }
      .settings-links { flex-direction: row; overflow-x: auto; }
      .settings-link { white-space: nowrap; }
      .set-row { flex-direction: column; align-items: stretch; gap: 10px; }
      .set-control { max-width: none; justify-content: flex-start; }
    }
  </style>`;

function settingsNav(active: SettingsSection): string {
  const links = SETTINGS_NAV.map((t) => {
    const cls = ["settings-link", t.adminOnly && t.key !== active ? "hidden" : ""].filter(Boolean).join(" ");
    const id = t.adminOnly ? ' id="settingsAdminTab" data-admin-only' : "";
    const current = t.key === active ? ' aria-current="page"' : "";
    return `<a class="${cls}" href="${t.href}"${id} data-section="${t.key}"${current}>${icon(t.icon, 16)}<span>${t.label}</span></a>`;
  }).join("");
  return `<aside class="settings-nav">
      <div class="settings-search">${icon("search", 14)}<input id="settingsSearch" type="search" placeholder="Search settings" aria-label="Search settings" autocomplete="off" /></div>
      <nav class="settings-links" aria-label="Settings sections">${links}</nav>
    </aside>`;
}

/** Admin link reveal, and the search box on pages without searchable rows (filters the links; Enter searches the account settings). */
const SETTINGS_SHELL_SCRIPT = `
    function revealSettingsAdminTab(me) {
      const user = (me && me.user) || {};
      const tab = document.getElementById("settingsAdminTab");
      if (tab && user.roles && user.roles.isSystemAdmin) tab.classList.remove("hidden");
    }
    (function() {
      const input = document.getElementById("settingsSearch");
      if (!input) return;
      input.addEventListener("input", () => {
        if (typeof window.onSettingsSearch === "function") return window.onSettingsSearch(input.value);
        const q = input.value.trim().toLowerCase();
        for (const a of document.querySelectorAll(".settings-link")) a.classList.toggle("dim", !!q && !a.textContent.toLowerCase().includes(q));
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && typeof window.onSettingsSearch !== "function" && input.value.trim()) location.href = "/portal/settings?q=" + encodeURIComponent(input.value.trim());
        if (e.key === "Escape") { input.value = ""; input.dispatchEvent(new Event("input")); }
      });
    })();
`;

/**
 * Helpers shared by the settings pages' scripts: number and date formatting, DOM building, and a
 * fetch wrapper that returns status and JSON instead of throwing.
 */
export const SETTINGS_HELPERS_SCRIPT = `
    const CLASS_LABELS = { cpu: "CPU", apple: "Apple", gpu: "GPU", "gpu.dc": "Datacenter GPU" };
    const classLabel = (c) => CLASS_LABELS[c] || c;
    const fmtNum = (n, d) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 2 : d });
    const fmtRate = (n) => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : Number(n).toPrecision(2));
    function fmtDate(ms) { return ms ? new Date(ms).toLocaleString() : "never"; }
    function timeLeft(endMs) {
      const min = Math.floor((endMs - Date.now()) / 60000);
      if (min < 1) return "ending";
      if (min < 60) return min + " min left";
      return Math.floor(min / 60) + " h" + (min % 60 ? " " + (min % 60) + " min" : "") + " left";
    }
    function el(tag, attrs, text) { const e = document.createElement(tag); for (const k in (attrs || {})) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; return e; }
    async function call(path, options) {
      const res = await fetch(path, { credentials: "include", headers: { "content-type": "application/json" }, ...(options || {}) });
      let json = {}; try { json = await res.json(); } catch {}
      return { ok: res.ok, status: res.status, json };
    }
`;

/** One settings section with a title and lead line. */
export function settingsSection(key: string, title: string, lead: string, body: string): string {
  return `<section class="set-section" id="sec-${key}" data-section="${key}"><h2 class="set-title">${title}</h2><p class="set-lead">${lead}</p>${body}</section>`;
}

export function settingsPage(section: SettingsSection, subtitle: string, content: string, script: string, opts: { wide?: boolean } = {}): string {
  return portalAuthedPageHtml({
    title: "EdgeCoder Portal | Settings",
    activeTab: "settings",
    heading: "Settings",
    subtitle,
    content: `${SETTINGS_CSS}<div class="settings-layout${opts.wide ? " wide" : ""}">${settingsNav(section)}<div class="settings-pane">${content}</div></div>`,
    script: SETTINGS_SHELL_SCRIPT + script
  });
}

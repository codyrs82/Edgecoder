// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { CSP_NONCE } from "../csp-nonce.js";
import { SETTINGS_HELPERS_SCRIPT, settingRow, settingsPage } from "./settings-shell.js";

/**
 * Settings > Social posts (/portal/settings/social), system admins only: the brand account's post
 * queue (src/portal/social.ts, src/social). The page shell carries no data; its script calls
 * /portal/api/admin/social*, which check the session is a system admin.
 *
 * - The switch: off (paused) stops all drafting and sending. Sending also needs
 *   SOCIAL_POSTING_ENABLED=1 on the portal; the page shows whether it is set, and whether X and
 *   Nostr are configured (never the values).
 * - Compose a draft by hand (release notes for iOS, anything else).
 * - The queue: edit, approve (sends at once when sending is on) or reject each draft. A draft that
 *   breaks a rule lists the problems and cannot be approved until it is edited.
 * - Recent: posted (with the X post and Nostr note links) and rejected.
 */
export function socialPageContent(): string {
  return `
    <style nonce="${CSP_NONCE}">
      .soc-post { border:1px solid var(--card-border); border-radius:var(--radius-md); background:var(--card); padding:12px; margin-bottom:10px; }
      .soc-post-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--muted); margin-bottom:8px; }
      .soc-post textarea, #socCompose { width:100%; min-height:96px; font-size:13px; line-height:1.45; resize:vertical; }
      .soc-meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px; font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
      .soc-meta .over { color:var(--danger-ink); font-weight:600; }
      .soc-problems { margin:6px 0 0; padding-left:18px; font-size:12.5px; color:var(--danger-ink); }
      .soc-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
      .soc-error { font-size:12.5px; color:var(--danger-ink); margin-top:6px; }
      .soc-empty { color:var(--muted); font-size:13px; padding:4px 0; }
      .soc-table { overflow-x:auto; }
      .soc-recent td { font-size:12.5px; vertical-align:top; }
      .soc-recent .txt { max-width:420px; white-space:pre-wrap; }
      .soc-recent a { color:var(--brand-2); }
    </style>
    <h2 class="set-title">Social posts</h2>
    <p class="set-lead">Posts for the EdgeCoder brand account on X, cross-posted to Nostr. Drafts come from live network data, new releases and new docs pages; every post needs your approval.</p>
    <div id="socDenied" class="callout warn hidden"><h3>Admin access required</h3><div class="muted">This section is only available to system administrators.</div></div>
    <div id="socError" class="callout warn hidden"></div>
    <div id="socBody" class="hidden">
      <div class="set-card">
        ${settingRow("Posting", 'Off pauses everything: no drafts are made and nothing is sent. Sending also needs <code>SOCIAL_POSTING_ENABLED=1</code> on the portal.', '<span class="set-value" id="socSwitchState">-</span><button type="button" id="socSwitch" class="primary">-</button>')}
        ${settingRow("Accounts", "Whether the credentials are set on the portal. Values are never shown.", '<span id="socChannels" class="muted"></span>')}
        ${settingRow("Draft now", "Run the drafting job now: weekly report, new releases (desktop and agent), new docs pages. Nothing runs while paused.", '<button type="button" id="socRun" class="btn-secondary">Draft now</button>')}
      </div>
      <div class="muted" id="socStatus" role="status"></div>
      <h3 class="set-group">Compose</h3>
      <div class="soc-post">
        <textarea id="socCompose" maxlength="2000" placeholder="Write a post (iOS release notes, announcements). Original posts only: no @mentions." aria-label="New post"></textarea>
        <div class="soc-meta" id="socComposeMeta"></div>
        <ul class="soc-problems" id="socComposeProblems"></ul>
        <div class="soc-actions"><button type="button" class="primary" id="socComposeBtn">Save draft</button></div>
      </div>
      <h3 class="set-group">Queue</h3>
      <div id="socQueue"></div>
      <h3 class="set-group">Recent</h3>
      <div class="set-card soc-recent"><div class="soc-table">
        <table><thead><tr><th>When</th><th>Status</th><th>Post</th><th>Links</th></tr></thead><tbody id="socRecent"></tbody></table>
      </div></div>
    </div>`;
}

export function socialPageScript(): string {
  return `
    ${SETTINGS_HELPERS_SCRIPT}
    const $ = (id) => document.getElementById(id);
    const KIND = { weekly: "Weekly report", release: "Release", docs: "Docs", manual: "Manual" };
    const TONE = { draft: "info", approved: "ok", posting: "warn", posted: "ok", rejected: "", failed: "danger" };
    let state = null;
    function badge(text, tone) { return el("span", { class: "status-badge " + (tone || "") }, text); }
    function setStatus(t) { $("socStatus").textContent = t || ""; }
    function showError(t) { const e = $("socError"); e.textContent = t; e.classList.remove("hidden"); }
    function meta(box, length, max) {
      box.textContent = "";
      box.appendChild(el("span", { class: length > max ? "over" : "" }, length + " / " + max + " (links count 23)"));
    }
    function problemsList(ul, problems) {
      ul.textContent = "";
      for (const p of problems || []) ul.appendChild(el("li", {}, p.message));
    }
    let checkTimer = null;
    function liveCheck(text, metaBox, ul) {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(async () => {
        if (!text.trim()) { metaBox.textContent = ""; ul.textContent = ""; return; }
        const r = await call("/portal/api/admin/social/check", { method: "POST", body: JSON.stringify({ text }) });
        if (!r.ok) return;
        meta(metaBox, r.json.length, r.json.maxLength);
        problemsList(ul, r.json.problems);
      }, 300);
    }
    function renderSwitch() {
      const on = state.settings.enabled;
      $("socSwitchState").textContent = on ? (state.sending.ok ? "On" : "On (not sending: " + state.sending.reason + ")") : "Paused";
      $("socSwitch").textContent = on ? "Pause" : "Turn on";
      $("socSwitch").className = on ? "btn-secondary" : "primary";
      const c = state.channels;
      $("socChannels").textContent = "X: " + (c.x.configured ? "configured" : "not configured") +
        " · Nostr: " + (c.nostr.configured ? "configured (" + c.nostr.relays.length + " relays)" : c.nostr.invalid ? "NOSTR_BRAND_NSEC is invalid (skipped)" : "not configured (skipped)") +
        " · SOCIAL_POSTING_ENABLED: " + (c.sendEnabledEnv ? "1" : "not set");
    }
    function renderPost(p) {
      const box = el("div", { class: "soc-post", "data-id": p.id });
      const head = el("div", { class: "soc-post-head" });
      head.appendChild(badge(p.status, TONE[p.status]));
      head.appendChild(el("span", {}, KIND[p.kind] || p.kind));
      head.appendChild(el("span", { class: "mono" }, p.sourceKey.startsWith("manual:") ? "manual" : p.sourceKey));
      head.appendChild(el("span", {}, "updated " + fmtDate(p.updatedAtMs)));
      if (p.approvedBy) head.appendChild(el("span", {}, "approved by " + p.approvedBy));
      box.appendChild(head);
      const editable = p.status === "draft" || p.status === "failed";
      const ta = el("textarea", { maxlength: "2000", "aria-label": "Post text" });
      ta.value = p.text;
      if (!editable) ta.setAttribute("readonly", "");
      box.appendChild(ta);
      const m = el("div", { class: "soc-meta" }); meta(m, p.length, p.maxLength); box.appendChild(m);
      const ul = el("ul", { class: "soc-problems" }); problemsList(ul, p.problems); box.appendChild(ul);
      if (p.error) box.appendChild(el("div", { class: "soc-error" }, p.error));
      ta.addEventListener("input", () => liveCheck(ta.value, m, ul));
      const actions = el("div", { class: "soc-actions" });
      if (editable) {
        const save = el("button", { type: "button", class: "btn-secondary" }, "Save edit");
        save.addEventListener("click", () => act(p.id, "edit", { text: ta.value }, save));
        const approve = el("button", { type: "button", class: "primary" }, p.status === "failed" ? "Approve again" : "Approve");
        approve.addEventListener("click", () => {
          if (!confirm(state.sending.ok ? "Approve and post this to X" + (state.channels.nostr.configured ? " and Nostr" : "") + " now?" : "Approve? It is sent once posting is on.")) return;
          act(p.id, "approve", ta.value !== p.text ? { text: ta.value } : {}, approve);
        });
        actions.appendChild(save); actions.appendChild(approve);
      }
      if (p.status === "draft" || p.status === "failed" || p.status === "approved") {
        const reject = el("button", { type: "button", class: "danger" }, "Reject");
        reject.addEventListener("click", () => act(p.id, "reject", {}, reject));
        actions.appendChild(reject);
      }
      box.appendChild(actions);
      return box;
    }
    function renderRecent() {
      const body = $("socRecent");
      body.textContent = "";
      for (const p of state.recent) {
        const tr = el("tr");
        tr.appendChild(el("td", { class: "nowrap" }, fmtDate(p.postedAtMs || p.updatedAtMs)));
        const st = el("td"); st.appendChild(badge(p.status, TONE[p.status])); tr.appendChild(st);
        tr.appendChild(el("td", { class: "txt" }, p.text));
        const links = el("td");
        if (p.xUrl) { const a = el("a", { href: p.xUrl, target: "_blank", rel: "noopener noreferrer" }, "X post"); links.appendChild(a); }
        if (p.nostrUrl) { links.appendChild(el("br")); const a = el("a", { href: p.nostrUrl, target: "_blank", rel: "noopener noreferrer", title: p.nostrNoteId }, "Nostr note"); links.appendChild(a); }
        if (p.nostrNote) links.appendChild(el("div", { class: "muted" }, "Nostr: " + p.nostrNote));
        tr.appendChild(links);
        body.appendChild(tr);
      }
      if (!state.recent.length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "4" }, "Nothing posted yet.")); body.appendChild(tr); }
    }
    function render() {
      $("socError").classList.add("hidden");
      $("socBody").classList.remove("hidden");
      renderSwitch();
      const q = $("socQueue");
      q.textContent = "";
      for (const p of state.queue) q.appendChild(renderPost(p));
      if (!state.queue.length) q.appendChild(el("div", { class: "soc-empty" }, "No drafts waiting."));
      renderRecent();
    }
    async function load() {
      const r = await call("/portal/api/admin/social", { method: "GET", headers: {} });
      if (r.status === 401 || r.status === 403) { $("socDenied").classList.remove("hidden"); return; }
      if (!r.ok) { showError("Could not load social posts: " + (r.json.error || r.status)); return; }
      state = r.json;
      render();
    }
    async function act(id, action, body, btn) {
      btn.disabled = true;
      try {
        const r = await call("/portal/api/admin/social/posts/" + encodeURIComponent(id) + "/" + action, { method: "POST", body: JSON.stringify(body) });
        if (r.ok) {
          const p = r.json.post || {};
          setStatus(r.json.note || (p.status === "posted" ? "Posted." : p.status === "failed" ? "Not posted: " + (p.error || "failed") : "Saved: " + p.status + "."));
        } else {
          setStatus("Not done: " + ((r.json.problems || []).map((x) => x.message).join(" ") || r.json.error || r.status));
        }
        await load();
      } finally {
        btn.disabled = false;
      }
    }
    $("socSwitch").addEventListener("click", async () => {
      const on = !state.settings.enabled;
      if (on && !confirm("Turn on brand posting? Drafting starts, and approved posts are sent when SOCIAL_POSTING_ENABLED=1.")) return;
      const r = await call("/portal/api/admin/social/settings", { method: "POST", body: JSON.stringify({ enabled: on }) });
      setStatus(r.ok ? (on ? "Posting is on." : "Posting is paused.") : "Could not change: " + (r.json.error || r.status));
      await load();
    });
    $("socRun").addEventListener("click", async () => {
      const btn = $("socRun"); btn.disabled = true; setStatus("Drafting...");
      try {
        const r = await call("/portal/api/admin/social/run", { method: "POST", body: "{}" });
        setStatus(!r.ok ? "Failed: " + (r.json.error || r.status) : r.json.skipped ? "Skipped: " + r.json.skipped + "." : r.json.drafted + " new draft(s), " + r.json.sent + " sent.");
        await load();
      } finally { btn.disabled = false; }
    });
    $("socCompose").addEventListener("input", () => liveCheck($("socCompose").value, $("socComposeMeta"), $("socComposeProblems")));
    $("socComposeBtn").addEventListener("click", async () => {
      const text = $("socCompose").value;
      if (!text.trim()) return;
      const r = await call("/portal/api/admin/social/drafts", { method: "POST", body: JSON.stringify({ text }) });
      if (r.ok) { $("socCompose").value = ""; $("socComposeMeta").textContent = ""; $("socComposeProblems").textContent = ""; setStatus("Draft saved."); }
      else setStatus("Not saved: " + (r.json.error || r.status));
      await load();
    });
    (async () => {
      const me = await requireAuth();
      revealSettingsAdminTab(me);
      const user = me.user || {};
      if (!(user.roles && user.roles.isSystemAdmin)) { $("socDenied").classList.remove("hidden"); return; }
      await load();
    })().catch((err) => showError("Could not load social posts: " + String(err.message || err)));
    `;
}

export function registerSettingsSocialPage(app: FastifyInstance): void {
  app.get("/portal/settings/social", async (_req, reply) => {
    return reply.type("text/html").send(settingsPage("social", "The brand account's posts.", socialPageContent(), socialPageScript()));
  });
}

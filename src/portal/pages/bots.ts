// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";
import { icon } from "./design-system.js";
import { CSP_NONCE } from "../csp-nonce.js";
import { CLIENT_MARKDOWN_CAP_JS } from "../../common/markdown-cap.js";

/**
 * Bots: the bots that live on your desktop machines, on the web (src/common/bot-relay.ts).
 *
 *   /portal/bots                  every bot on your machines (avatar, status, machine)
 *   /portal/bots?m=<agent>&b=<bot> one bot, laid out like the desktop's bot page: the header
 *                                 status, the conversation (the shared markdown cap), a slim
 *                                 composer, a details panel (routines, triggers, compute, budget,
 *                                 last run), Runs and Memory.
 *
 * The bots keep running on their Mac; everything here goes through /portal/api/bots (the owner's
 * session; the coordinator checks the machine's verified owner). When the Mac is offline the page
 * is read-only with the last conversation it published. Updates are polled (faster while the bot
 * works). Bot values reach innerHTML only through escapeHtml.
 */
export function registerBotsPage(app: FastifyInstance): void {
  app.get("/portal/bots", async (_req, reply) => {
    const icons = {
      send: icon("arrowRight", 16),
      refresh: icon("refresh", 14),
      pause: icon("pause", 14),
      play: icon("play", 14),
      edit: icon("edit", 14),
      panel: icon("panel", 16),
      stop: icon("x", 14),
      cpu: icon("cpu", 12),
      clock: icon("clock", 12),
      file: icon("file", 12),
      bot: icon("bot", 28),
    };
    const content = `
    <style nonce="${CSP_NONCE}">
      .shell { max-width:none !important; padding:0 !important; }
      .content-stack { padding:0 !important; }
      .bots-list-wrap { max-width:var(--content-max); margin:0 auto; padding:20px 24px 40px; }
      .bot-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px; }
      .bot-card { display:flex; gap:12px; align-items:flex-start; padding:14px; border:1px solid var(--card-border); border-radius:var(--radius-md); background:var(--card); color:var(--text); min-width:0; }
      .bot-card:hover, .bot-card:focus-visible { border-color:var(--border-strong); }
      .bot-card .bc-text { min-width:0; display:flex; flex-direction:column; gap:3px; }
      .bot-card .bc-name { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .bot-card .bc-sub, .bot-card .bc-line { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .bot-ava.lg { width:40px; height:40px; font-size:17px; }
      .bot-ava.md { width:32px; height:32px; font-size:14px; }
      .bot-ava.lg .bot-dot, .bot-ava.md .bot-dot { width:11px; height:11px; }
      .bots-empty { text-align:center; padding:56px 16px; color:var(--muted); }
      .bots-empty .empty-icon { width:52px; height:52px; margin:0 auto 12px; border-radius:var(--radius-md); border:1px solid var(--card-border); display:flex; align-items:center; justify-content:center; }
      .bots-empty h3 { color:var(--text-secondary); margin:0 0 8px; font-size:16px; }
      .bots-empty p { max-width:420px; margin:0 auto; font-size:13px; line-height:1.6; }

      /* ── One bot (the desktop's BotView layout) ── */
      .bot-view { display:flex; height:calc(100vh - var(--topbar-h)); min-height:0; }
      .bot-main { flex:1; min-width:0; display:flex; flex-direction:column; }
      .bot-head { display:flex; gap:12px; align-items:flex-start; padding:14px 20px; border-bottom:1px solid var(--card-border); }
      .bot-head .who { flex:1; min-width:0; }
      .bot-head .line1 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .bot-head h2 { font-size:16px; margin:0; }
      .bot-head .role { color:var(--muted); font-weight:500; }
      .bot-head .meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:12px; color:var(--muted); margin-top:4px; }
      .bot-head .meta .m { display:inline-flex; align-items:center; gap:4px; min-width:0; }
      .bot-head .where.offline { color:var(--yellow); }
      .bot-head .actions [hidden] { display:none; }
      .bot-head .actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
      .chip { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; border:1px solid var(--card-border); color:var(--text-secondary); }
      .chip.tone-accent { color:var(--brand-2); border-color:var(--brand-border); background:var(--brand-soft); }
      .chip.tone-warn { color:var(--yellow); border-color:color-mix(in srgb, var(--yellow) 40%, transparent); background:color-mix(in srgb, var(--yellow) 10%, transparent); }
      .chip.tone-err { color:var(--danger-ink); border-color:color-mix(in srgb, var(--danger) 40%, transparent); background:color-mix(in srgb, var(--danger) 10%, transparent); }
      .auto-status { font-size:12px; color:var(--muted); }
      .auto-status.tone-accent { color:var(--brand-2); } .auto-status.tone-warn { color:var(--yellow); } .auto-status.tone-err { color:var(--danger-ink); }
      .meter { display:inline-block; width:56px; height:5px; border-radius:3px; background:var(--bg-elevated); overflow:hidden; vertical-align:middle; }
      .meter > span { display:block; height:100%; width:0; background:var(--brand); }
      .bot-tabs { display:flex; gap:4px; padding:6px 20px 0; border-bottom:1px solid var(--card-border); }
      .bot-tabs [role="tab"], .d-tabs [role="tab"] { background:none; border:none; border-bottom:2px solid transparent; border-radius:0; padding:8px 10px; min-height:0; color:var(--text-secondary); font-size:13px; }
      .bot-tabs [role="tab"][aria-selected="true"], .d-tabs [role="tab"][aria-selected="true"] { color:var(--text); border-bottom-color:var(--brand); }
      .offline-note { margin:10px 20px 0; }
      .bot-scroll { flex:1; overflow-y:auto; min-height:0; }
      .bot-thread { max-width:820px; margin:0 auto; padding:12px 20px 20px; }
      .older-row { text-align:center; padding:6px 0 10px; }
      .msg { padding:12px 0; line-height:1.65; font-size:14px; }
      .msg + .msg { border-top:1px solid var(--card-border); }
      .msg .msg-head { display:flex; align-items:center; gap:8px; margin-bottom:4px; font-size:11px; color:var(--muted); }
      .msg .msg-who { font-weight:700; text-transform:uppercase; letter-spacing:0.4px; }
      .msg.user .msg-who { color:var(--brand-2); }
      .msg.event { font-size:12px; color:var(--muted); padding:6px 0; }
      .msg-body { overflow-wrap:anywhere; }
      .msg-body pre { background:var(--bg-input); padding:10px 12px; border-radius:var(--radius-sm); overflow-x:auto; border:1px solid var(--card-border); }
      .msg-body code { font-family:var(--font-mono); font-size:12.5px; }
      .msg-body :not(pre) > code { background:var(--bg-elevated); padding:1px 5px; border-radius:4px; }
      .steps { list-style:none; margin:6px 0 0; padding:0; display:flex; flex-direction:column; gap:3px; }
      .steps li { font-size:12px; color:var(--text-secondary); display:flex; gap:6px; min-width:0; }
      .steps .s-tool { font-family:var(--font-mono); color:var(--muted); flex:none; }
      .steps .s-detail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
      .steps .st-error, .steps .st-denied { color:var(--danger-ink); }
      .ask-card { margin:10px 0; padding:12px 14px; border:1px solid color-mix(in srgb, var(--yellow) 45%, transparent); border-radius:var(--radius-md); background:color-mix(in srgb, var(--yellow) 6%, var(--bg-surface)); }
      .ask-card .ask-q { font-weight:600; font-size:13px; margin-bottom:6px; }
      .ask-card code { display:block; font-family:var(--font-mono); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg-input); padding:6px 8px; border-radius:var(--radius-sm); }
      .ask-card .ask-choices { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center; }
      .ask-card .on-mac { font-size:12px; color:var(--muted); }
      .runs-table { width:100%; border-collapse:collapse; font-size:12.5px; }
      .runs-table th, .runs-table td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--card-border); vertical-align:top; }
      .runs-table th { color:var(--muted); font-weight:600; font-size:11px; }
      .runs-table .num { text-align:right; font-variant-numeric:tabular-nums; }
      .runs-table .sum { max-width:360px; overflow-wrap:anywhere; }
      .st-failed { color:var(--danger-ink); } .st-done { color:var(--ok); }
      .composer { border-top:1px solid var(--card-border); padding:10px 20px 14px; }
      .composer-pill {
        max-width:820px; margin:0 auto; display:flex; align-items:flex-end; gap:8px; padding:6px 6px 6px 16px;
        border:1px solid var(--card-border); border-radius:22px; background:var(--bg-input);
        transition:border-color var(--transition-fast), box-shadow var(--transition-fast);
      }
      .composer-pill:focus-within { border-color:var(--brand); box-shadow:0 0 0 3px var(--brand-soft); }
      .composer-pill textarea { flex:1; resize:none; border:none; background:transparent; color:var(--text); font:inherit; font-size:14px; line-height:1.5; padding:6px 0; min-height:0; max-height:40vh; outline:none; box-shadow:none; }
      .composer-pill .send { width:32px; height:32px; min-height:0; padding:0; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; }
      .composer .controls { max-width:820px; margin:6px auto 0; font-size:11.5px; color:var(--muted); display:flex; gap:10px; justify-content:space-between; }
      .details { width:320px; flex:none; border-left:1px solid var(--card-border); background:var(--bg-soft); overflow-y:auto; }
      .details[hidden] { display:none; }
      .d-who { display:flex; flex-direction:column; align-items:center; gap:6px; padding:18px 16px 10px; text-align:center; }
      .d-name { font-weight:600; }
      .d-role { font-size:12px; color:var(--muted); }
      .d-tabs { display:flex; gap:2px; padding:0 12px; border-bottom:1px solid var(--card-border); }
      .d-body { padding:6px 16px 20px; }
      .d-section { padding:10px 0; border-bottom:1px solid var(--card-border); }
      .d-section:last-child { border-bottom:none; }
      .d-label { font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.4px; margin-bottom:6px; }
      .d-row { display:flex; align-items:center; gap:6px; font-size:13px; }
      .d-sub { font-size:12px; color:var(--text-secondary); margin-top:3px; overflow-wrap:anywhere; }
      .d-sub.muted { color:var(--muted); }
      .routine { display:flex; gap:8px; align-items:flex-start; padding:4px 0; }
      .routine-text { flex:1; min-width:0; }
      .routine-title { font-size:13px; }
      .routine-sub { font-size:12px; color:var(--muted); }
      .switch { width:34px; height:20px; min-height:0; padding:0; border-radius:999px; background:var(--bg-elevated); border:1px solid var(--card-border); position:relative; flex:none; }
      .switch::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:var(--text-secondary); transition:transform var(--transition-fast); }
      .switch[aria-checked="true"] { background:var(--brand); border-color:var(--brand); }
      .switch[aria-checked="true"]::after { transform:translateX(14px); background:var(--on-accent); }
      .d-meter { height:6px; border-radius:3px; background:var(--bg-elevated); overflow:hidden; }
      .d-meter > span { display:block; height:100%; width:0; background:var(--brand); }
      pre.memory { white-space:pre-wrap; font-family:var(--font-mono); font-size:12px; background:var(--bg-input); padding:10px; border-radius:var(--radius-sm); max-height:50vh; overflow:auto; }
      dialog.bot-edit { width:min(560px, calc(100vw - 32px)); max-height:calc(100vh - 48px); border:1px solid var(--border-strong); border-radius:var(--radius-md); background:var(--bg-surface); color:var(--text); padding:0; }
      dialog.bot-edit::backdrop { background:var(--scrim); }
      .bot-edit form { padding:18px 20px; display:flex; flex-direction:column; gap:12px; }
      .bot-edit label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--text-secondary); }
      .bot-edit .row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .bot-edit textarea { min-height:90px; resize:vertical; }
      .bot-edit .trig { flex-direction:row; align-items:center; gap:8px; font-size:13px; color:var(--text); }
      .bot-edit .foot { display:flex; justify-content:flex-end; gap:8px; }
      .visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
      @media (max-width:1100px) {
        .details { position:fixed; right:0; top:var(--topbar-h); bottom:0; z-index:50; box-shadow:var(--shadow-2); width:min(340px, 92vw); }
      }
      @media (max-width:700px) {
        .bot-head { flex-wrap:wrap; padding:12px 14px; }
        .bot-head .actions { width:100%; justify-content:flex-start; }
        .bot-tabs, .composer { padding-left:14px; padding-right:14px; }
        .bot-thread { padding:10px 14px 16px; }
        .bots-list-wrap { padding:14px; }
        .bot-edit .row2 { grid-template-columns:1fr; }
        .runs-table .opt { display:none; }
      }
    </style>
    <section id="botList" aria-labelledby="botListHeading" hidden>
      <div class="bots-list-wrap">
        <h2 id="botListHeading" class="visually-hidden">Your bots</h2>
        <div id="botCards"><div class="loading-state"><span class="loading-spinner sm"></span> Loading your bots…</div></div>
      </div>
    </section>
    <section id="botPage" hidden>
      <div class="bot-view">
        <div class="bot-main">
          <header class="bot-head">
            <span id="bpAva"></span>
            <div class="who">
              <div class="line1"><h2 id="bpName"></h2><span class="chip" id="bpChip"></span></div>
              <div class="meta where" id="bpWhere"></div>
              <div class="meta" id="bpMeta"></div>
            </div>
            <div class="actions">
              <span class="auto-status" id="bpAuto" role="status" aria-live="polite"></span>
              <button type="button" class="sm" id="bpCheck">${icons.refresh}<span>Check now</span></button>
              <button type="button" class="sm" id="bpStop" hidden>${icons.stop}<span>Stop</span></button>
              <button type="button" class="sm" id="bpPause"></button>
              <button type="button" class="sm" id="bpEdit">${icons.edit}<span>Edit</span></button>
              <button type="button" class="sm ghost" id="bpPanel" aria-controls="bpDetails" aria-pressed="true" aria-label="Show details" title="Details">${icons.panel}</button>
            </div>
          </header>
          <div class="callout warn offline-note" id="bpOffline" role="status" hidden></div>
          <div class="bot-tabs" role="tablist" aria-label="Bot views">
            <button type="button" role="tab" id="tabChat" aria-controls="bpConv" aria-selected="true">Conversation</button>
            <button type="button" role="tab" id="tabRuns" aria-controls="bpRuns" aria-selected="false" tabindex="-1">Runs</button>
          </div>
          <div class="bot-scroll" id="bpScroll">
            <div class="bot-thread" id="bpConv" role="tabpanel" aria-labelledby="tabChat">
              <div class="older-row"><button type="button" class="sm ghost" id="bpOlder" hidden>Load earlier messages</button></div>
              <div id="bpMessages" aria-live="polite" aria-relevant="additions"></div>
            </div>
            <div class="bot-thread" id="bpRuns" role="tabpanel" aria-labelledby="tabRuns" hidden></div>
          </div>
          <div class="composer" id="bpComposer">
            <div class="composer-pill">
              <label for="bpInput" class="visually-hidden">Message the bot</label>
              <textarea id="bpInput" rows="1" placeholder="Message…" autocomplete="off"></textarea>
              <button type="button" class="primary send" id="bpSend" aria-label="Send">${icons.send}</button>
            </div>
            <div class="controls"><span id="bpComposerNote">Enter to send, Shift+Enter for a new line</span><span id="bpWorking"></span></div>
          </div>
        </div>
        <aside class="details" id="bpDetails" aria-label="Bot details">
          <div class="d-who"><span id="bpDAva"></span><div class="d-name" id="bpDName"></div><div class="d-role" id="bpDRole"></div><span class="chip" id="bpDChip"></span></div>
          <div class="d-tabs" role="tablist" aria-label="Details">
            <button type="button" role="tab" id="dTabDetails" aria-controls="bpDBody" aria-selected="true">Details</button>
            <button type="button" role="tab" id="dTabMemory" aria-controls="bpDBody" aria-selected="false" tabindex="-1">Memory</button>
          </div>
          <div class="d-body" id="bpDBody" role="tabpanel"></div>
        </aside>
      </div>
      <dialog class="bot-edit" id="bpEditDialog" aria-labelledby="bpEditTitle">
        <form id="bpEditForm" method="dialog">
          <h3 id="bpEditTitle" class="u-m-0">Edit bot</h3>
          <div class="row2">
            <label>Name<input name="name" maxlength="60" required /></label>
            <label>Role<input name="role" maxlength="80" /></label>
          </div>
          <label>Instructions<textarea name="instructions" maxlength="8000"></textarea></label>
          <div class="row2">
            <label>Schedule<select name="schedule" id="bpEditSchedule"></select></label>
            <label>Check-ins (no schedule)<select name="heartbeatMinutes" id="bpEditHeartbeat"></select></label>
          </div>
          <div class="row2">
            <label>Runs a day it starts on its own<input name="maxRunsPerDay" type="number" min="1" max="500" step="1" /></label>
            <label>Daily budget (cSats, empty = no limit)<input name="budgetCSatsPerDay" type="number" min="0" step="any" /></label>
          </div>
          <label>Compute<select name="computePolicy" id="bpEditCompute"></select></label>
          <fieldset class="u-m-0" id="bpEditTriggers"><legend class="u-fs-12">GitHub triggers</legend></fieldset>
          <p class="muted u-fs-12 u-m-0">Its folder, repository, tools and auto-approval are changed on the Mac.</p>
          <div id="bpEditError" class="callout danger u-m-0" role="alert" hidden></div>
          <div class="foot"><button type="button" id="bpEditCancel">Cancel</button><button type="submit" class="primary" id="bpEditSave">Save</button></div>
        </form>
      </dialog>
    </section>
    `;
    const script = `
    ${CLIENT_MARKDOWN_CAP_JS}
    var BOT_ICONS = ${JSON.stringify(icons)};
    ${BOTS_PAGE_JS}
    `;
    return reply.type("text/html").send(
      portalAuthedPageHtml({
        title: "EdgeCoder | Bots",
        activeTab: "bots",
        heading: "Bots",
        subtitle: "The bots on your desktop machines",
        content,
        script,
      }),
    );
  });
}

/** The page's script (plain JS; String.raw keeps its backslashes). */
const BOTS_PAGE_JS = String.raw`
    var params = new URLSearchParams(location.search);
    var agentId = params.get("m"), botId = params.get("b");
    var state = { bot: null, machine: null, older: [], more: null, tab: "chat", dtab: "details", runs: null, memory: null, busy: false, lastSig: "", loaded: false };

    /* Chat markdown: escaped first, then code blocks, inline code, bold, italics; capped like the desktop (issue 333). */
    function renderMarkdown(text) {
      var html = escapeHtml(capMarkdownSource(text));
      html = html.replace(/&#96;&#96;&#96;[^\n]*\n?([\s\S]*?)&#96;&#96;&#96;/g, function(_m, code) { return "<pre><code>" + code.replace(/\n$/, "") + "</code></pre>"; });
      html = html.replace(/&#96;([^&\n]|&(?!#96;))+?&#96;/g, function(m) { return "<code>" + m.slice(5, -5) + "</code>"; });
      html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return html.split(/(<pre>[\s\S]*?<\/pre>)/).map(function(part) { return part.indexOf("<pre>") === 0 ? part : part.replace(/^\n+|\n+$/g, "").replace(/\n/g, "<br>"); }).join("");
    }
    function when(ms) { return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }

    /* Commands go to the bot's Mac through the coordinator; the answer is polled. */
    async function command(action, args) {
      var r = await api("/portal/api/bots/" + encodeURIComponent(agentId) + "/" + encodeURIComponent(botId) + "/commands", { method: "POST", body: JSON.stringify({ action: action, args: args || {} }) });
      var id = r.commandId, end = Date.now() + 25000, wait = 400;
      while (Date.now() < end) {
        await new Promise(function(res) { setTimeout(res, wait); });
        wait = Math.min(1500, wait + 200);
        var s = await api("/portal/api/bots/" + encodeURIComponent(agentId) + "/commands/" + encodeURIComponent(id), { method: "GET", headers: {} }).catch(function() { return null; });
        if (!s) continue;
        if (s.status === "expired") throw new Error("Your Mac didn't answer. Is the EdgeCoder app running?");
        if (s.result) {
          if (s.result.status !== "done") throw new Error(s.result.message || s.result.error || "Refused");
          return s.result.data;
        }
      }
      throw new Error("Your Mac didn't answer in time.");
    }
    function commandError(err) {
      var m = String((err && err.message) || err);
      var words = { agent_not_connected: "Your Mac is offline.", not_your_machine: "That bot isn't on one of your machines.", rate_limited: "Too many changes at once; try again in a minute.", view_only: "This Mac shows its bots read-only." };
      showToast(words[m] || m, true);
    }

    /* ── The list ── */
    async function showList() {
      document.getElementById("botList").hidden = false;
      var box = document.getElementById("botCards");
      try {
        var res = await api("/portal/api/bots", { method: "GET", headers: {} });
        var bots = res.bots || [];
        if (!bots.length) {
          box.innerHTML = '<div class="bots-empty"><div class="empty-icon">' + BOT_ICONS.bot + '</div><h3>No bots yet</h3><p>Bots live on your desktop: create one in the EdgeCoder app on a machine you enrolled, and it shows here. It keeps running on that machine, with its folder and tools; from here you can message it, pause it and change its settings.</p></div>';
          return;
        }
        box.innerHTML = '<div class="bot-cards">' + bots.map(function(b) {
          var online = b.machine.online;
          var line = online ? botAutoStatus(b).text : "Offline · last seen " + (b.machine.reportedAtMs ? botRelative(b.machine.reportedAtMs) : "a while ago");
          return '<a class="bot-card" href="' + botHref(b.machine.agentId, b.id) + '">' + botAvatarHtml(b, online, "lg") +
            '<span class="bc-text"><span class="bc-name">' + escapeHtml(botTitle(b)) + '</span><span class="bc-sub">on ' + escapeHtml(b.machine.machineName) + (online ? "" : " · offline") + '</span><span class="bc-line">' + escapeHtml(line) + "</span></span></a>";
        }).join("") + "</div>";
        paintBotAvatars(box);
      } catch (err) {
        box.innerHTML = '<div class="callout danger" role="alert">Couldn\'t load your bots. ' + escapeHtml(err.message || "") + "</div>";
      }
    }

    /* ── One bot ── */
    function online() { return !!(state.machine && state.machine.online); }
    function canControl() { return online() && state.machine.controls === "on"; }

    function renderHeader() {
      var b = state.bot, m = state.machine, chip = botStatusChip(b), auto = botAutoStatus(b);
      document.title = "EdgeCoder | " + b.name;
      document.getElementById("bpAva").innerHTML = botAvatarHtml(b, online(), "lg");
      document.getElementById("bpName").innerHTML = escapeHtml(b.name) + (b.role ? '<span class="role"> · ' + escapeHtml(b.role) + "</span>" : "");
      var chipEl = document.getElementById("bpChip");
      chipEl.textContent = online() ? chip.text : "Offline";
      chipEl.className = "chip " + (online() ? "tone-" + chip.tone : "");
      var where = document.getElementById("bpWhere");
      where.textContent = "on " + m.machineName + (online() ? "" : " · offline" + (m.reportedAtMs ? " · last seen " + botRelative(m.reportedAtMs) : ""));
      where.classList.toggle("offline", !online());
      var pct = b.budgetCSatsPerDay ? Math.min(100, (b.spentTodayCSats / b.budgetCSatsPerDay) * 100) : 0;
      document.getElementById("bpMeta").innerHTML =
        '<span class="m" title="Routine">' + BOT_ICONS.clock + escapeHtml(botRoutineText(b) + (!b.enabled && (b.schedule || botChecksIn(b)) ? " · paused" : "")) + "</span><span aria-hidden=\"true\">·</span>" +
        '<span class="m" title="cSats spent today against the daily budget">' + (b.budgetCSatsPerDay != null ? '<span class="meter" role="meter" aria-label="Daily budget used" aria-valuemin="0" aria-valuemax="' + escapeHtml(b.budgetCSatsPerDay) + '" aria-valuenow="' + escapeHtml(b.spentTodayCSats) + '"><span id="bpMeterFill"></span></span> ' + escapeHtml(botCSats(b.spentTodayCSats) + " / " + botCSats(b.budgetCSatsPerDay)) : escapeHtml(botCSats(b.spentTodayCSats) + " cSats · no limit")) + "</span><span aria-hidden=\"true\">·</span>" +
        '<span class="m" title="Compute: where its model calls run">' + BOT_ICONS.cpu + escapeHtml(botComputeText(b.compute)) + "</span><span aria-hidden=\"true\">·</span>" +
        '<span class="m" title="Its folder on the Mac">' + BOT_ICONS.file + escapeHtml(b.repository || b.folderName) + "</span>";
      var fill = document.getElementById("bpMeterFill");
      if (fill) fill.style.width = pct + "%";
      var autoEl = document.getElementById("bpAuto");
      autoEl.textContent = online() ? auto.text : "";
      autoEl.className = "auto-status tone-" + auto.tone;
      var ctl = canControl(), busy = b.status === "running" || b.status === "needs_approval";
      var pause = document.getElementById("bpPause");
      pause.innerHTML = (b.enabled ? BOT_ICONS.pause + "<span>Pause</span>" : BOT_ICONS.play + "<span>Resume</span>");
      pause.setAttribute("aria-label", b.enabled ? "Pause " + b.name : "Resume " + b.name);
      // Read-only (offline, or a view-only Mac): no controls at all, rather than dead buttons.
      ["bpCheck", "bpPause", "bpEdit", "bpStop"].forEach(function(id) { var el = document.getElementById(id); el.disabled = state.busy; el.hidden = !ctl; });
      if (ctl) { document.getElementById("bpCheck").hidden = busy; document.getElementById("bpStop").hidden = !busy; }
      var note = document.getElementById("bpOffline");
      if (!online()) {
        note.hidden = false;
        note.textContent = b.name + " · on " + m.machineName + " · offline. This is the last conversation it shared; it carries on when the Mac is back.";
      } else if (m.controls !== "on") {
        note.hidden = false;
        note.textContent = m.machineName + " shows its bots on the web read-only. Message, approve and change it on the Mac.";
      } else note.hidden = true;
      var input = document.getElementById("bpInput"), send = document.getElementById("bpSend");
      input.disabled = !ctl; send.disabled = !ctl;
      input.placeholder = ctl ? "Message " + b.name + "…" : online() ? "Read-only: message it on the Mac" : "Offline: message it when the Mac is back";
      setText("bpWorking", busy && online() ? botAutoStatus(b).text : "");
      // The details panel header.
      document.getElementById("bpDAva").innerHTML = botAvatarHtml(b, online(), "md");
      setText("bpDName", b.name);
      setText("bpDRole", b.role || "");
      var dchip = document.getElementById("bpDChip");
      dchip.textContent = online() ? chip.text : "Offline";
      dchip.className = "chip " + (online() ? "tone-" + chip.tone : "");
      paintBotAvatars(document.getElementById("botPage"));
    }

    function stepsHtml(steps) {
      if (!steps || !steps.length) return "";
      return '<ul class="steps" aria-label="Steps">' + steps.map(function(s) {
        var mark = s.status === "ok" ? "✓" : s.status === "error" ? "✗" : s.status === "denied" ? "denied" : s.status === "pending" ? "waiting" : "…";
        return '<li class="st-' + escapeHtml(s.status) + '"><span class="s-tool">' + escapeHtml(s.tool) + '</span><span class="s-detail" title="' + escapeHtml(s.detail) + '">' + escapeHtml(s.detail) + '</span><span class="s-mark">' + escapeHtml(mark) + "</span></li>";
      }).join("") + "</ul>";
    }
    function askCardsHtml() {
      var b = state.bot;
      if (!b.pending || !b.pending.length) return "";
      return b.pending.map(function(p) {
        var q = p.tool === "run_shell" ? "Run this command?" : p.tool === "git_commit" ? "Commit?" : p.tool === "git_push" ? "Push?" : p.tool === "open_pull_request" ? "Open this pull request?" : "Allow " + p.tool.replace(/_/g, " ") + "?";
        var choices = canControl()
          ? '<button type="button" class="primary sm" data-approve="' + escapeHtml(p.callId) + '">Approve</button><button type="button" class="sm danger" data-deny="' + escapeHtml(p.callId) + '">Deny</button>'
          : '<span class="on-mac">Approve on your Mac' + (online() ? "" : " (it's offline)") + "</span>";
        return '<div class="ask-card" role="group" aria-label="' + escapeHtml(b.name + " asks: " + q) + '"><div class="ask-q">' + escapeHtml(b.name + " asks: " + q) + "</div>" + (p.detail ? "<code>" + escapeHtml(p.detail) + "</code>" : "") + '<div class="ask-choices">' + choices + "</div></div>";
      }).join("");
    }
    function messageHtml(m) {
      if (m.role === "event") return '<div class="msg event">' + escapeHtml(m.content) + " · " + escapeHtml(when(m.atMs)) + "</div>";
      var who = m.role === "user" ? "You" : state.bot.name;
      return '<article class="msg ' + escapeHtml(m.role) + '"><div class="msg-head"><span class="msg-who">' + escapeHtml(who) + "</span><time>" + escapeHtml(when(m.atMs)) + '</time></div><div class="msg-body">' + renderMarkdown(m.content || "") + "</div>" + stepsHtml(m.steps) + "</article>";
    }
    function renderConversation() {
      var b = state.bot, tail = b.tail || [];
      var firstTail = tail.length ? tail[0].atMs : Infinity;
      var older = state.older.filter(function(m) { return m.atMs < firstTail; });
      var all = older.concat(tail);
      var sig = all.length + "|" + all.map(function(m) { return m.id + ":" + (m.content || "").length + ":" + ((m.steps || []).length); }).join(",") + "|" + JSON.stringify(b.pending || []) + "|" + canControl();
      var olderBtn = document.getElementById("bpOlder");
      var hasMore = state.more !== null ? state.more : (b.messageCount || 0) > tail.length;
      olderBtn.hidden = !hasMore;
      olderBtn.disabled = !online();
      olderBtn.textContent = online() ? "Load earlier messages" : "Earlier messages stay on the Mac";
      if (sig === state.lastSig) return;
      state.lastSig = sig;
      var scroll = document.getElementById("bpScroll");
      var atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
      var box = document.getElementById("bpMessages");
      box.innerHTML = all.length
        ? all.map(messageHtml).join("") + askCardsHtml()
        : '<div class="bots-empty"><p>' + escapeHtml(b.lastRun ? "No messages yet. Its last run: " + (b.lastRun.summary || BOT_RUN_STATUS_TEXT[b.lastRun.status] || b.lastRun.status) : "No messages yet. Message " + b.name + " to get it started.") + "</p></div>" + askCardsHtml();
      if (atBottom || !state.loaded) scroll.scrollTop = scroll.scrollHeight;
      state.loaded = true;
    }
    async function loadOlder() {
      var b = state.bot, first = (state.older[0] || (b.tail || [])[0]);
      var btn = document.getElementById("bpOlder");
      btn.disabled = true;
      try {
        var data = await command("messages", { beforeMs: first ? first.atMs : undefined, limit: 30 });
        var scroll = document.getElementById("bpScroll"), before = scroll.scrollHeight;
        state.older = (data.items || []).concat(state.older);
        state.more = !!data.more;
        state.lastSig = "";
        renderConversation();
        scroll.scrollTop = scroll.scrollHeight - before;
      } catch (err) { commandError(err); }
      btn.disabled = !online();
    }

    function renderRuns() {
      var box = document.getElementById("bpRuns"), b = state.bot;
      var runs = state.runs || (b.lastRun ? [b.lastRun] : []);
      if (!runs.length) { box.innerHTML = '<div class="bots-empty"><p>No runs yet.</p></div>'; return; }
      box.innerHTML = (state.runs ? "" : '<p class="muted u-fs-12">' + escapeHtml(online() ? "Loading the run history…" : "The last run; the full history stays on the Mac while it's offline.") + "</p>") +
        '<table class="runs-table"><caption class="visually-hidden">Runs</caption><thead><tr><th scope="col">Started</th><th scope="col">Trigger</th><th scope="col">Status</th><th scope="col">Summary</th><th scope="col" class="num">cSats</th><th scope="col" class="opt">Ran on</th></tr></thead><tbody>' +
        runs.map(function(r) {
          var prs = (r.pullRequests || []).map(function(p) { return /^https:\/\//.test(p.url) ? ' <a href="' + escapeHtml(p.url) + '" target="_blank" rel="noreferrer noopener">PR #' + escapeHtml(p.number || "") + "</a>" : ""; }).join("");
          return "<tr><td>" + escapeHtml(when(r.startedAtMs)) + "</td><td>" + escapeHtml(r.source || r.trigger) + '</td><td class="st-' + escapeHtml(r.status) + '">' + escapeHtml(BOT_RUN_STATUS_TEXT[r.status] || r.status) + '</td><td class="sum">' + escapeHtml(r.summary || r.error || "") + prs + '</td><td class="num">' + escapeHtml(botCSats(r.cSats)) + '</td><td class="opt">' + escapeHtml(r.where || "—") + (r.note ? '<div class="muted u-fs-12">' + escapeHtml(r.note) + "</div>" : "") + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
    async function loadRuns() {
      if (!online()) { renderRuns(); return; }
      renderRuns();
      try { var data = await command("history"); state.runs = (data.items || []).slice().reverse(); } catch (err) { commandError(err); }
      renderRuns();
    }

    function renderDetails() {
      var b = state.bot, body = document.getElementById("bpDBody"), ctl = canControl();
      if (state.dtab === "memory") {
        body.innerHTML = '<div class="d-section"><div class="d-label">Notes it saved for itself</div>' +
          (state.memory === null ? '<div class="d-sub muted">' + (online() ? "Loading…" : "Its memory stays on the Mac while it's offline.") + "</div>"
            : state.memory.trim() ? '<pre class="memory" tabindex="0" aria-label="Bot memory">' + escapeHtml(state.memory) + "</pre>"
            : '<div class="d-sub muted">Nothing yet. It saves notes with its remember tool as it works.</div>') + "</div>";
        return;
      }
      var routine = String(b.schedule || "").trim()
        ? '<div class="routine"><div class="routine-text"><div class="routine-title">' + escapeHtml(botScheduleText(b.schedule)) + '</div><div class="routine-sub">' + escapeHtml(b.enabled ? (b.nextRun ? "Next run " + botRelative(b.nextRun.atMs) : "On") : "Paused: answers messages only") + '</div></div><button type="button" class="switch" role="switch" data-toggle-pause aria-checked="' + (b.enabled ? "true" : "false") + '" aria-label="' + escapeHtml("Run " + botScheduleText(b.schedule).toLowerCase()) + '"' + (ctl ? "" : " disabled") + "></button></div>"
        : botChecksIn(b)
          ? '<div class="routine"><div class="routine-text"><div class="routine-title">' + escapeHtml(botRoutineText(b)) + '</div><div class="routine-sub">' + escapeHtml(b.enabled ? botAutoStatus(b).text + ((b.idleStreak || 0) > 0 ? " · waiting longer while nothing changes" : "") : "Paused: answers messages only") + '</div></div><button type="button" class="switch" role="switch" data-toggle-pause aria-checked="' + (b.enabled ? "true" : "false") + '" aria-label="' + escapeHtml(botRoutineText(b)) + '"' + (ctl ? "" : " disabled") + "></button></div>"
          : '<div class="routine-sub">No routine: give it a role or instructions and it checks in on its own, or add a schedule.</div>';
      var triggers = (b.triggers || []).length
        ? b.triggers.map(function(t) {
            var st = (b.triggerStatus || {})[t.id] || {};
            var sub = !t.enabled ? "Off" : !b.enabled ? "Paused with the bot" : st.error ? st.error : st.lastCheckedAtMs ? "Checked " + botRelative(st.lastCheckedAtMs) : "Checks GitHub every 2 minutes";
            return '<div class="routine"><div class="routine-text"><div class="routine-title">' + escapeHtml(botTriggerText(t)) + '</div><div class="routine-sub">' + escapeHtml(sub) + '</div></div><button type="button" class="switch" role="switch" data-toggle-trigger="' + escapeHtml(t.id) + '" aria-checked="' + (t.enabled ? "true" : "false") + '" aria-label="' + escapeHtml("Trigger: " + botTriggerText(t)) + '"' + (ctl ? "" : " disabled") + "></button></div>";
          }).join("")
        : '<div class="routine-sub">' + (b.repository ? "No triggers: add one on the Mac to run on PRs, CI failures or labeled issues." : "Set a repository on the Mac to run on GitHub events.") + "</div>";
      var pct = b.budgetCSatsPerDay ? Math.min(100, (b.spentTodayCSats / b.budgetCSatsPerDay) * 100) : 0;
      var lr = b.lastRun;
      body.innerHTML =
        '<div class="d-section"><div class="d-label">Routines</div>' + routine + "</div>" +
        '<div class="d-section"><div class="d-label">Triggers</div>' + triggers + "</div>" +
        (b.repository ? '<div class="d-section"><div class="d-label">Repository</div><div class="d-row">' + escapeHtml(b.repository) + "</div>" + (b.repo ? '<div class="d-sub' + (b.repo.state === "error" ? "" : " muted") + '">' + escapeHtml(b.repo.message) + "</div>" : "") + "</div>" : "") +
        '<div class="d-section"><div class="d-label">Compute</div><div class="d-row">' + BOT_ICONS.cpu + escapeHtml(botComputeText(b.compute)) + "</div></div>" +
        '<div class="d-section"><div class="d-label">Budget today</div>' + (b.budgetCSatsPerDay != null
          ? '<div class="d-meter" role="meter" aria-label="Daily budget used" aria-valuemin="0" aria-valuemax="' + escapeHtml(b.budgetCSatsPerDay) + '" aria-valuenow="' + escapeHtml(b.spentTodayCSats) + '"><span id="bpDMeterFill"></span></div><div class="d-sub">' + escapeHtml(botCSats(b.spentTodayCSats) + " of " + botCSats(b.budgetCSatsPerDay) + " cSats") + "</div>"
          : '<div class="d-sub">' + escapeHtml(botCSats(b.spentTodayCSats) + " cSats · no limit") + "</div>") +
        '<div class="d-sub muted">' + escapeHtml(b.runsToday + " of " + b.maxRunsPerDay + " runs it may start on its own today") + "</div></div>" +
        (lr ? '<div class="d-section"><div class="d-label">Last run</div><div class="d-sub">' + escapeHtml((BOT_RUN_STATUS_TEXT[lr.status] || lr.status) + " · " + botRelative(lr.startedAtMs) + (lr.where ? " · " + lr.where : "")) + "</div>" + (lr.summary ? '<div class="d-sub muted">' + escapeHtml(lr.summary) + "</div>" : "") + (lr.note ? '<div class="d-sub muted">' + escapeHtml(lr.note) + "</div>" : "") + "</div>" : "") +
        '<div class="d-section"><div class="d-label">Where it runs</div><div class="d-sub">' + escapeHtml("On " + state.machine.machineName + ", in its folder " + b.folderName + ".") + "</div></div>";
      var fill = document.getElementById("bpDMeterFill");
      if (fill) fill.style.width = pct + "%";
    }
    async function loadMemory() {
      if (!online()) { renderDetails(); return; }
      try { var data = await command("memory"); state.memory = String((data && data.memory) || ""); } catch (err) { state.memory = ""; commandError(err); }
      renderDetails();
    }

    function render() {
      renderHeader();
      renderConversation();
      if (state.tab === "runs") renderRuns();
      renderDetails();
    }

    async function refresh() {
      try {
        var res = await api("/portal/api/bots/" + encodeURIComponent(agentId) + "/" + encodeURIComponent(botId), { method: "GET", headers: {} });
        var prev = state.bot;
        state.bot = res.bot;
        state.machine = res.machine;
        // A run ended or started: the run history may have changed.
        if (prev && prev.lastRun && res.bot.lastRun && (prev.lastRun.id !== res.bot.lastRun.id || prev.lastRun.status !== res.bot.lastRun.status) && state.tab === "runs") void loadRuns();
        render();
      } catch (err) {
        if (!state.bot) {
          document.getElementById("botPage").hidden = true;
          var list = document.getElementById("botList");
          list.hidden = false;
          document.getElementById("botCards").innerHTML = '<div class="callout warn" role="alert">' + (String(err.message) === "no_such_bot" ? "That bot isn't on any of your machines (or its machine hasn't shared it yet)." : "Couldn't load that bot: " + escapeHtml(err.message || "")) + ' <a href="/portal/bots">All bots</a></div>';
        }
      }
    }
    function schedule() {
      var b = state.bot;
      var fast = b && (b.status === "running" || b.status === "needs_approval" || b.queuedMessages > 0);
      setTimeout(function() { (document.hidden ? Promise.resolve() : refresh()).then(schedule); }, fast ? 2500 : 8000);
    }

    async function act(label, action, args) {
      if (state.busy) return;
      state.busy = true;
      renderHeader();
      try { await command(action, args); if (label) showToast(label); } catch (err) { commandError(err); }
      state.busy = false;
      await refresh();
    }

    function selectTab(which) {
      state.tab = which;
      var chat = document.getElementById("tabChat"), runs = document.getElementById("tabRuns");
      chat.setAttribute("aria-selected", which === "chat" ? "true" : "false");
      runs.setAttribute("aria-selected", which === "runs" ? "true" : "false");
      chat.tabIndex = which === "chat" ? 0 : -1;
      runs.tabIndex = which === "runs" ? 0 : -1;
      document.getElementById("bpConv").hidden = which !== "chat";
      document.getElementById("bpRuns").hidden = which !== "runs";
      document.getElementById("bpComposer").hidden = which !== "chat";
      if (which === "runs") void loadRuns();
    }
    function selectDTab(which) {
      state.dtab = which;
      var d = document.getElementById("dTabDetails"), m = document.getElementById("dTabMemory");
      d.setAttribute("aria-selected", which === "details" ? "true" : "false");
      m.setAttribute("aria-selected", which === "memory" ? "true" : "false");
      d.tabIndex = which === "details" ? 0 : -1;
      m.tabIndex = which === "memory" ? 0 : -1;
      document.getElementById("bpDBody").setAttribute("aria-labelledby", which === "details" ? "dTabDetails" : "dTabMemory");
      renderDetails();
      if (which === "memory") void loadMemory();
    }
    function tabKeys(a, b, select) {
      [a, b].forEach(function(el) {
        el.addEventListener("keydown", function(e) {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); var other = el === a ? b : a; other.focus(); other.click(); }
        });
      });
    }

    /* ── Edit settings: the desktop form's fields that may change from the web ── */
    function openEdit() {
      var b = state.bot, f = document.getElementById("bpEditForm");
      f.name.value = b.name; f.role.value = b.role || ""; f.instructions.value = b.instructions || "";
      var sched = document.getElementById("bpEditSchedule"), presets = BOT_SCHEDULE_PRESETS.slice();
      if (b.schedule && !presets.some(function(p) { return p[0] === b.schedule; })) presets.push([b.schedule, botScheduleText(b.schedule)]);
      sched.innerHTML = presets.map(function(p) { return '<option value="' + escapeHtml(p[0]) + '"' + (p[0] === (b.schedule || "") ? " selected" : "") + ">" + escapeHtml(p[1]) + "</option>"; }).join("");
      var hb = document.getElementById("bpEditHeartbeat"), hbv = b.heartbeatMinutes == null ? "" : String(b.heartbeatMinutes), opts = BOT_HEARTBEAT_OPTIONS.slice();
      if (!opts.some(function(o) { return o[0] === hbv; })) opts.push([hbv, "Every " + hbv + " minutes"]);
      hb.innerHTML = opts.map(function(o) { return '<option value="' + escapeHtml(o[0]) + '"' + (o[0] === hbv ? " selected" : "") + ">" + escapeHtml(o[1]) + "</option>"; }).join("");
      f.maxRunsPerDay.value = b.maxRunsPerDay;
      f.budgetCSatsPerDay.value = b.budgetCSatsPerDay == null ? "" : b.budgetCSatsPerDay;
      var cp = document.getElementById("bpEditCompute");
      cp.innerHTML = BOT_COMPUTE_OPTIONS.filter(function(o) { return o[0] !== "model" || b.compute.policy === "model"; }).map(function(o) { return '<option value="' + escapeHtml(o[0]) + '"' + (o[0] === b.compute.policy ? " selected" : "") + ">" + escapeHtml(o[0] === "model" ? botComputeText(b.compute) : o[1]) + "</option>"; }).join("");
      var tr = document.getElementById("bpEditTriggers");
      tr.hidden = !(b.triggers || []).length;
      tr.innerHTML = '<legend class="u-fs-12">GitHub triggers</legend>' + (b.triggers || []).map(function(t) { return '<label class="trig"><input type="checkbox" data-trigger="' + escapeHtml(t.id) + '"' + (t.enabled ? " checked" : "") + " />" + escapeHtml(botTriggerText(t)) + "</label>"; }).join("");
      document.getElementById("bpEditError").hidden = true;
      document.getElementById("bpEditDialog").showModal();
      f.name.focus();
    }
    async function saveEdit(e) {
      e.preventDefault();
      var b = state.bot, f = document.getElementById("bpEditForm"), patch = {};
      if (f.name.value.trim() !== b.name) patch.name = f.name.value.trim();
      if (f.role.value !== (b.role || "")) patch.role = f.role.value;
      if (f.instructions.value !== (b.instructions || "")) patch.instructions = f.instructions.value;
      if (f.schedule.value !== (b.schedule || "")) patch.schedule = f.schedule.value;
      var hb = f.heartbeatMinutes.value === "" ? null : Number(f.heartbeatMinutes.value);
      if (hb !== b.heartbeatMinutes) patch.heartbeatMinutes = hb;
      var mr = Number(f.maxRunsPerDay.value);
      if (mr !== b.maxRunsPerDay) patch.maxRunsPerDay = mr;
      var bud = f.budgetCSatsPerDay.value === "" ? null : Number(f.budgetCSatsPerDay.value);
      if (bud !== b.budgetCSatsPerDay) patch.budgetCSatsPerDay = bud;
      if (f.computePolicy.value !== b.compute.policy) patch.compute = { policy: f.computePolicy.value };
      var tchanged = false, triggers = (b.triggers || []).map(function(t) {
        var box = f.querySelector('[data-trigger="' + CSS.escape(t.id) + '"]');
        var on = box ? box.checked : t.enabled;
        if (on !== t.enabled) tchanged = true;
        var out = { id: t.id, kind: t.kind, enabled: on };
        if (t.label) out.label = t.label; if (t.scope) out.scope = t.scope; if (t.onlyOthers !== undefined) out.onlyOthers = t.onlyOthers;
        return out;
      });
      if (tchanged) patch.triggers = triggers;
      if (!Object.keys(patch).length) { document.getElementById("bpEditDialog").close(); return; }
      var save = document.getElementById("bpEditSave");
      save.disabled = true;
      try {
        await command("update_settings", patch);
        document.getElementById("bpEditDialog").close();
        showToast("Saved on " + state.machine.machineName);
        await refresh();
      } catch (err) {
        var box = document.getElementById("bpEditError");
        box.hidden = false;
        box.textContent = String(err.message || err);
      }
      save.disabled = false;
    }

    async function sendMessage() {
      var input = document.getElementById("bpInput"), text = input.value.trim();
      if (!text || !canControl()) return;
      input.value = "";
      grow();
      // Shown right away; the Mac's conversation replaces it on the next refresh.
      state.bot.tail = (state.bot.tail || []).concat([{ id: "local-" + Date.now(), role: "user", content: text, atMs: Date.now() }]);
      renderConversation();
      try {
        var r = await command("message", { content: text });
        if (r && r.queued) showToast(state.bot.name + " will answer when this run ends");
      } catch (err) { commandError(err); input.value = text; grow(); }
      await refresh();
    }
    function grow() {
      var input = document.getElementById("bpInput");
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
    }

    async function initBot() {
      document.getElementById("botPage").hidden = false;
      var panel = document.getElementById("bpDetails"), panelBtn = document.getElementById("bpPanel");
      var open = window.innerWidth >= 1100;
      try { var saved = localStorage.getItem("edgecoder-bot-panel"); if (saved === "open" || saved === "closed") open = saved === "open" && window.innerWidth >= 700; } catch {}
      function setPanel(v) { panel.hidden = !v; panelBtn.setAttribute("aria-pressed", v ? "true" : "false"); panelBtn.setAttribute("aria-label", v ? "Hide details" : "Show details"); }
      setPanel(open);
      panelBtn.addEventListener("click", function() { var v = panel.hidden; setPanel(v); try { localStorage.setItem("edgecoder-bot-panel", v ? "open" : "closed"); } catch {} });
      document.addEventListener("keydown", function(e) { if (e.key === "Escape" && !panel.hidden && window.innerWidth < 1100 && !document.getElementById("bpEditDialog").open) setPanel(false); });
      var tc = document.getElementById("tabChat"), tr = document.getElementById("tabRuns");
      tc.addEventListener("click", function() { selectTab("chat"); });
      tr.addEventListener("click", function() { selectTab("runs"); });
      tabKeys(tc, tr);
      var dd = document.getElementById("dTabDetails"), dm = document.getElementById("dTabMemory");
      dd.addEventListener("click", function() { selectDTab("details"); });
      dm.addEventListener("click", function() { selectDTab("memory"); });
      tabKeys(dd, dm);
      document.getElementById("bpCheck").addEventListener("click", function() { act("Checking now", "check_now"); });
      document.getElementById("bpStop").addEventListener("click", function() { act("Stopped", "stop"); });
      document.getElementById("bpPause").addEventListener("click", function() { act(state.bot.enabled ? "Paused" : "Resumed", state.bot.enabled ? "pause" : "resume"); });
      document.getElementById("bpEdit").addEventListener("click", openEdit);
      document.getElementById("bpEditCancel").addEventListener("click", function() { document.getElementById("bpEditDialog").close(); });
      document.getElementById("bpEditForm").addEventListener("submit", saveEdit);
      document.getElementById("bpOlder").addEventListener("click", loadOlder);
      document.getElementById("bpSend").addEventListener("click", sendMessage);
      var input = document.getElementById("bpInput");
      input.addEventListener("input", grow);
      input.addEventListener("keydown", function(e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
      document.getElementById("bpMessages").addEventListener("click", function(e) {
        var a = e.target.closest && e.target.closest("[data-approve],[data-deny]");
        if (!a) return;
        var callId = a.getAttribute("data-approve") || a.getAttribute("data-deny");
        act(a.hasAttribute("data-approve") ? "Approved" : "Denied", "approve", { callId: callId, approved: a.hasAttribute("data-approve") });
      });
      document.getElementById("bpDBody").addEventListener("click", function(e) {
        var t = e.target.closest && e.target.closest("[data-toggle-pause],[data-toggle-trigger]");
        if (!t || t.disabled) return;
        if (t.hasAttribute("data-toggle-pause")) { act(state.bot.enabled ? "Paused" : "Resumed", state.bot.enabled ? "pause" : "resume"); return; }
        var id = t.getAttribute("data-toggle-trigger");
        act("Saved", "update_settings", { triggers: state.bot.triggers.map(function(x) { var o = { id: x.id, kind: x.kind, enabled: x.id === id ? !x.enabled : x.enabled }; if (x.label) o.label = x.label; if (x.scope) o.scope = x.scope; if (x.onlyOthers !== undefined) o.onlyOthers = x.onlyOthers; return o; }) });
      });
      await refresh();
      if (state.bot) schedule();
    }

    (async function() {
      try { await requireAuth(); } catch { return; }
      if (agentId && botId) initBot(); else showList();
    })();
`;

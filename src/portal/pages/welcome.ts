// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { CSP_NONCE } from "../csp-nonce.js";
import * as O from "../../common/onboarding.js";
import { CLIENT_ESCAPE_JS } from "./escape.js";
import { settingsPage } from "./settings-shell.js";

/**
 * Getting started on the web (/portal/welcome, one stable URL per step: /portal/welcome/<step>).
 * The same steps as the desktop wizard (src/common/onboarding.ts, shipped to the browser via
 * Function.prototype.toString as ONBOARDING_BROWSER_LIB). The web can't look at this computer, so
 * "Set up this computer" and "Add your other machines" show downloads and installer commands; the
 * checklists read the account (GET /portal/api/onboarding) and progress is saved there, shared
 * with the desktop app. Each step's panel carries `data-video-anchor="welcome-<step>"` and a video
 * slot that stays hidden until the step has a video. HTML is built by pure functions
 * (WELCOME_RENDER_SCRIPT) so tests render it without a DOM; no style attributes (CSP).
 */

/** The shared module's functions and the constants they read, as browser JS. */
export const ONBOARDING_BROWSER_LIB = [
  "var __name = function (f) { return f; };",
  `var ONBOARDING_STEPS = ${JSON.stringify(O.ONBOARDING_STEPS)};`,
  `var STEP_IDS = ${JSON.stringify(O.STEP_IDS)};`,
  `var GOAL_IDS = ${JSON.stringify(O.GOAL_IDS)};`,
  `var ROUTING_IDS = ${JSON.stringify(O.ROUTING_IDS)};`,
  `var GOAL_OPTIONS = ${JSON.stringify(O.GOAL_OPTIONS)};`,
  `var HOW_CARDS = ${JSON.stringify(O.HOW_CARDS)};`,
  `var HOW_MORE = ${JSON.stringify(O.HOW_MORE)};`,
  `var ROUTING_OPTIONS = ${JSON.stringify(O.ROUTING_OPTIONS)};`,
  `var MODEL_CLASSES = ${JSON.stringify(O.MODEL_CLASSES)};`,
  `var FALLBACK_TOKEN_PRICES = ${JSON.stringify(O.FALLBACK_TOKEN_PRICES)};`,
  `var TYPICAL_CALL = ${JSON.stringify(O.TYPICAL_CALL)};`,
  `var MODEL_SUGGESTIONS = ${JSON.stringify(O.MODEL_SUGGESTIONS)};`,
  `var INSTALL_LINKS = ${JSON.stringify(O.INSTALL_LINKS)};`,
  `var LOCAL_NETWORK_NOTE = ${JSON.stringify(O.LOCAL_NETWORK_NOTE)};`,
  `var SERVER_SETUP = ${JSON.stringify(O.SERVER_SETUP)};`,
  `var NEW_ACCOUNT_DAYS = ${O.NEW_ACCOUNT_DAYS};`,
  ...[
    O.emptyOnboardingState,
    O.normalizeOnboardingState,
    O.stepById,
    O.stepsFor,
    O.checklistFor,
    O.shownChecklist,
    O.itemDone,
    O.stepComplete,
    O.progressFor,
    O.nextStepId,
    O.prevStepId,
    O.shouldShowOnboarding,
    O.fundingOptional,
    O.suggestModel,
    O.paramsFromModel,
    O.usdPerMToCSats,
    O.classPrice,
    O.cSatsPerCall,
    O.callsPerThousand,
    O.estimateCSats,
    O.groupThousands,
    O.installCommand,
    O.serverInstallCommand,
    O.localProviderSnippet,
    O.hostedApiSnippet,
    O.actionHref,
    O.stepRoute,
    O.stepFromRoute
  ].map((f) => f.toString())
].join("\n");

/**
 * Pure HTML builders on top of ONBOARDING_BROWSER_LIB and escapeHtml. `ctx` is
 * { state, signals, origin, wallet: { models, btcUsd, launch } | null, onchain: boolean | null,
 *   calls, classId }.
 */
export const WELCOME_RENDER_SCRIPT = `
    function wzCode(id, text) {
      return "<div class='wz-code'><pre id='" + id + "'><code>" + escapeHtml(text) + "</code></pre><button type='button' class='wz-copy' data-copy='" + id + "'>Copy</button></div>";
    }
    function wzStatus(v) {
      return v === true ? "<span class='wz-check done' aria-hidden='true'>✓</span>" : "<span class='wz-check' aria-hidden='true'></span>";
    }
    function wzStatusText(v) { return v === true ? "Done" : v === false ? "Not yet" : "Check in the app"; }
    function wzChecklist(step, ctx) {
      var items = shownChecklist(step, "web");
      if (!items.length) return "";
      return "<ul class='wz-checklist' aria-label='Checklist'>" + items.map(function (c) {
        var v = itemDone(c.id, ctx.signals, ctx.state);
        return "<li data-item='" + c.id + "'>" + wzStatus(v) + "<span>" + escapeHtml(c.label) + (c.optional ? " <span class='wz-muted'>(optional)</span>" : "") +
          "</span><span class='wz-sr'>: " + wzStatusText(v) + "</span></li>";
      }).join("") + "</ul>";
    }
    function wzActions(step) {
      var acts = step.actions.filter(function (a) { return a.web; });
      if (!acts.length) return "";
      return "<div class='wz-actions'>" + acts.map(function (a) {
        var href = actionHref(a.web);
        var ext = /^https?:/.test(href) ? " target='_blank' rel='noreferrer'" : "";
        return "<a class='wz-btn" + (a.primary ? " primary" : "") + "' data-action='" + a.id + "' href='" + escapeHtml(href) + "'" + ext + ">" + escapeHtml(a.label) + "</a>";
      }).join("") + "</div>";
    }
    function wzVideo(step) {
      var v = step.video || {};
      if (!v.src) return "<div class='wz-video' data-video-slot='" + step.id + "' hidden></div>";
      return "<div class='wz-video' data-video-slot='" + step.id + "'><video controls preload='none' src='" + escapeHtml(v.src) + "'" + (v.poster ? " poster='" + escapeHtml(v.poster) + "'" : "") + ">" +
        (v.captions ? "<track kind='captions' srclang='en' label='English' default src='" + escapeHtml(v.captions) + "'>" : "") + "</video></div>";
    }
    function wzRadios(name, options, current, legend) {
      return "<fieldset class='wz-choices'><legend class='wz-sr'>" + escapeHtml(legend) + "</legend>" + options.map(function (o) {
        return "<label class='wz-choice'><input type='radio' name='" + name + "' value='" + o.id + "'" + (current === o.id ? " checked" : "") + "><span><span class='wz-choice-title'>" + escapeHtml(o.title) +
          (o.recommended ? " <span class='wz-tag'>Recommended</span>" : "") + "</span><span class='wz-choice-desc'>" + escapeHtml(o.desc) + "</span></span></label>";
      }).join("") + "</fieldset>";
    }
    function wzCards(cards, numbered) {
      return "<ol class='wz-cards" + (numbered ? "" : " plain") + "'>" + cards.map(function (c) {
        return "<li class='wz-card'><h3>" + escapeHtml(c.title) + "</h3><p>" + escapeHtml(c.body) + "</p></li>";
      }).join("") + "</ol>";
    }
    function wzEstimator(ctx) {
      var w = ctx.wallet || {};
      var rows = MODEL_CLASSES.map(function (c) {
        var p = classPrice(c.id, { models: w.models || [], btcUsd: w.btcUsd || null });
        if (!p) return "<tr><td>" + escapeHtml(c.label) + "</td><td colspan='2'>Prices unavailable</td></tr>";
        var per = cSatsPerCall(p);
        return "<tr" + (c.id === ctx.classId ? " class='wz-row-on'" : "") + "><td>" + escapeHtml(c.label) + "</td><td class='num'>" + per.toFixed(per < 1 ? 2 : 1) + "</td><td class='num'>about " + groupThousands(callsPerThousand(per)) + "</td></tr>";
      }).join("");
      var sel = classPrice(ctx.classId, { models: w.models || [], btcUsd: w.btcUsd || null });
      var perSel = sel ? cSatsPerCall(sel) : null;
      var day = perSel === null ? null : estimateCSats(ctx.calls, perSel, 1);
      var month = perSel === null ? null : estimateCSats(ctx.calls, perSel, 30);
      var options = MODEL_CLASSES.map(function (c) { return "<option value='" + c.id + "'" + (c.id === ctx.classId ? " selected" : "") + ">" + escapeHtml(c.label) + "</option>"; }).join("");
      return "<div class='wz-estimator'><h3>Estimate your cost</h3>" +
        "<div class='wz-est-controls'><label for='wzCalls'>Calls per day: <strong id='wzCallsValue'>" + ctx.calls + "</strong></label>" +
        "<input id='wzCalls' type='range' min='0' max='500' step='10' value='" + ctx.calls + "'>" +
        "<label for='wzClass'>Model size</label><select id='wzClass'>" + options + "</select></div>" +
        "<p class='wz-est-result' aria-live='polite'>" + (day === null ? "Prices are unavailable right now." : "About <strong>" + groupThousands(day) + " cSats a day</strong>, " + groupThousands(month) + " a month, on the network. Your own machines cost nothing.") + "</p>" +
        "<div class='wz-table'><table><caption class='wz-sr'>Cost per typical call by model size</caption><thead><tr><th>Model size</th><th class='num'>cSats per call</th><th class='num'>Calls per 1,000 cSats</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
        "<p class='wz-muted'>A typical call: " + groupThousands(TYPICAL_CALL.input) + " tokens in, " + TYPICAL_CALL.output + " out. Live prices from the network.</p></div>";
    }
    /* A Linux or cloud GPU server in four steps; the install key fills the command once created here. */
    function wzServerSteps(ctx) {
      var key = ctx.installKey || "";
      var guide = "<a href='" + escapeHtml(INSTALL_LINKS.serverGuide) + "' target='_blank' rel='noreferrer'>" + escapeHtml(SERVER_SETUP.guideTitle) + "</a>";
      return "<ol class='wz-howto'>" +
        "<li><strong>Create an install key.</strong> " + (key
          ? "<span class='wz-note'>Done: it's in the command in step 3. It's shown only here, once. Revoke it in Settings → Connect your tools once the server is online.</span>"
          : "<button type='button' class='wz-btn' id='wzCreateKey'>Create install key</button> <span class='wz-muted'>It fills in the command below. Keep it private: it acts as your account.</span>") + "</li>" +
        "<li><strong>Connect to the server with SSH.</strong> On a Mac or Linux open Terminal; on Windows open PowerShell. Put in your server's IP address (from your provider's dashboard); most GPU clouds log in as <code>ubuntu</code>, some as <code>root</code>." +
          wzCode("wzSshCmd", SERVER_SETUP.sshCommand) + "</li>" +
        "<li><strong>Paste the install command</strong> into the server and press Enter. It takes 5 to 15 minutes and starts one agent per GPU." +
          wzCode("wzInstallCmd", serverInstallCommand(ctx.origin, key || SERVER_SETUP.keyPlaceholder)) + "</li>" +
        "<li><strong>NVIDIA GPU with 24 GB or more? Switch to vLLM</strong>, which serves several calls at once. It picks the settings for your GPU:" +
          wzCode("wzVllmCmd", SERVER_SETUP.vllmCommand) + "</li>" +
        "</ol><p>Full guide: " + guide + ". SSH keys, providers and GPU sizes, checks, and troubleshooting.</p>";
    }
    function wzStepBody(step, ctx) {
      var s = ctx.state, sig = ctx.signals;
      if (step.id === "welcome") return wzRadios("wzGoal", GOAL_OPTIONS, s.goal, "What do you want to do?");
      if (step.id === "how") return wzCards(HOW_CARDS, true) + "<h3 class='wz-sub'>Also in EdgeCoder</h3>" + wzCards(HOW_MORE, false);
      if (step.id === "this-machine") {
        return "<p>Install the desktop app on this computer (Mac or Windows). It bundles the agent and Ollama, updates itself and suggests a model for your hardware:</p>" +
          "<ul class='wz-list'>" + MODEL_SUGGESTIONS.map(function (m) { return "<li><strong>" + escapeHtml(m.label) + "</strong>: " + escapeHtml(m.reason) + "</li>"; }).join("") + "</ul>";
      }
      if (step.id === "machines") {
        var n = sig.machines === null ? "unknown" : String(sig.machines);
        return "<p class='wz-live' aria-live='polite'>Machines on your account: <strong id='wzMachineCount'>" + n + "</strong>" + (sig.machinesOnline !== null ? ", " + sig.machinesOnline + " online" : "") + ".</p>" +
          "<h3 class='wz-sub'>Mac and Windows</h3><p>Install the desktop app and sign in with this account. <a href='" + INSTALL_LINKS.mac + "'>Mac</a> · <a href='" + INSTALL_LINKS.windows + "'>Windows</a></p>" +
          "<h3 class='wz-sub'>Linux and GPU servers</h3>" + wzServerSteps(ctx) +
          "<p class='wz-note'>" + escapeHtml(LOCAL_NETWORK_NOTE) + "</p>" +
          "<p class='wz-muted'>Each machine's models: Settings → Nodes.</p>";
      }
      if (step.id === "models") {
        return wzRadios("wzRouting", ROUTING_OPTIONS, s.routing || "auto", "Where things run") +
          "<p class='wz-muted'>Bots have their own setting in the bot form. In the app, Auto is in the chat's compute menu.</p>" +
          "<h3 class='wz-sub'>Bring your own frontier key (optional)</h3><p>In the desktop app (Settings → General), add your own Anthropic or OpenAI-compatible key to lead with a frontier model. Only your account uses it; the provider bills you.</p>";
      }
      if (step.id === "fund") {
        var w = ctx.wallet || {};
        var cap = w.launch && w.launch.maxBuySatsPerDay ? "<p class='wz-muted'>Early access: up to " + groupThousands(w.launch.maxBuySatsPerDay) + " sats a day.</p>" : "";
        var chain = ctx.onchain === true
          ? "<a class='wz-btn' href='/portal/settings/plan'>Fund with Bitcoin</a>"
          : "<button type='button' class='wz-btn' disabled aria-describedby='wzOnchainSoon'>Fund with Bitcoin</button> <span id='wzOnchainSoon' class='wz-muted'>Coming soon</span>";
        return (fundingOptional(s.goal) ? "<p class='wz-note'>You chose your own machines: they're free, so you can skip this.</p>" : "") +
          wzEstimator(ctx) + "<div class='wz-actions'><a class='wz-btn primary' href='/portal/settings/plan'>Fund with Lightning</a>" + chain + "</div>" + cap +
          "<p class='wz-muted'>Bots have a daily budget, so a bot never spends more than you allow.</p>";
      }
      if (step.id === "tools") {
        return "<h3 class='wz-sub'>GitHub</h3><p>Connect GitHub to clone repositories and open pull requests (Code → New project → Clone from GitHub).</p>" +
          "<h3 class='wz-sub'>Hosted API</h3><p>OpenAI-compatible <code>/v1/chat/completions</code> and Anthropic-style <code>/v1/messages</code>, with an API key from Settings → Connect your tools. Use it from Cursor, servers and scripts.</p>" +
          wzCode("wzHostedApi", hostedApiSnippet(ctx.origin)) +
          "<h3 class='wz-sub'>Editors on this computer</h3><p>With the desktop app running, Continue, Zed, Cline, Claude Code and other tools can use its local provider. The app's Settings → Connect your tools gives each tool its key and setup.</p>" +
          wzCode("wzLocalProvider", localProviderSnippet("from the app")) +
          "<h3 class='wz-sub'>Terminal</h3><p>In the desktop app: Settings → General → Command line → Install command-line tool. Then:</p>" +
          wzCode("wzCli", "edgecoder code") +
          "<p>Type <code>/remote</code> in a session to keep working on it in the app's Code view.</p>";
      }
      if (step.id === "try") {
        return "<p>Ideas to start with:</p><ul class='wz-list'><li>In Chat: \\"Explain what a Lightning invoice is in two sentences.\\"</li><li>In the app's Code view: open a project and ask it to explain a file.</li><li>Create a bot with a small daily budget.</li></ul>" +
          "<p class='wz-muted'>Each reply ends with where it ran (your machine or the network) and what it cost.</p>";
      }
      if (step.id === "host") {
        return "<ul class='wz-list'><li>A machine that stays on with a good connection.</li><li>A model people use. A 30B coder on a GPU or a 32 GB+ Mac earns most.</li><li>Approval: send the request and an admin reviews it.</li></ul>" +
          (sig.hostApproved === true ? "<p class='wz-note'>You're approved: your machines can take network work.</p>" : sig.hostRequested ? "<p class='wz-note'>Request sent. We'll email you.</p>" : "");
      }
      if (step.id === "done") {
        var prog = progressFor(s, sig, "web");
        return "<ul class='wz-summary'>" + prog.steps.filter(function (p) { return p.id !== "done"; }).map(function (p) {
          var st = stepById(p.id);
          return "<li>" + wzStatus(p.complete) + "<a href='/portal/welcome/" + p.id + "'>" + escapeHtml(st.title) + "</a><span class='wz-sr'>: " + (p.complete ? "done" : p.skipped ? "skipped" : "not yet") + "</span>" + (p.skipped && !p.complete ? " <span class='wz-muted'>(skipped)</span>" : "") + "</li>";
        }).join("") + "</ul>" +
          "<p>More: <a href='" + INSTALL_LINKS.computeDoc + "' target='_blank' rel='noreferrer'>Using compute</a> · <a href='" + INSTALL_LINKS.terminalDoc + "' target='_blank' rel='noreferrer'>Terminal</a> · <a href='" + INSTALL_LINKS.apiDoc + "' target='_blank' rel='noreferrer'>API</a> · <a href='" + INSTALL_LINKS.installDoc + "' target='_blank' rel='noreferrer'>Installer</a></p>";
      }
      return "";
    }
    function wzStepNav(ctx) {
      var prog = progressFor(ctx.state, ctx.signals, "web");
      return "<ol class='wz-steps'>" + prog.steps.map(function (p, i) {
        var st = stepById(p.id);
        var cur = p.id === ctx.state.current;
        // done: complete and moved past (or current); ready: complete from the account's state, not reached yet (quieter).
        var look = !p.complete ? "" : p.visited || cur ? " done" : " ready";
        return "<li><a href='/portal/welcome/" + p.id + "' data-step='" + p.id + "' class='wz-step-link" + look + "'" + (cur ? " aria-current='step'" : "") + ">" +
          "<span class='wz-step-num' aria-hidden='true'>" + (p.complete ? "✓" : String(i + 1)) + "</span><span class='wz-step-label'>" + escapeHtml(st.title) + "</span>" +
          "<span class='wz-sr'>" + (p.complete ? ", done" : p.skipped ? ", skipped" : "") + "</span></a></li>";
      }).join("") + "</ol>";
    }
    function wzPanel(ctx) {
      var step = stepById(ctx.state.current);
      var prog = progressFor(ctx.state, ctx.signals, "web");
      var next = nextStepId(step.id, ctx.state.goal);
      var prev = prevStepId(step.id, ctx.state.goal);
      var skip = step.skip && next ? "<button type='button' class='wz-btn ghost' id='wzSkip'>" + escapeHtml(step.skip) + "</button>" : "";
      return "<section class='wz-panel' data-video-anchor='welcome-" + step.id + "' data-step='" + step.id + "' aria-labelledby='wzTitle'>" +
        "<p class='wz-count'>Step " + (prog.index + 1) + " of " + prog.total + "</p>" +
        "<h2 id='wzTitle' tabindex='-1'>" + escapeHtml(step.title) + "</h2><p class='wz-body'>" + escapeHtml(step.body) + "</p>" +
        wzVideo(step) + wzStepBody(step, ctx) + wzChecklist(step, ctx) + wzActions(step) +
        "<div class='wz-footer'>" + (prev ? "<button type='button' class='wz-btn' id='wzBack'>Back</button>" : "<span></span>") +
        "<div class='wz-footer-right'>" + skip + "<button type='button' class='wz-btn primary' id='wzNext'>" + (next ? "Next" : "Finish") + "</button></div></div></section>";
    }
`;

const WELCOME_CSS = `
  <style nonce="${CSP_NONCE}">
    /* One centred block in the wide Settings pane: the step list and an ~820px step column. */
    .wz-wrap { max-width: 1064px; margin: 0 auto; }
    .wz { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; }
    .wz-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .wz-head h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.015em; }
    .wz-head p { margin: 0; color: var(--muted); font-size: 13px; }
    .wz-progress { width: 100%; height: 6px; margin: 4px 0 16px; accent-color: var(--brand); }
    .wz-howto { margin: 8px 0 12px; padding-left: 22px; display: flex; flex-direction: column; gap: 12px; }
    .wz-howto li { line-height: 1.5; }
    .wz-howto .wz-code { margin-top: 6px; }
    .wz-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    /* Badge and label share a 20px line, so a two-line label keeps its badge on the first line. */
    .wz-step-link { display: flex; align-items: flex-start; gap: 10px; padding: 7px 8px; border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 13px; line-height: 20px; }
    .wz-step-label { min-width: 0; }
    .wz-step-link:hover { background: var(--bg-elevated); color: var(--text); }
    .wz-step-link[aria-current="step"] { background: var(--bg-elevated); color: var(--text); font-weight: 600; }
    .wz-step-num { flex: none; box-sizing: border-box; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--card-border); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1; font-variant-numeric: tabular-nums; }
    .wz-step-link[aria-current="step"] .wz-step-num { border-color: var(--brand); color: var(--brand); }
    .wz-step-link.done .wz-step-num { background: var(--brand); border-color: var(--brand); color: var(--on-accent); }
    .wz-step-link.ready { color: var(--muted); }
    .wz-step-link.ready .wz-step-num { color: var(--muted); }
    .wz-panel { border: 1px solid var(--card-border); border-radius: var(--radius-lg); background: var(--card); padding: 20px; min-width: 0; }
    .wz-panel h2 { font-size: 20px; margin: 0 0 6px; letter-spacing: -0.015em; }
    .wz-panel h2:focus { outline: none; }
    .wz-panel h3 { font-size: 14px; margin: 0 0 4px; }
    .wz-panel p, .wz-panel li { font-size: 13.5px; line-height: 1.55; }
    .wz-count { color: var(--muted); font-size: 12px; margin: 0 0 4px; }
    .wz-body { color: var(--text-secondary); margin: 0 0 16px; }
    .wz-sub { margin-top: 18px !important; }
    .wz-muted { color: var(--muted); font-size: 12.5px; }
    .wz-note { padding: 10px 12px; border: 1px solid var(--card-border); border-radius: var(--radius-sm); background: var(--bg-soft); }
    .wz-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .wz-choices { border: 0; padding: 0; margin: 0 0 12px; display: grid; gap: 8px; }
    /* The portal's form styles make every label a small uppercase caption and every input full width
       (design-system.ts); a choice row is neither. */
    .wz-choice { display: flex; gap: 10px; align-items: flex-start; margin: 0; padding: 12px; border: 1px solid var(--card-border); border-radius: var(--radius-md); cursor: pointer; font-size: 13.5px; font-weight: 400; letter-spacing: normal; text-transform: none; color: var(--text); }
    .wz-choice:has(input:checked) { border-color: var(--brand); background: var(--brand-soft); }
    .wz-choice input { flex: none; width: auto; min-height: 0; margin: 3px 0 0; padding: 0; box-shadow: none; accent-color: var(--brand); }
    .wz-choice-title { display: block; font-weight: 600; font-size: 13.5px; }
    .wz-choice-desc { display: block; color: var(--muted); font-size: 12.5px; }
    .wz-tag { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 999px; background: var(--brand); color: var(--on-accent); }
    .wz-cards { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; counter-reset: wz; }
    .wz-card { border: 1px solid var(--card-border); border-radius: var(--radius-md); padding: 12px; background: var(--bg-soft); counter-increment: wz; }
    .wz-cards:not(.plain) .wz-card h3::before { content: counter(wz) ". "; color: var(--brand-2); }
    .wz-card p { margin: 0; color: var(--text-secondary); font-size: 12.5px; }
    .wz-list { padding-left: 18px; }
    .wz-code { position: relative; margin: 8px 0; }
    .wz-code pre { margin: 0; padding: 10px 70px 10px 12px; background: var(--bg-input); border: 1px solid var(--card-border); border-radius: var(--radius-sm); font-size: 12px; overflow-x: auto; white-space: pre; }
    .wz-copy { position: absolute; top: 6px; right: 6px; min-height: 0; padding: 4px 8px; font-size: 11px; }
    .wz-checklist, .wz-summary { list-style: none; padding: 0; margin: 16px 0 0; display: flex; flex-direction: column; gap: 6px; }
    .wz-checklist li, .wz-summary li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .wz-check { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--card-border); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
    .wz-check.done { background: var(--ok); border-color: var(--ok); color: var(--on-accent); }
    .wz-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; align-items: center; }
    .wz-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 0 14px; border: 1px solid var(--card-border); border-radius: var(--radius-sm); background: var(--bg-soft); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; }
    .wz-btn.primary { background: var(--brand); border-color: var(--brand); color: var(--on-accent); }
    .wz-btn.ghost { background: none; border-color: transparent; color: var(--text-secondary); }
    .wz-btn[disabled] { opacity: 0.55; cursor: not-allowed; }
    .wz-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--card-border); flex-wrap: wrap; }
    .wz-footer-right { display: flex; gap: 8px; flex-wrap: wrap; }
    .wz-video { margin: 0 0 14px; }
    .wz-video video { width: 100%; border-radius: var(--radius-md); background: var(--bg-soft); }
    .wz-estimator { margin-top: 8px; }
    .wz-est-controls { display: grid; grid-template-columns: 1fr; gap: 6px; max-width: 420px; }
    .wz-est-controls select { width: auto; }
    .wz-est-result { margin: 10px 0; }
    .wz-table { overflow-x: auto; }
    .wz-table table { width: 100%; font-size: 12.5px; }
    .wz-table .num { text-align: right; font-variant-numeric: tabular-nums; }
    .wz-row-on td { font-weight: 600; }
    @media (max-width: 760px) {
      .wz { grid-template-columns: minmax(0, 1fr); gap: 12px; }
      .wz-steps { flex-direction: row; overflow-x: auto; gap: 4px; }
      .wz-step-link { white-space: nowrap; align-items: center; }
      .wz-step-link span:not(.wz-step-num):not(.wz-sr) { display: none; }
      .wz-step-link[aria-current="step"] span:not(.wz-step-num):not(.wz-sr) { display: inline; }
      .wz-panel { padding: 14px; }
      .wz-head { flex-direction: column; }
    }
  </style>`;

export function welcomeContent(): string {
  return `${WELCOME_CSS}
    <div class="wz-wrap">
    <div class="wz-head">
      <div><h1 id="wzHeading">Getting started</h1><p>From zero to taking part: your machines, models, funds and tools.</p></div>
      <button type="button" class="wz-btn ghost" id="wzDismiss">Close guide</button>
    </div>
    <progress class="wz-progress" id="wzProgress" max="10" value="0" aria-label="Getting started progress"></progress>
    <p class="wz-sr" id="wzAnnounce" role="status" aria-live="polite"></p>
    <div class="wz">
      <nav aria-label="Getting started steps" id="wzNav"><div class="muted">Loading…</div></nav>
      <div id="wzMain"><div class="muted">Loading…</div></div>
    </div>
    </div>`;
}

export function welcomeScript(): string {
  return `
    ${CLIENT_ESCAPE_JS}
    ${ONBOARDING_BROWSER_LIB}
    ${WELCOME_RENDER_SCRIPT}
    var wzCtx = { state: emptyOnboardingState(Date.now()), signals: { machines: null, machinesOnline: null, balanceCSats: null, apiKeys: null, github: null, firstTask: null, hostApproved: null, hostRequested: null, newAccount: null, localModels: null, cliInstalled: null }, origin: location.origin, wallet: null, onchain: null, calls: 50, classId: "35b", installKey: "" };
    var wzPoll = null;
    async function wzSave(patch) {
      try {
        var r = await api("/portal/api/onboarding", { method: "POST", body: JSON.stringify(patch) });
        wzCtx.state = normalizeOnboardingState(r.state, Date.now());
        wzCtx.signals = r.signals;
      } catch (e) { showToast("Couldn't save your progress. It will be kept on this page.", true); }
    }
    async function wzRefresh() {
      try {
        var r = await api("/portal/api/onboarding", { method: "GET", headers: {} });
        if (r.state) { var cur = wzCtx.state.current; wzCtx.state = normalizeOnboardingState(r.state, Date.now()); wzCtx.state.current = cur; }
        wzCtx.signals = r.signals;
      } catch (e) {}
    }
    async function wzLoadWallet() {
      try { wzCtx.wallet = await api("/portal/api/wallet/overview", { method: "GET", headers: {} }); } catch (e) { wzCtx.wallet = null; }
      try { var oc = await api("/portal/api/wallet/onchain", { method: "GET", headers: {} }); wzCtx.onchain = oc && oc.enabled === true; } catch (e) { wzCtx.onchain = false; }
    }
    function wzRender(focusTitle) {
      var prog = progressFor(wzCtx.state, wzCtx.signals, "web");
      var bar = document.getElementById("wzProgress");
      bar.max = prog.total; bar.value = prog.completed;
      bar.setAttribute("aria-valuetext", prog.completed + " of " + prog.total + " steps done");
      document.getElementById("wzNav").innerHTML = wzStepNav(wzCtx);
      // Keep the step's video player across re-renders (the guide refreshes every 10 s): replacing
      // it would restart playback. Re-attach the same element when the step hasn't changed.
      var oldSlot = document.querySelector("#wzMain .wz-video");
      var keepVideo = oldSlot && oldSlot.getAttribute("data-video-slot") === wzCtx.state.current ? oldSlot : null;
      if (keepVideo) keepVideo.parentNode.removeChild(keepVideo);
      document.getElementById("wzMain").innerHTML = wzPanel(wzCtx);
      if (keepVideo) { var newSlot = document.querySelector("#wzMain .wz-video"); if (newSlot) newSlot.parentNode.replaceChild(keepVideo, newSlot); }
      var step = stepById(wzCtx.state.current);
      document.title = step.title + " · Getting started · EdgeCoder";
      if (focusTitle) {
        document.getElementById("wzAnnounce").textContent = "Step " + (prog.index + 1) + " of " + prog.total + ": " + step.title;
        var h = document.getElementById("wzTitle"); if (h) h.focus();
      }
      if (step.id === "fund" && wzCtx.wallet === null) wzLoadWallet().then(function () { if (wzCtx.state.current === "fund") wzRender(false); });
    }
    function wzGo(id, push) {
      wzCtx.state.current = id;
      if (push) history.pushState({ step: id }, "", stepRoute(id, "web"));
      wzRender(true);
      wzSave({ current: id });
    }
    function wzMarkDone(id) {
      var done = wzCtx.state.done.slice(); if (done.indexOf(id) < 0) done.push(id);
      var skipped = wzCtx.state.skipped.filter(function (s) { return s !== id; });
      wzCtx.state.done = done; wzCtx.state.skipped = skipped;
      return { done: done, skipped: skipped };
    }
    document.addEventListener("click", async function (e) {
      var t = e.target.closest ? e.target.closest("button, a") : null;
      if (!t) return;
      if (t.id === "wzNext") {
        var cur = wzCtx.state.current, nx = nextStepId(cur, wzCtx.state.goal);
        var patch = wzMarkDone(cur);
        if (!nx) { await wzSave(Object.assign(patch, { completed: true })); location.href = "/portal/dashboard"; return; }
        await wzSave(patch); wzGo(nx, true);
      } else if (t.id === "wzBack") {
        var pv = prevStepId(wzCtx.state.current, wzCtx.state.goal); if (pv) wzGo(pv, true);
      } else if (t.id === "wzSkip") {
        var c = wzCtx.state.current, n2 = nextStepId(c, wzCtx.state.goal);
        var sk = wzCtx.state.skipped.slice(); if (sk.indexOf(c) < 0) sk.push(c);
        wzCtx.state.skipped = sk; await wzSave({ skipped: sk }); if (n2) wzGo(n2, true);
      } else if (t.id === "wzDismiss") {
        await wzSave({ dismissed: true }); showToast("Guide closed. Reopen it from Settings → Getting started."); location.href = "/portal/dashboard";
      } else if (t.classList.contains("wz-step-link")) {
        e.preventDefault(); wzGo(t.getAttribute("data-step"), true);
      } else if (t.id === "wzCreateKey") {
        t.disabled = true;
        try {
          var made = await api("/portal/api/keys", { method: "POST", body: JSON.stringify({ name: "Server install " + new Date().toISOString().slice(0, 10) }) });
          wzCtx.installKey = made.key;
          wzRender(false);
          showToast("Install key created. It's in the install command.");
        } catch (err) {
          t.disabled = false;
          var msg = String((err && err.message) || err);
          showToast(/email_not_verified/.test(msg) ? "Verify your email first (see the dashboard), then create the key." : "Couldn't create a key: " + msg, true);
        }
      } else if (t.classList.contains("wz-copy")) {
        var pre = document.getElementById(t.getAttribute("data-copy"));
        try { await navigator.clipboard.writeText(pre.textContent); t.textContent = "Copied"; setTimeout(function () { t.textContent = "Copy"; }, 1500); } catch (err) { showToast("Copy failed: select the text instead.", true); }
      }
    });
    document.addEventListener("change", function (e) {
      var t = e.target;
      if (t.name === "wzGoal") { wzCtx.state.goal = t.value; wzSave({ goal: t.value }); wzRender(false); document.querySelector("input[name=wzGoal][value=" + t.value + "]").focus(); }
      if (t.name === "wzRouting") { wzCtx.state.routing = t.value; wzSave({ routing: t.value }); wzRender(false); document.querySelector("input[name=wzRouting][value=" + t.value + "]").focus(); }
      if (t.id === "wzClass") { wzCtx.classId = t.value; wzRender(false); document.getElementById("wzClass").focus(); }
    });
    document.addEventListener("input", function (e) {
      if (e.target.id === "wzCalls") { wzCtx.calls = Number(e.target.value); wzRender(false); document.getElementById("wzCalls").focus(); }
    });
    window.addEventListener("popstate", function () { var id = stepFromRoute(location.pathname); if (id) { wzCtx.state.current = id; wzRender(true); } });
    (async function () {
      await requireAuth();
      try {
        var r = await api("/portal/api/onboarding", { method: "GET", headers: {} });
        wzCtx.signals = r.signals;
        wzCtx.state = r.state ? normalizeOnboardingState(r.state, Date.now()) : emptyOnboardingState(Date.now());
      } catch (e) {}
      var fromUrl = stepFromRoute(location.pathname);
      if (fromUrl) wzCtx.state.current = fromUrl;
      // Opening the guide again brings it back if it was closed.
      await wzSave({ current: wzCtx.state.current, dismissed: false });
      wzRender(!!fromUrl);
      // Machines, balance and the rest update by themselves while the guide is open.
      wzPoll = setInterval(async function () {
        var focused = document.activeElement && document.activeElement.id;
        await wzRefresh();
        if (focused === "wzCalls" || focused === "wzClass") return;
        wzRender(false);
        if (focused && document.getElementById(focused)) document.getElementById(focused).focus();
      }, 10000);
    })().catch(function () {});
  `;
}

export function registerWelcomePages(app: FastifyInstance): void {
  const send = async (_req: unknown, reply: { type(t: string): { send(b: string): unknown } }) =>
    reply.type("text/html").send(settingsPage("welcome", "Set up your machines, models, funds and tools.", welcomeContent(), welcomeScript(), { wide: true }));
  app.get("/portal/welcome", send);
  for (const id of O.STEP_IDS) app.get(`/portal/welcome/${id}`, send);
}

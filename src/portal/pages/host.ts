// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * /host: "Host with us". Hosting for the network is by request during early access
 * (src/portal/host-requests.ts). The page explains what hosting involves and carries the
 * "Request to host" form. It is a plain HTML form (no script), so it works with the strict CSP;
 * POST /host/request answers a browser post with this same page, showing the outcome.
 */

import type { FastifyInstance } from "fastify";
import { BASE_CSS, TOKENS_CSS, brandMark, icon } from "./design-system.js";
import { htmlOpenTag, themeHeadTags, themeToggleButton } from "../assets.js";
import { DOCS_SITE_URL, GITHUB_REPO_URL, supportEmail } from "./urls.js";
import { escapeHtml } from "./escape.js";
import { CSP_NONCE } from "../csp-nonce.js";
import { COMPUTE_HARDWARE, COMPUTE_HARDWARE_LABELS, HONEYPOT_FIELD, HOST_KINDS, HOST_KIND_LABELS, HOST_REQUEST_FIELD_HINTS } from "../host-requests.js";

export type HostFormState =
  | { kind: "blank" }
  | { kind: "sent" }
  | { kind: "error"; error: "invalid" | "rate_limited" | "unavailable"; fields?: string[]; values?: Record<string, unknown> };

const HOST_KIND_HINTS: Record<(typeof HOST_KINDS)[number], string> = {
  compute_agent: "Runs model calls and code jobs on CPU or GPU",
  coordinator: "Routes work, runs the order book, anchors the ledger",
  bitcoin_node: "Bitcoin Core or Knots for anchoring and fees",
  lightning_node: "LND or Core Lightning for purchases and payouts"
};

function str(values: Record<string, unknown> | undefined, key: string): string {
  const v = values?.[key];
  return typeof v === "string" ? v : "";
}

function list(values: Record<string, unknown> | undefined, key: string): string[] {
  const v = values?.[key];
  return Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];
}

function formHtml(state: HostFormState): string {
  if (state.kind === "sent") {
    return `<div class="callout ok" role="status" id="hostRequestSent"><h3>Thanks, we have your request.</h3>
      <p class="muted">We read every one and reply by email, usually within a few days. Nothing to install yet: if it is a fit, we send you an invite and the setup steps.</p></div>`;
  }
  const values = state.kind === "error" ? state.values : undefined;
  const bad = new Set(state.kind === "error" ? state.fields ?? [] : []);
  const err = (f: string) => (bad.has(f) ? `<div class="field-err">${escapeHtml(HOST_REQUEST_FIELD_HINTS[f] ?? "Check this field.")}</div>` : "");
  const banner =
    state.kind !== "error"
      ? ""
      : state.error === "rate_limited"
        ? `<div class="callout warn" role="alert"><h3>We already have your request.</h3><div class="muted">We reply to every request; please wait for us to get in touch.</div></div>`
        : state.error === "unavailable"
          ? `<div class="callout warn" role="alert"><h3>The form is not available right now.</h3><div class="muted">Email <a href="mailto:${escapeHtml(supportEmail())}">${escapeHtml(supportEmail())}</a> instead.</div></div>`
          : `<div class="callout warn" role="alert"><h3>Please check the highlighted fields.</h3></div>`;
  const kinds = list(values, "hostKinds");
  const kindBoxes = HOST_KINDS.map(
    (k) => `<label class="check"><input type="checkbox" name="hostKinds" value="${k}"${kinds.includes(k) ? " checked" : ""} /><span><b>${escapeHtml(HOST_KIND_LABELS[k])}</b><small>${escapeHtml(HOST_KIND_HINTS[k])}</small></span></label>`
  ).join("");
  const hw = str(values, "computeHardware");
  const hwOptions = [`<option value="">Choose…</option>`, ...COMPUTE_HARDWARE.map((h) => `<option value="${h}"${hw === h ? " selected" : ""}>${escapeHtml(COMPUTE_HARDWARE_LABELS[h])}</option>`)].join("");
  return `${banner}
    <form class="host-form" id="hostRequestForm" method="post" action="/host/request" novalidate>
      <div class="grid2">
        <div><label for="hrName">Name</label><input id="hrName" name="name" type="text" maxlength="100" required autocomplete="name" value="${escapeHtml(str(values, "name"))}" />${err("name")}</div>
        <div><label for="hrEmail">Email</label><input id="hrEmail" name="email" type="email" maxlength="254" required autocomplete="email" value="${escapeHtml(str(values, "email"))}" />${err("email")}</div>
      </div>
      <label for="hrOrg">Organisation (optional)</label><input id="hrOrg" name="organisation" type="text" maxlength="120" autocomplete="organization" value="${escapeHtml(str(values, "organisation"))}" />${err("organisation")}
      <fieldset><legend>What would you host?</legend><div class="checks">${kindBoxes}</div>${err("hostKinds")}</fieldset>
      <div class="grid2">
        <div><label for="hrHw">Compute hardware (for a compute agent)</label><select id="hrHw" name="computeHardware">${hwOptions}</select>${err("computeHardware")}</div>
        <div><label for="hrRegion">Region</label><input id="hrRegion" name="region" type="text" maxlength="80" placeholder="e.g. Frankfurt, US-East, Singapore" value="${escapeHtml(str(values, "region"))}" />${err("region")}</div>
      </div>
      <label for="hrHwDetails">Hardware details</label><textarea id="hrHwDetails" name="hardwareDetails" rows="2" maxlength="500" placeholder="e.g. RTX 4090 24 GB, 64 GB RAM; or Mac Studio M2 Ultra 128 GB; uptime and bandwidth">${escapeHtml(str(values, "hardwareDetails"))}</textarea>${err("hardwareDetails")}
      <label for="hrMessage">Message</label><textarea id="hrMessage" name="message" rows="4" maxlength="2000" placeholder="Anything we should know: experience running nodes, how long you can commit, questions">${escapeHtml(str(values, "message"))}</textarea>${err("message")}
      <div class="hp" aria-hidden="true"><label for="hrWebsite">Leave this empty</label><input id="hrWebsite" name="${HONEYPOT_FIELD}" type="text" tabindex="-1" autocomplete="off" /></div>
      <div class="row u-mt-14"><button class="primary" type="submit">Request to host</button><span class="muted small">We use these details only to reply to your request.</span></div>
    </form>`;
}

export function hostPageHtml(state: HostFormState = { kind: "blank" }): string {
  return `<!doctype html>
  ${htmlOpenTag()}
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Host with us | EdgeCoder</title>
      <meta name="description" content="Hosting on the EdgeCoder network is by request during early access. Request to host a compute agent, coordinator, Bitcoin node or Lightning node." />
      ${themeHeadTags()}
      <style nonce="${CSP_NONCE}">
        ${TOKENS_CSS}
        ${BASE_CSS}
        .shell { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
        .nav { position: sticky; top: 0; z-index: 30; background: var(--bg); border-bottom: 1px solid var(--card-border); }
        .nav-inner { height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -0.01em; font-size: 15px; }
        .nav-links { display: flex; align-items: center; gap: 4px; }
        .nav-links a { padding: 7px 10px; border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 13px; font-weight: 500; }
        .nav-links a:hover, .nav-links a.active { color: var(--text); background: var(--bg-elevated); }
        .nav-actions { display: flex; gap: 8px; align-items: center; }
        @media (max-width: 760px) { .nav-links { display: none; } }
        .head { padding: 56px 0 8px; max-width: 720px; }
        .head h1 { font-size: clamp(30px, 4vw, 42px); line-height: 1.1; letter-spacing: -0.02em; margin: 12px 0 14px; }
        .head p { color: var(--text-secondary); font-size: 16px; line-height: 1.6; }
        .layout { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 32px; align-items: start; margin-top: 28px; }
        .info h2 { font-size: 18px; margin: 0 0 8px; }
        .info p, .info li { color: var(--text-secondary); font-size: 14px; line-height: 1.6; }
        .info ul { padding-left: 18px; margin: 0 0 18px; }
        .roles { display: grid; gap: 10px; margin-bottom: 20px; }
        .role { border: 1px solid var(--card-border); border-radius: var(--radius-md); background: var(--card); padding: 14px 16px; }
        .role h3 { font-size: 14px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
        .role p { margin: 0; font-size: 13px; color: var(--muted); }
        .form-card { border: 1px solid var(--card-border); border-radius: var(--radius-lg); background: var(--bg-soft); padding: 24px; }
        .form-card h2 { font-size: 20px; margin: 0 0 4px; }
        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        fieldset { border: none; padding: 0; margin: 12px 0 0; }
        legend { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
        .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        label.check { display: flex; gap: 10px; align-items: flex-start; margin: 0; padding: 10px 12px; border: 1px solid var(--card-border); border-radius: var(--radius-sm); background: var(--card); text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--text); cursor: pointer; }
        label.check input { width: auto; min-height: 0; margin-top: 3px; }
        label.check small { display: block; color: var(--muted); font-weight: 400; font-size: 12px; margin-top: 2px; }
        textarea { resize: vertical; }
        .field-err { color: var(--danger-ink); font-size: 12px; margin-top: 4px; }
        .hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
        .small { font-size: 12px; }
        .callout.ok { border-color: var(--ok); }
        .note { font-size: 13px; color: var(--muted); margin-top: 16px; }
        .foot { border-top: 1px solid var(--card-border); margin-top: 56px; padding: 24px 0 40px; color: var(--muted); font-size: 12px; display: flex; gap: 12px; flex-wrap: wrap; }
        .foot a { color: var(--muted); }
        @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
        @media (max-width: 560px) { .grid2, .checks { grid-template-columns: 1fr; } .form-card { padding: 16px; } }
      </style>
    </head>
    <body>
      <nav class="nav">
        <div class="shell nav-inner">
          <a class="brand" href="/">${brandMark(28)}<span>EdgeCoder</span></a>
          <div class="nav-links">
            <a href="/#how">How it works</a>
            <a href="/#market">Market</a>
            <a href="/host" class="active">Host with us</a>
            <a href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer">Docs</a>
            <a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
          </div>
          <div class="nav-actions">
            ${themeToggleButton()}
            <a class="btn" href="/portal">Sign in</a>
            <a class="btn primary" href="/portal#signup">Get started</a>
          </div>
        </div>
      </nav>
      <main class="shell">
        <section class="head">
          <div class="eyebrow u-brand-2">Early access · hosting by invitation</div>
          <h1>Host with us.</h1>
          <p>While the network is in early access, hosting for other people's work is by invitation only. We are adding hosts one at a time, so every machine that runs someone else's code or holds the network's money is one we know. Tell us what you would like to run and we will get in touch.</p>
        </section>
        <div class="layout">
          <section class="info" aria-label="What hosting involves">
            <div class="roles">
              <div class="role"><h3>${icon("cpu", 14)} Compute agent</h3><p>Runs model calls and sandboxed code jobs (Docker, no network) on CPU, NVIDIA or AMD GPUs, or Apple silicon, and is paid per measured second at the market price.</p></div>
              <div class="role"><h3>${icon("server", 14)} Coordinator</h3><p>Schedules tasks, runs the order book, anchors ledger checkpoints and federates with the other coordinators. Needs a public address and good uptime.</p></div>
              <div class="role"><h3>${icon("bitcoin", 14)} Bitcoin node</h3><p>Bitcoin Core or Knots, fully synced: ledger anchoring, fee estimation and block data for the mesh.</p></div>
              <div class="role"><h3>${icon("zap", 14)} Lightning node</h3><p>LND or Core Lightning with liquidity: settles purchases and payouts.</p></div>
            </div>
            <h2>What it involves</h2>
            <ul>
              <li>A machine you control, kept online and up to date, with Docker for sandboxed jobs.</li>
              <li>An EdgeCoder account in good standing; your node signs everything it does with its own key.</li>
              <li>Early-access hosts are paid in sats: compute agents for the work they run, infrastructure hosts from the network fee pool by uptime and by what they run.</li>
              <li>We may pause or remove a host at any time while the network is in early access.</li>
            </ul>
            <p>Already have an account? Your own machines can run your own work for free without an invitation: install the agent from Settings after you sign in. An invitation is only needed to take work from other people.</p>
          </section>
          <section class="form-card" id="request" aria-labelledby="requestTitle">
            <h2 id="requestTitle">Request to host</h2>
            <p class="muted u-mt-0">Or email <a href="mailto:${escapeHtml(supportEmail())}">${escapeHtml(supportEmail())}</a>.</p>
            ${formHtml(state)}
          </section>
        </div>
        <div class="foot"><span>&copy; 2025 EdgeCoder</span><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/acceptable-use">Acceptable Use</a><a href="/host-agreement">Host Agreement</a></div>
      </main>
    </body>
  </html>`;
}

/** The HTML answer to a browser form post (host-requests.ts renderFormResult). */
export function renderHostFormResult(result: { ok: true } | { ok: false; error: "invalid" | "rate_limited" | "unavailable"; fields?: string[]; values?: Record<string, unknown> }): string {
  return hostPageHtml(result.ok ? { kind: "sent" } : { kind: "error", error: result.error, fields: result.fields, values: result.values });
}

export function registerHostPage(app: FastifyInstance): void {
  app.get("/host", async (_req, reply) => reply.type("text/html").send(hostPageHtml()));
}

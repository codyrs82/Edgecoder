// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { icon } from "./design-system.js";
import { displayEnrollmentToken, escapeHtml } from "./escape.js";
import { settingsPage } from "./settings-shell.js";
import { WALLET_CONTENT, WALLET_SCRIPT } from "./wallet.js";
import { CSP_NONCE } from "../csp-nonce.js";
import { HOST_AGREEMENT_VERSION, NOTICES } from "../../common/legal-notices.js";

// #16: moved verbatim from src/portal/server.ts.
export function detectOS(userAgent: string): "macos" | "windows" | "linux" | "ios" | "unknown" {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/macintosh|mac os x/.test(ua)) return "macos";
  if (/windows/.test(ua)) return "windows";
  if (/linux|ubuntu|debian/.test(ua)) return "linux";
  return "unknown";
}

export function registerAccountPages(app: FastifyInstance): void {
// Settings > Wallet: balance, Add funds, where your sats go, earnings and withdrawals, activity (pages/wallet.ts). Was /portal/wallet.
app.get("/portal/settings/plan", async (_req, reply) => {
  return reply.type("text/html").send(settingsPage("plan", "Balance, adding funds, earnings and withdrawals.", WALLET_CONTENT, WALLET_SCRIPT, { wide: true }));
});

// Settings > Install agent. Was /portal/download (which redirects here with its ?token=).
app.get("/portal/settings/install", async (req, reply) => {
  const GH_RELEASE_BASE = "https://github.com/codyrs82/Edgecoder/releases/latest/download";
  const GH_RELEASES_PAGE = "https://github.com/codyrs82/Edgecoder/releases/latest";
  const userAgent = req.headers["user-agent"] || "";
  const detectedOS = detectOS(userAgent);
  // Only a well-formed enrolment token is shown in the commands; anything else is the placeholder.
  // Both values are HTML-escaped as well (they land in markup and in copyable shell commands).
  const tokenDisplay = escapeHtml(displayEnrollmentToken((req.query as Record<string, unknown> | undefined)?.token));
  const portalBase = escapeHtml((process.env.PORTAL_PUBLIC_URL || "https://edgecoder.io").replace(/\/$/, ""));

  const osLabels: Record<string, string> = {
    macos: "macOS", windows: "Windows", linux: "Linux", ios: "iOS", unknown: "your OS"
  };

  /* ── helper: build a wizard card ─────────────────────────────────── */
  function wizardCard(
    id: string,
    icon: string,
    title: string,
    steps: string[],
    isPrimary: boolean
  ): string {
    const cls = isPrimary ? "wizard-card" : "wizard-card secondary";
    const badge = isPrimary
      ? `<span class="rec-badge">Recommended for you</span>`
      : "";
    const stepsHtml = steps
      .map(
        (s, i) =>
          `<div class="step"><span class="step-num">${i + 1}</span><div class="step-content">${s}</div></div>`
      )
      .join("");
    return `<div class="${cls}" id="card-${id}">${badge}<h3 class="wz-title"><span class="wz-icon">${icon}</span>${title}</h3>${stepsHtml}</div>`;
  }

  /* ── platform card builders ──────────────────────────────────────── */
  const macCard = wizardCard("macos", icon("apple", 15), "macOS", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_aarch64.dmg">Download Desktop App (.dmg)</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" class="wz-more">All releases</a>`,
    `Open the <strong>.dmg</strong> and drag EdgeCoder to Applications. The app bundles the agent — no separate install needed.`,
    `Sign in with your EdgeCoder account. The app auto-discovers local models and connects to the mesh.`
  ], detectedOS === "macos");

  const winCard = wizardCard("windows", icon("windows", 15), "Windows", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_x64-setup.exe">Download installer (.exe)</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" class="wz-more">All releases</a>`,
    `Run the installer. Allow admin access if prompted.`,
    `Sign in with your EdgeCoder account to connect to the mesh.`
  ], detectedOS === "windows");

  // No Linux desktop build is published yet (desktop-release builds macOS and Windows), so the
  // Linux card offers the one-line agent installer, which is signed and verified (docs/install.md).
  const linuxCard = wizardCard("linux", icon("terminal", 15), "Linux (Debian / Ubuntu / Fedora)", [
    `Run the installer. It verifies a signed release, installs Node.js, Ollama and Docker, and starts one agent per GPU:
     <div class="code-block" id="linux-install"><code>curl -fsSLo install.sh ${portalBase}/install.sh && sudo bash install.sh --token ${tokenDisplay}</code><button class="copy-btn" data-copy="linux-install">Copy</button></div>`,
    `Check it with <code>sudo edgecoder-install status</code>. The desktop app for Linux is not available yet.`
  ], detectedOS === "linux");

  const iosCard = wizardCard("ios", icon("phone", 15), "iOS (iPhone / iPad)", [
    `<a class="dl-btn" href="#">Download from App Store</a>
     <span class="wz-aside u-ml-8">TestFlight available now</span>`,
    `Sign in with your <strong>EdgeCoder account</strong>.`,
    `Go to <strong>Settings</strong> and paste your token: <div class="code-block u-mt-6" id="ios-token"><code>${tokenDisplay}</code><button class="copy-btn" data-copy="ios-token">Copy</button></div>`
  ], detectedOS === "ios");

  const vscodeCard = wizardCard("vscode", icon("code", 15), "VS Code Extension", [
    `<div class="code-block" id="vscode-cmd"><code>ext install edgecoder.edgecoder</code><button class="copy-btn" data-copy="vscode-cmd">Copy</button></div>
     <span class="wz-aside">Run in the VS Code command line, or search "EdgeCoder" in the Extensions panel.</span>`,
    `Open the Command Palette (<kbd>Ctrl+Shift+P</kbd> / <kbd>Cmd+Shift+P</kbd>) &rarr; <strong>EdgeCoder: Configure</strong>.`
  ], false);

  // No container image is published to a registry yet, so there is no Docker card. Hosts that want
  // containers build deploy/docker/Dockerfile.agent themselves (docs/packages.md).

  /* ── pick primary vs secondary cards ─────────────────────────────── */
  const allCards: Record<string, string> = {
    macos: macCard, windows: winCard, linux: linuxCard, ios: iosCard, vscode: vscodeCard
  };
  const primaryKey = (detectedOS === "unknown") ? "macos" : detectedOS;
  const primaryCard = allCards[primaryKey];
  // One installer for every platform (docs/install.md): detects GPUs, one agent per GPU.
  const universalCard = `<div class="wizard-card secondary" id="card-universal"><h3 class="wz-title tight"><span class="wz-icon">${icon("server", 15)}</span>Servers and GPU hosts: one-line install (Linux, macOS, Windows)</h3>
    <p class="wz-lede">Detects every GPU and runs one agent per card with a model sized to its memory. Same options on all three platforms; the packages above run the same installer.</p>
    <div class="code-block" id="install-sh"><code>curl -fsSLo install.sh ${portalBase}/install.sh && sudo bash install.sh --token ${tokenDisplay}</code><button class="copy-btn" data-copy="install-sh">Copy</button></div>
    <div class="code-block u-mt-8" id="install-ps1"><code>irm ${portalBase}/install.ps1 -OutFile install.ps1; .\\install.ps1 -- --token ${tokenDisplay}</code><button class="copy-btn" data-copy="install-ps1">Copy</button></div>
    <div class="wz-after">Then <code>sudo edgecoder-install plan</code> shows the node ids to enrol; pass each token with <code>--token &lt;node-id&gt;=&lt;token&gt;</code>.</div></div>`;
  const secondaryCards = universalCard + Object.entries(allCards)
    .filter(([k]) => k !== primaryKey)
    .map(([, v]) => v)
    .join("");

  const content = `
    <style nonce="${CSP_NONCE}">
      .hero-dl{padding:4px 0 20px;}
      .hero-dl h1{font-size:22px;font-weight:600;margin:0 0 6px;color:var(--text);letter-spacing:-0.02em;}
      .hero-dl p{font-size:14px;color:var(--muted);margin:0 0 10px;}
      .hero-dl .os-badge{display:inline-flex;align-items:center;gap:6px;background:var(--brand-soft);color:var(--brand-2);border:1px solid var(--brand-border);font-size:11px;padding:3px 10px;border-radius:999px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;}
      .feature-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 24px;}
      @media(max-width:720px){.feature-row{grid-template-columns:repeat(2,1fr);}}
      .feature-card{background:var(--card);border:1px solid var(--card-border);border-radius:var(--radius-md);padding:14px;text-align:left;}
      .feature-card .fc-icon{width:30px;height:30px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--bg-surface);display:inline-flex;align-items:center;justify-content:center;color:var(--brand-2);margin-bottom:8px;}
      .feature-card .fc-title{font-size:12px;font-weight:700;margin-bottom:4px;color:var(--text);}
      .feature-card .fc-desc{font-size:11px;color:var(--muted);line-height:1.45;}
      .wz-icon{width:28px;height:28px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--bg-surface);display:inline-flex;align-items:center;justify-content:center;color:var(--brand-2);flex:none;}
      .wizard-card{position:relative;background:var(--card);border:1px solid var(--brand-border);border-radius:var(--radius-md);padding:22px 20px;margin-bottom:18px;}
      .wizard-card.secondary{border:1px solid var(--card-border);}
      .rec-badge{position:absolute;top:-10px;left:16px;background:var(--brand);color:var(--on-accent);font-size:10px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:0.04em;}
      .step{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;}
      .step:last-child{margin-bottom:0;}
      .step-num{flex-shrink:0;width:26px;height:26px;border-radius:50%;background:var(--brand);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;margin-top:1px;font-family:var(--font-mono);}
      .step-content{font-size:13px;color:var(--text);line-height:1.55;flex:1;}
      .step-content strong{font-weight:600;}
      .dl-btn{display:inline-block;padding:8px 18px;border-radius:8px;background:var(--brand);color:var(--on-accent);text-decoration:none;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:opacity .15s;}
      .dl-btn:hover{opacity:.88;}
      .code-block{position:relative;background:var(--bg-input);border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:9px 60px 9px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text);word-break:break-all;line-height:1.55;}
      .code-block code{background:none;padding:0;font-size:inherit;color:inherit;}
      .copy-btn{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:3px 10px;min-height:0;font-size:11px;cursor:pointer;font-weight:600;}
      .copy-btn:hover{color:var(--text);}
      .toggle-link{background:none;border:none;color:var(--brand-2);cursor:pointer;font-size:13px;font-weight:600;padding:0;min-height:0;margin:10px 0 16px;display:inline-block;}
      .toggle-link:hover{background:none;}
      .toggle-link:hover{text-decoration:underline;}
      .other-platforms{display:none;}
      .other-platforms.show{display:block;}
      .other-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;}
      @media(max-width:720px){.other-grid{grid-template-columns:1fr;}}
      .wizard-card .wz-title{margin:0 0 14px;font-size:15px;display:flex;align-items:center;gap:10px;}
      .wizard-card .wz-title.tight{margin-bottom:6px;}
      .wizard-card .wz-lede{margin:0 0 12px;font-size:13px;color:var(--muted);}
      .wz-more{font-size:11px;color:var(--brand);margin-left:8px;}
      .wz-aside{font-size:10px;color:var(--muted);}
      .wz-after{font-size:12px;color:var(--muted);margin-top:8px;}
      .host-ack{background:var(--card);border:1px solid var(--brand-border);border-radius:var(--radius-md);padding:16px 18px;margin:0 0 22px;}
      .host-ack h3{margin:0 0 6px;font-size:14px;}
      .host-ack p{margin:0 0 10px;font-size:13px;color:var(--text-secondary);line-height:1.55;}
      .host-ack label{display:flex;gap:8px;align-items:flex-start;font-size:13px;cursor:pointer;}
      .host-ack input{width:auto;min-height:0;margin:2px 0 0;flex:none;}
      .host-ack a{color:var(--brand-2);text-decoration:underline;}
      .host-ack .ack-state{font-size:12px;color:var(--muted);margin-top:8px;}
      .host-ack.done{border-color:var(--card-border);}
      .needs-host-ack{opacity:.45;pointer-events:none;user-select:none;}
    </style>

    <!-- ── Hero ──────────────────────────────────────────────────────── -->
    <div class="hero-dl">
      <h1>Get EdgeCoder</h1>
      <p>Install the agent on your machines. Run your own work on them, free.</p>
      <span class="os-badge">Detected: ${osLabels[detectedOS] || "Unknown"}</span>
    </div>

    <div class="callout" id="hostingNote">
      <h3>Hosting for others is by request during early access</h3>
      <div class="muted">Machines you install the agent on run your own work ("My machines", free). Taking work from other people, and being paid for it, needs an invitation while the network is in early access. <a href="/host#request">Request to host</a>.</div>
    </div>

    <!-- ── Feature cards ─────────────────────────────────────────────── -->
    <div class="feature-row">
      <div class="feature-card">
        <div class="fc-icon">${icon("globe", 14)}</div>
        <div class="fc-title">P2P Mesh Network</div>
        <div class="fc-desc">Your device joins a global peer-to-peer mesh for distributed AI inference.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">${icon("zap", 14)}</div>
        <div class="fc-title">Your machines, free</div>
        <div class="fc-desc">Run models and code jobs on your own machines at no cost. Invited hosts also earn sats for other people's work.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">${icon("shield", 14)}</div>
        <div class="fc-title">Private &amp; Local-First</div>
        <div class="fc-desc">Code and prompts stay on your machine. Inference runs locally when possible.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">${icon("server", 14)}</div>
        <div class="fc-title">Multi-Platform</div>
        <div class="fc-desc">macOS, Windows, Linux, iOS, Docker, and VS Code — one mesh everywhere.</div>
      </div>
    </div>

    <!-- ── Host Agreement (DRAFT pending legal review): accepted before the install steps ── -->
    <div class="host-ack" id="hostAck" data-legal-draft="true">
      <h3>Before you install: the Host Agreement</h3>
      <p>${escapeHtml(NOTICES.hosting)} The <a href="/host-agreement" target="_blank" rel="noopener">Host Agreement</a> (a draft pending legal review) explains resources used, payouts and holds.</p>
      <label for="hostAckBox"><input id="hostAckBox" type="checkbox" /><span>I agree to the <a href="/host-agreement" target="_blank" rel="noopener">Host Agreement</a> for every machine I install EdgeCoder on.</span></label>
      <div class="ack-state" id="hostAckState">Accept to see the install steps.</div>
    </div>

    <div id="installSteps" class="needs-host-ack" aria-disabled="true">
    <!-- ── Primary platform card ─────────────────────────────────────── -->
    ${primaryCard}

    <!-- ── Other platforms toggle ─────────────────────────────────────── -->
    <button class="toggle-link" id="toggle-others">Show other platforms</button>
    <div class="other-platforms" id="other-platforms">
      <div class="other-grid">
        ${secondaryCards}
      </div>
    </div>
    </div>
  `;

  const script = `
    requireAuth().then(revealSettingsAdminTab).catch(() => {});

    // Host Agreement: the install steps unlock once the current version is accepted (stored per account).
    var HOST_AGREEMENT_VERSION = ${JSON.stringify(HOST_AGREEMENT_VERSION)};
    function unlockInstall(atMs) {
      var steps = document.getElementById('installSteps');
      steps.classList.remove('needs-host-ack'); steps.removeAttribute('aria-disabled');
      document.getElementById('hostAck').classList.add('done');
      var box = document.getElementById('hostAckBox'); box.checked = true; box.disabled = true;
      document.getElementById('hostAckState').textContent = 'Accepted (version ' + HOST_AGREEMENT_VERSION + (atMs ? ', ' + new Date(atMs).toLocaleString() : '') + ').';
    }
    api('/portal/api/legal', { method: 'GET', headers: {} }).then(function (r) {
      if (r && r.hostAgreementCurrent) unlockInstall(r.accepted && r.accepted.hostAgreementAcceptedAtMs);
    }).catch(function () {});
    document.getElementById('hostAckBox').addEventListener('change', function (e) {
      if (!e.target.checked) return;
      api('/portal/api/legal/accept', { method: 'POST', body: JSON.stringify({ document: 'host-agreement', version: HOST_AGREEMENT_VERSION }) })
        .then(function (r) { unlockInstall(r && r.acceptedAtMs); })
        .catch(function (err) { e.target.checked = false; document.getElementById('hostAckState').textContent = 'Could not record acceptance: ' + String(err.message || err); });
    });

    function copyCmd(id) {
      var el = document.getElementById(id);
      if (!el) return;
      var text = el.textContent.replace(/Copy$/, '').replace(/Copied!$/, '').trim();
      navigator.clipboard.writeText(text).then(function() {
        var btn = el.querySelector('.copy-btn');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Copy'; }, 2000); }
      });
    }
    document.querySelectorAll('.copy-btn[data-copy]').forEach(function(btn) {
      btn.addEventListener('click', function() { copyCmd(btn.getAttribute('data-copy')); });
    });

    document.getElementById('toggle-others').addEventListener('click', function() {
      var el = document.getElementById('other-platforms');
      var btn = document.getElementById('toggle-others');
      if (!el || !btn) return;
      el.classList.toggle('show');
      btn.textContent = el.classList.contains('show') ? 'Hide other platforms' : 'Show other platforms';
    });
  `;

  // The token is rendered (escaped) on the server; the script no longer rewrites it.
  return reply.type("text/html").send(settingsPage("install", "Install the agent on your own machines.", content, script, { wide: true }));
});

}

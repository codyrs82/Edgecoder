// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { DOCS_SITE_URL, GITHUB_REPO_URL, SUPPORT_EMAIL } from "./urls.js";

// #16: moved verbatim from src/portal/server.ts.
export function marketingHomeHtml(): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder | Private AI Coding on Your Infrastructure</title>
      <meta
        name="description"
        content="EdgeCoder is a privacy-first coding platform that runs on your machines, keeps sensitive code in your environment, and scales with trusted compute when needed."
      />
      <style>
        :root {
          --bg: #1a1a18;
          --bg-soft: #2f2f2d;
          --bg-surface: #3a3a37;
          --bg-elevated: #454542;
          --bg-input: #262624;
          --surface: rgba(58, 58, 55, 0.96);
          --surface-strong: rgba(69, 69, 66, 0.98);
          --card: rgba(58, 58, 55, 0.96);
          --card-border: rgba(214, 204, 194, 0.08);
          --border-strong: rgba(214, 204, 194, 0.15);
          --text: #f7f5f0;
          --text-secondary: #b8b0a4;
          --muted: #8a8478;
          --brand: #c17850;
          --brand-2: #d4895f;
          --ok: #4ade80;
          --danger: #f87171;
          --yellow: #fbbf24;
          --border: rgba(214, 204, 194, 0.08);
          --font-mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body {
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          color: var(--text);
          background: var(--bg);
          -webkit-font-smoothing: antialiased;
        }
        a { color: inherit; text-decoration: none; }
        .shell {
          width: min(1080px, calc(100% - 32px));
          margin: 0 auto;
          padding: 24px 0 60px;
        }
        .nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 24px;
        }
        .brand {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        .mark {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          box-shadow: 0 10px 28px rgba(193, 120, 80, 0.18);
        }
        .nav-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .btn {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 9px 13px;
          font-size: 14px;
          background: var(--bg-soft);
          color: var(--text);
          transition: transform 0.08s ease, border-color 0.12s ease;
        }
        .btn:hover { transform: translateY(-1px); border-color: var(--border-strong); }
        .btn.primary {
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          border-color: rgba(193, 120, 80, 0.72);
          color: #fff;
        }
        .hero {
          border: 1px solid var(--border);
          background: var(--bg-soft);
          border-radius: 18px;
          padding: 34px;
          box-shadow: 0 12px 26px rgba(0, 0, 0, 0.2);
        }
        .eyebrow {
          color: var(--brand);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 11px;
          font-weight: 700;
          margin-bottom: 12px;
        }
        h1 {
          margin: 0 0 10px;
          line-height: 1.1;
          font-size: clamp(32px, 6vw, 50px);
          letter-spacing: -0.02em;
        }
        .lead {
          margin: 0;
          color: var(--text-secondary);
          max-width: 760px;
          font-size: 18px;
          line-height: 1.55;
        }
        .hero-cta {
          margin-top: 18px;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .stat-row {
          margin-top: 20px;
          display: grid;
          grid-template-columns: repeat(3, minmax(160px, 1fr));
          gap: 10px;
        }
        .stat {
          border: 1px solid var(--border);
          background: var(--bg-surface);
          border-radius: 12px;
          padding: 12px;
        }
        .stat b { display: block; font-size: 20px; margin-bottom: 4px; }
        .stat span { color: var(--muted); font-size: 13px; }
        .section {
          margin-top: 16px;
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 24px;
          background: var(--surface);
        }
        .section h2 { margin: 0 0 8px; font-size: 24px; letter-spacing: -0.01em; }
        .section p { margin: 0; color: var(--text-secondary); line-height: 1.6; }
        .grid {
          margin-top: 14px;
          display: grid;
          grid-template-columns: repeat(2, minmax(240px, 1fr));
          gap: 12px;
        }
        .card {
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 14px;
          background: var(--bg-surface);
        }
        .card h3 { margin: 0 0 6px; font-size: 17px; }
        .card p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
        .steps {
          margin: 12px 0 0;
          padding-left: 18px;
          color: var(--text-secondary);
          line-height: 1.65;
        }
        .steps b { color: var(--text); }
        .footer {
          margin-top: 20px;
          border: 1px solid var(--border);
          border-radius: 14px;
          background: var(--surface-strong);
          padding: 18px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .footer-note { color: var(--muted); font-size: 13px; }
        .footer-legal { font-size: 12px; color: var(--muted); margin-top: 6px; }
        .footer-legal a { color: var(--muted); text-decoration: underline; }
        .ok { color: var(--ok); font-weight: 600; }
        @media (max-width: 900px) {
          .hero { padding: 24px; }
          .stat-row { grid-template-columns: 1fr; }
          .grid { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <main class="shell">
        <nav class="nav">
          <div class="brand">
            <span class="mark">E</span>
            <span>EdgeCoder</span>
          </div>
          <div class="nav-actions">
            <a class="btn" href="/portal">Portal</a>
            <a class="btn" href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer">Docs</a>
            <a class="btn" href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
            <a class="btn primary" href="/portal">Get Started</a>
          </div>
        </nav>

        <section class="hero">
          <div class="eyebrow">Decentralized Global Shared Compute</div>
          <h1>What is EdgeCoder?</h1>
          <p class="lead">
            EdgeCoder is a decentralized global shared compute network for AI coding workloads, using bitcoin as the incentive framework.
            You can contribute idle compute and earn rewards, or purchase additional compute by providing bitcoin to the network.
            Those funds are distributed to agents and coordinators based on verified effort actually expended.
          </p>
          <div class="hero-cta">
            <a class="btn primary" href="/portal">Open EdgeCoder Portal</a>
            <a class="btn" href="/portal">Explore Features</a>
          </div>
          <div class="stat-row">
            <div class="stat"><b>Private + public crossover</b><span>Route sensitive workloads privately and overflow to approved public capacity.</span></div>
            <div class="stat"><b>Bitcoin incentive framework</b><span>Compute buyers pay in bitcoin; contributors are rewarded from real network demand.</span></div>
            <div class="stat"><b>Effort-based payouts</b><span>Agents and coordinators are rewarded according to verifiable compute effort.</span></div>
          </div>
        </section>

        <section class="section">
          <h2>How the compute economy works</h2>
          <p>
            EdgeCoder matches demand to decentralized global supply, then prices and distributes rewards
            using transparent network participation signals.
          </p>
          <ol class="steps">
            <li><b>Offer compute:</b> operators contribute CPU/GPU capacity from idle machines.</li>
            <li><b>Buy compute with bitcoin:</b> subscribers and agents provide bitcoin when they need additional workload capacity.</li>
            <li><b>Reward actual effort:</b> payouts flow to agents/coordinators based on measurable work completed.</li>
            <li><b>Govern safely:</b> policy, approvals, and auditable controls remain enforced across private and public paths.</li>
          </ol>
        </section>

        <section class="section">
          <h2>Rolling 24-hour token issuance (non-cumulative)</h2>
          <p>
            Token issuance is recalculated continuously from the last 24 hours of effective contribution and network load.
            It is not a cumulative lifetime allowance. If capacity disappears, issuance share decays as that prior contribution
            rolls out of the 24-hour window.
          </p>
          <ol class="steps">
            <li><b>Daily-based, continuously recalculated:</b> every hour, the system refreshes allocation using the most recent rolling 24 hours.</li>
            <li><b>Performance-weighted share:</b> higher available and reliable compute can earn a larger portion of daily issuance.</li>
            <li><b>Automatic roll-off:</b> if a large GPU provider turns off, their share drops hour by hour as historical contribution expires.</li>
            <li><b>Automatic reallocation:</b> active contributors still offering compute gain relative share as inactive capacity rolls off.</li>
          </ol>
        </section>

        <section class="section">
          <h2>Enterprise controls and trust</h2>
          <div class="grid">
            <article class="card">
              <h3>Private policy boundaries</h3>
              <p>Define what stays private, what can cross into public capacity, and which nodes are eligible.</p>
            </article>
            <article class="card">
              <h3>Contributor incentive alignment</h3>
              <p>Idle compute providers are rewarded from real workload demand, denominated via bitcoin-linked settlement flows.</p>
            </article>
            <article class="card">
              <h3>Auditable issuance logic</h3>
              <p>Rolling 24-hour allocation makes rewards responsive to current supply, reliability, and demand conditions.</p>
            </article>
            <article class="card">
              <h3>Operational-grade access control</h3>
              <p>Passkeys, approvals, and service-level governance support professional teams and managed network operations.</p>
            </article>
          </div>
        </section>

        <section class="section">
          <h2>Agent types in the global compute mesh</h2>
          <p>
            EdgeCoder can coordinate many classes of agents as one decentralized execution fabric. The goal is to turn available
            compute worldwide into a single AI CPU/GPU cluster that can serve real workload demand securely.
            Agents can also run local models and make that model capacity available to other nodes in the mesh for truly decentralized inference.
          </p>
          <div class="grid">
            <article class="card">
              <h3>Mobile and edge devices</h3>
              <p>iOS phones and Android devices can contribute idle cycles for lightweight and burstable inference workloads.</p>
            </article>
            <article class="card">
              <h3>Vehicle compute systems</h3>
              <p>Vehicle onboard compute can participate when policy, connectivity, and power constraints allow safe execution.</p>
            </article>
            <article class="card">
              <h3>Servers and GPU clusters</h3>
              <p>Dedicated servers and high-throughput GPU fleets provide the backbone capacity for heavier tasks and queue stability.</p>
            </article>
            <article class="card">
              <h3>Datacenter-scale facilities</h3>
              <p>Entire datacenter facilities can be enrolled as coordinated capacity domains with governance, approval, and audit controls.</p>
            </article>
            <article class="card">
              <h3>Locally hosted model agents</h3>
              <p>Any approved node can run local models and expose that model throughput to other network participants, reducing central dependency.</p>
            </article>
          </div>
        </section>

        <footer class="footer">
          <div>
            <div><strong>EdgeCoder</strong> <span class="ok">online</span></div>
            <div class="footer-note">Private/public compute crossover with rolling 24-hour issuance and bitcoin-linked contributor rewards.</div>
            <div class="footer-legal">&copy; 2025 EdgeCoder, LLC &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></div>
          </div>
          <a class="btn primary" href="/portal">Launch Portal</a>
        </footer>
      </main>
    </body>
  </html>`;
}

export function privacyPolicyHtml(): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Privacy Policy | EdgeCoder</title>
      <meta name="description" content="EdgeCoder Privacy Policy — how we collect, use, and protect your data." />
      <style>
        :root {
          --bg: #1a1a18;
          --bg-soft: #2f2f2d;
          --bg-surface: #3a3a37;
          --bg-elevated: #454542;
          --bg-input: #262624;
          --surface: rgba(58, 58, 55, 0.96);
          --surface-strong: rgba(69, 69, 66, 0.98);
          --card: rgba(58, 58, 55, 0.96);
          --card-border: rgba(214, 204, 194, 0.08);
          --border-strong: rgba(214, 204, 194, 0.15);
          --text: #f7f5f0;
          --text-secondary: #b8b0a4;
          --muted: #8a8478;
          --brand: #c17850;
          --brand-2: #d4895f;
          --ok: #4ade80;
          --danger: #f87171;
          --yellow: #fbbf24;
          --border: rgba(214, 204, 194, 0.08);
          --font-mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body {
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          color: var(--text);
          background: var(--bg);
          -webkit-font-smoothing: antialiased;
        }
        a { color: inherit; text-decoration: none; }
        .shell {
          width: min(1080px, calc(100% - 32px));
          margin: 0 auto;
          padding: 24px 0 60px;
        }
        .nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 24px;
        }
        .brand {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        .mark {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          box-shadow: 0 10px 28px rgba(193, 120, 80, 0.18);
        }
        .nav-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .btn {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 9px 13px;
          font-size: 14px;
          background: var(--bg-soft);
          color: var(--text);
          transition: transform 0.08s ease, border-color 0.12s ease;
        }
        .btn:hover { transform: translateY(-1px); border-color: var(--border-strong); }
        .btn.primary {
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          border-color: rgba(193, 120, 80, 0.72);
          color: #fff;
        }
        .content {
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 32px;
          background: var(--surface);
        }
        .content h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: -0.01em; }
        .content .updated { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
        .content h2 { margin: 28px 0 8px; font-size: 18px; color: var(--text); }
        .content p { margin: 0 0 12px; color: var(--text-secondary); line-height: 1.65; }
        .content ul { margin: 0 0 12px; padding-left: 20px; color: var(--text-secondary); line-height: 1.65; }
        .content li { margin-bottom: 4px; }
        .content a { color: var(--brand-2); text-decoration: underline; }
        .footer {
          margin-top: 20px;
          border: 1px solid var(--border);
          border-radius: 14px;
          background: var(--surface-strong);
          padding: 18px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .footer-note { color: var(--muted); font-size: 13px; }
        .footer-legal { font-size: 12px; color: var(--muted); margin-top: 6px; }
        .footer-legal a { color: var(--muted); text-decoration: underline; }
        .ok { color: var(--ok); font-weight: 600; }
      </style>
    </head>
    <body>
      <main class="shell">
        <nav class="nav">
          <a href="/" class="brand">
            <span class="mark">E</span>
            <span>EdgeCoder</span>
          </a>
          <div class="nav-actions">
            <a class="btn" href="/">Home</a>
            <a class="btn" href="/terms">Terms</a>
            <a class="btn primary" href="/portal">Portal</a>
          </div>
        </nav>

        <div class="content">
          <h1>Privacy Policy</h1>
          <p class="updated">Last updated: February 25, 2025</p>

          <h2>What We Collect</h2>
          <p>EdgeCoder collects the minimum data necessary to operate the platform:</p>
          <ul>
            <li>Account email address</li>
            <li>Passkey credentials (public keys only — we never see your private key)</li>
            <li>Device and agent metadata (OS, version, agent ID) for enrolled nodes</li>
            <li>Task execution metadata (language, duration, success/fail) — we do <strong>not</strong> collect or store your source code</li>
            <li>Wallet and credit balances</li>
            <li>IP address for rate limiting and abuse prevention</li>
          </ul>

          <h2>How We Use It</h2>
          <ul>
            <li><strong>Authentication</strong> — verifying your identity via passkeys</li>
            <li><strong>Task routing and scheduling</strong> — matching code execution requests to available compute nodes</li>
            <li><strong>Billing and credits</strong> — tracking credit usage, issuance, and wallet balances</li>
            <li><strong>Network health monitoring</strong> — ensuring nodes are performing correctly</li>
            <li><strong>Abuse prevention</strong> — detecting and blocking malicious activity</li>
          </ul>

          <h2>What We Don't Do</h2>
          <ul>
            <li>We do <strong>not</strong> sell your data to third parties</li>
            <li>We do <strong>not</strong> serve advertisements</li>
            <li>We do <strong>not</strong> retain your source code after execution completes</li>
            <li>We do <strong>not</strong> track you across third-party websites</li>
          </ul>

          <h2>Data Retention</h2>
          <p>Task metadata (language, duration, success/fail) is retained for billing and network analytics. Source code submitted for execution is <strong>not persisted</strong> beyond the execution lifecycle. You may request full account deletion at any time by contacting us.</p>

          <h2>Cookies</h2>
          <p>EdgeCoder uses session cookies for portal authentication only. We do not use tracking cookies, analytics cookies, or any third-party cookie-based tracking.</p>

          <h2>Third-Party Services</h2>
          <p>We rely on the following third-party services to operate the platform:</p>
          <ul>
            <li><strong>Fly.io</strong> — infrastructure hosting</li>
            <li><strong>Lightning Network</strong> — bitcoin-based payment processing</li>
          </ul>
          <p>These services have their own privacy policies governing data they process on our behalf.</p>

          <h2>Your Rights (GDPR / CCPA)</h2>
          <p>Depending on your jurisdiction, you may have the right to:</p>
          <ul>
            <li><strong>Access</strong> — request a copy of your personal data</li>
            <li><strong>Correction</strong> — update inaccurate information</li>
            <li><strong>Deletion</strong> — request that we delete your account and associated data</li>
            <li><strong>Data portability</strong> — receive your data in a structured, machine-readable format</li>
            <li><strong>Opt-out</strong> — opt out of any non-essential data processing</li>
          </ul>
          <p>To exercise any of these rights, contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

          <h2>Children</h2>
          <p>EdgeCoder is not directed at users under the age of 13. We do not knowingly collect personal information from children. If you believe a child has provided us with personal data, please contact us so we can remove it.</p>

          <h2>Changes to This Policy</h2>
          <p>We may update this Privacy Policy from time to time. When we do, we will revise the "Last updated" date at the top of this page. Continued use of EdgeCoder after changes constitutes acceptance of the updated policy.</p>

          <h2>Contact</h2>
          <p>If you have questions about this Privacy Policy, contact us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
          <p style="margin-top: 4px;">EdgeCoder, LLC</p>
        </div>

        <footer class="footer">
          <div>
            <div><strong>EdgeCoder</strong> <span class="ok">online</span></div>
            <div class="footer-legal">&copy; 2025 EdgeCoder, LLC &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></div>
          </div>
          <a class="btn primary" href="/portal">Launch Portal</a>
        </footer>
      </main>
    </body>
  </html>`;
}

export function termsOfServiceHtml(): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Terms of Service | EdgeCoder</title>
      <meta name="description" content="EdgeCoder Terms of Service — the rules governing use of the EdgeCoder platform." />
      <style>
        :root {
          --bg: #1a1a18;
          --bg-soft: #2f2f2d;
          --bg-surface: #3a3a37;
          --bg-elevated: #454542;
          --bg-input: #262624;
          --surface: rgba(58, 58, 55, 0.96);
          --surface-strong: rgba(69, 69, 66, 0.98);
          --card: rgba(58, 58, 55, 0.96);
          --card-border: rgba(214, 204, 194, 0.08);
          --border-strong: rgba(214, 204, 194, 0.15);
          --text: #f7f5f0;
          --text-secondary: #b8b0a4;
          --muted: #8a8478;
          --brand: #c17850;
          --brand-2: #d4895f;
          --ok: #4ade80;
          --danger: #f87171;
          --yellow: #fbbf24;
          --border: rgba(214, 204, 194, 0.08);
          --font-mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body {
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          color: var(--text);
          background: var(--bg);
          -webkit-font-smoothing: antialiased;
        }
        a { color: inherit; text-decoration: none; }
        .shell {
          width: min(1080px, calc(100% - 32px));
          margin: 0 auto;
          padding: 24px 0 60px;
        }
        .nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 24px;
        }
        .brand {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        .mark {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          box-shadow: 0 10px 28px rgba(193, 120, 80, 0.18);
        }
        .nav-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .btn {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 9px 13px;
          font-size: 14px;
          background: var(--bg-soft);
          color: var(--text);
          transition: transform 0.08s ease, border-color 0.12s ease;
        }
        .btn:hover { transform: translateY(-1px); border-color: var(--border-strong); }
        .btn.primary {
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          border-color: rgba(193, 120, 80, 0.72);
          color: #fff;
        }
        .content {
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 32px;
          background: var(--surface);
        }
        .content h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: -0.01em; }
        .content .updated { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
        .content h2 { margin: 28px 0 8px; font-size: 18px; color: var(--text); }
        .content p { margin: 0 0 12px; color: var(--text-secondary); line-height: 1.65; }
        .content ul { margin: 0 0 12px; padding-left: 20px; color: var(--text-secondary); line-height: 1.65; }
        .content li { margin-bottom: 4px; }
        .content a { color: var(--brand-2); text-decoration: underline; }
        .footer {
          margin-top: 20px;
          border: 1px solid var(--border);
          border-radius: 14px;
          background: var(--surface-strong);
          padding: 18px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .footer-note { color: var(--muted); font-size: 13px; }
        .footer-legal { font-size: 12px; color: var(--muted); margin-top: 6px; }
        .footer-legal a { color: var(--muted); text-decoration: underline; }
        .ok { color: var(--ok); font-weight: 600; }
      </style>
    </head>
    <body>
      <main class="shell">
        <nav class="nav">
          <a href="/" class="brand">
            <span class="mark">E</span>
            <span>EdgeCoder</span>
          </a>
          <div class="nav-actions">
            <a class="btn" href="/">Home</a>
            <a class="btn" href="/privacy">Privacy</a>
            <a class="btn primary" href="/portal">Portal</a>
          </div>
        </nav>

        <div class="content">
          <h1>Terms of Service</h1>
          <p class="updated">Last updated: February 25, 2025</p>

          <h2>1. Acceptance of Terms</h2>
          <p>By accessing or using EdgeCoder ("the Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use the Service.</p>

          <h2>2. Description of Service</h2>
          <p>EdgeCoder is a distributed compute network for AI-assisted code execution. The platform connects users who need code executed with compute nodes operated by network participants. Tasks are routed, scheduled, and executed across enrolled devices.</p>

          <h2>3. Accounts</h2>
          <p>You may create one account per person. Accounts are secured via passkeys (WebAuthn). You are responsible for maintaining the security of your passkey credentials and devices. You must notify us immediately if you believe your account has been compromised.</p>

          <h2>4. Acceptable Use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>Submit or execute malicious code, malware, or code designed to damage, disrupt, or gain unauthorized access to systems</li>
            <li>Abuse compute resources or attempt to consume disproportionate network capacity</li>
            <li>Reverse engineer, decompile, or disassemble any part of the EdgeCoder platform or protocol</li>
            <li>Circumvent security measures, rate limits, or access controls</li>
            <li>Use the Service for any activity that violates applicable law</li>
          </ul>

          <h2>5. Intellectual Property</h2>
          <p>You retain full ownership of any source code you submit for execution on EdgeCoder. EdgeCoder does not claim any rights to your code.</p>
          <p>EdgeCoder, LLC owns all rights to the EdgeCoder platform, branding, protocol, documentation, and related intellectual property. The EdgeCoder name, logo, and marks are trademarks of EdgeCoder, LLC.</p>

          <h2>6. Node Operator Terms</h2>
          <p>If you operate a compute node on the EdgeCoder network:</p>
          <ul>
            <li>There is no guarantee of uptime rewards or specific credit issuance amounts</li>
            <li>Nodes may be removed from the network for policy violations, poor performance, or abuse</li>
            <li>You are responsible for the security and maintenance of your enrolled devices</li>
            <li>You agree to execute tasks in good faith and return accurate results</li>
          </ul>

          <h2>7. Credits and Wallet</h2>
          <p>Credits are internal units used within the EdgeCoder platform. Credits are <strong>not</strong> currency, securities, or financial instruments. There are no guarantees of cash-out, redemption, or conversion to fiat currency. Credit issuance is subject to network rules and may change at any time. Wallet balances reflect internal accounting and do not represent deposits or stored value.</p>

          <h2>8. Disclaimers</h2>
          <p>The Service is provided <strong>"AS IS"</strong> and <strong>"AS AVAILABLE"</strong> without warranties of any kind, whether express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, and non-infringement. EdgeCoder, LLC does not warrant that the Service will be uninterrupted, error-free, or secure, or that results from code execution will be accurate or reliable.</p>

          <h2>9. Limitation of Liability</h2>
          <p>To the maximum extent permitted by applicable law, EdgeCoder, LLC shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits, data, use, or goodwill, arising out of or related to your use of the Service, regardless of the theory of liability.</p>

          <h2>10. Termination</h2>
          <p>Either party may terminate the relationship at any time. You may stop using EdgeCoder and request account deletion by contacting us. We may suspend or terminate your account if you violate these Terms. Upon termination, your right to use the Service ceases immediately. Account data will be deleted upon request.</p>

          <h2>11. Governing Law</h2>
          <p>These Terms shall be governed by and construed in accordance with the laws of the State of Texas, without regard to its conflict-of-law provisions. Any disputes arising from these Terms or the Service shall be resolved in the courts of the State of Texas.</p>

          <h2>12. Changes to These Terms</h2>
          <p>We may update these Terms of Service from time to time. When we do, we will revise the "Last updated" date at the top of this page. Continued use of EdgeCoder after changes constitutes acceptance of the updated terms.</p>

          <h2>13. Contact</h2>
          <p>If you have questions about these Terms, contact us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
          <p style="margin-top: 4px;">EdgeCoder, LLC</p>
        </div>

        <footer class="footer">
          <div>
            <div><strong>EdgeCoder</strong> <span class="ok">online</span></div>
            <div class="footer-legal">&copy; 2025 EdgeCoder, LLC &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></div>
          </div>
          <a class="btn primary" href="/portal">Launch Portal</a>
        </footer>
      </main>
    </body>
  </html>`;
}

export function registerPublicPages(app: FastifyInstance): void {
app.get("/", async (_req, reply) => reply.type("text/html").send(marketingHomeHtml()));
app.get("/privacy", async (_req, reply) => reply.type("text/html").send(privacyPolicyHtml()));
app.get("/terms", async (_req, reply) => reply.type("text/html").send(termsOfServiceHtml()));
}

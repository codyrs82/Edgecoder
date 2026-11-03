// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASE_CSS, TOKENS_CSS, brandMark, icon } from "./design-system.js";
import { HERO_CLASSES, formatSats, formatUsd, referencePricing, type PublicPricing } from "../public-pricing.js";
import { DOCS_SITE_URL, GITHUB_REPO_URL, supportEmail } from "./urls.js";

// #16: moved verbatim from src/portal/server.ts.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Sats-per-hour cell with the USD conversion underneath (reference mode: USD only). */
function priceCell(c: { satsPerHour?: number; usdPerHour: number }): string {
  if (c.satsPerHour === undefined) {
    return `<span class="sats muted">${escapeHtml(formatUsd(c.usdPerHour))}/h</span><span class="usd">sats rate on the live portal</span>`;
  }
  return `<span class="sats">${formatSats(c.satsPerHour)} <small>sats/h</small></span><span class="usd">≈ ${escapeHtml(formatUsd(c.usdPerHour))}/h</span>`;
}

function pricingMeta(p: PublicPricing): string {
  if (p.mode !== "live" || !p.btcUsd) return `<span class="status-badge warn">reference prices</span>`;
  const asOf = p.asOfMs ? new Date(p.asOfMs).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  return `<span class="status-badge info" title="BTC/USD median of four sources${asOf ? ", rate epoch " + asOf : ""}">BTC ${escapeHtml(formatUsd(p.btcUsd))}</span>`;
}

export function marketingHomeHtml(pricing: PublicPricing = referencePricing()): string {
  const byId = new Map(pricing.classes.map((c) => [c.id, c]));
  const heroRows = HERO_CLASSES.map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => `<div class="ticker-row"><span class="pair">${escapeHtml(c.label)} / BTC<span class="cls">${escapeHtml(c.hardware)}</span></span><span class="px">${priceCell(c)}</span><span class="px mono-id">${c.id}</span></div>`)
    .join("");
  // One row per class (its credit-hour), then its weight table: a tier's hour = credit-hour × weight.
  const tableRows = pricing.classes
    .map(
      (c) =>
        `<tr><td class="mono"><b>${c.id}</b></td><td><b>${escapeHtml(c.label)}</b> · ${escapeHtml(c.hardware)}</td><td class="num">1 credit/s</td><td class="num">${priceCell(c)}</td></tr>` +
        c.tiers
          .map((t) => `<tr><td class="mono muted">${t.id}</td><td>${escapeHtml(t.label)}</td><td class="num">${t.creditsPerSecond}×</td><td class="num">${priceCell(t)}</td></tr>`)
          .join("")
    )
    .join("");
  const liveNote = pricing.mode === "live"
    ? "Sats per hour are today's rate epoch: the class's USD reference divided by the BTC/USD median of four exchanges, plus the network markup. Agents' asks and requesters' bids trade around it on the Market page."
    : "Reference USD prices per class. The live sats rate is recalibrated daily from four BTC/USD sources and shown on the portal.";
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder | Private AI Coding on Your Infrastructure</title>
      <meta
        name="description"
        content="EdgeCoder is a decentralized compute network for AI coding workloads, priced and settled in Bitcoin. Contribute idle CPU and GPU time for sats, or buy compute at a daily market rate."
      />
      <style>
        ${TOKENS_CSS}
        ${BASE_CSS}
        .shell { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
        .nav { position: sticky; top: 0; z-index: 30; background: var(--bg); border-bottom: 1px solid var(--card-border); }
        .nav-inner { height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -0.01em; font-size: 15px; }
        .mark { display: inline-flex; align-items: center; justify-content: center; background: var(--brand); }
        .nav-links { display: flex; align-items: center; gap: 4px; }
        .nav-links a { padding: 7px 10px; border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 13px; font-weight: 500; }
        .nav-links a:hover { color: var(--text); background: var(--bg-elevated); }
        .nav-actions { display: flex; gap: 8px; align-items: center; }
        .footer { border-top: 1px solid var(--card-border); margin-top: 56px; padding: 28px 0 40px; }
        .footer-inner { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
        .footer-note { color: var(--muted); font-size: 13px; max-width: 520px; margin-top: 6px; }
        .footer-legal { font-size: 12px; color: var(--muted); margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
        .footer-legal a { color: var(--muted); } .footer-legal a:hover { color: var(--text); }
        .ok { color: var(--ok); font-weight: 600; }
        @media (max-width: 760px) { .nav-links { display: none; } }

        .hero { padding: 72px 0 40px; display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 40px; align-items: center; }
        .hero h1 { font-size: clamp(34px, 5vw, 54px); line-height: 1.08; letter-spacing: -0.025em; margin: 14px 0 16px; }
        .hero .lead { font-size: 17px; color: var(--text-secondary); max-width: 560px; margin-bottom: 24px; line-height: 1.6; }
        .hero-cta { display: flex; gap: 10px; flex-wrap: wrap; }
        .hero-cta .btn { min-height: 40px; padding: 0 16px; font-size: 14px; }
        .ticker { border: 1px solid var(--card-border); border-radius: var(--radius-lg); background: var(--bg-soft); padding: 18px; }
        .ticker-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .ticker-head .eyebrow { color: var(--text-secondary); }
        .ticker-row { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid var(--card-border); font-size: 13px; }
        .ticker-row:first-of-type { border-top: none; }
        .ticker-row .pair { font-weight: 600; }
        .ticker-row .cls { color: var(--muted); font-size: 11px; display: block; }
        .ticker-row .px { font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; }
        .ticker-row .mono-id { color: var(--muted); font-size: 11px; }
        .sats { display: block; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text); white-space: nowrap; }
        .sats small { font-size: 10px; font-weight: 500; color: var(--brand-2); }
        .sats.muted { color: var(--text-secondary); font-weight: 500; }
        .usd { display: block; color: var(--muted); font-size: 11px; font-family: var(--font-mono); white-space: nowrap; }
        .ticker-foot { font-size: 11px; color: var(--muted); margin-top: 10px; }
        .section { padding: 48px 0 0; }
        .section-head { max-width: 640px; margin-bottom: 24px; }
        .section-head h2 { font-size: 26px; letter-spacing: -0.02em; margin: 8px 0 8px; }
        .section-head p { color: var(--text-secondary); font-size: 15px; line-height: 1.6; }
        .features { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        .feature { border: 1px solid var(--card-border); border-radius: var(--radius-md); background: var(--card); padding: 18px; }
        .feature .ic { width: 34px; height: 34px; border-radius: var(--radius-sm); border: 1px solid var(--card-border); background: var(--bg-surface); display: inline-flex; align-items: center; justify-content: center; color: var(--brand-2); margin-bottom: 12px; }
        .feature h3 { font-size: 15px; margin-bottom: 6px; }
        .feature p { color: var(--muted); font-size: 13px; line-height: 1.55; margin: 0; }
        .steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; counter-reset: step; }
        .step { border: 1px solid var(--card-border); border-radius: var(--radius-md); background: var(--card); padding: 18px; position: relative; }
        .step::before { counter-increment: step; content: counter(step, decimal-leading-zero); font-family: var(--font-mono); font-size: 12px; color: var(--brand); display: block; margin-bottom: 10px; }
        .step h3 { font-size: 14px; margin-bottom: 6px; }
        .step p { color: var(--muted); font-size: 13px; line-height: 1.55; margin: 0; }
        .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
        .formula { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.7; border: 1px solid var(--card-border); border-radius: var(--radius-md); background: var(--bg-input); padding: 16px 18px; color: var(--text-secondary); overflow-x: auto; }
        .formula b { color: var(--text); font-weight: 600; }
        .classes { border: 1px solid var(--card-border); border-radius: var(--radius-md); overflow: hidden; }
        .classes table { font-size: 13px; }
        .classes th:first-child, .classes td:first-child { padding-left: 14px; }
        .host-tiers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        .tier { border: 1px solid var(--card-border); border-radius: var(--radius-md); background: var(--card); padding: 18px; }
        .tier .w { font-family: var(--font-mono); font-size: 22px; font-weight: 600; margin: 8px 0 2px; }
        .tier .wl { font-size: 11px; color: var(--muted); letter-spacing: 0.06em; text-transform: uppercase; }
        .tier ul { margin: 12px 0 0; padding-left: 18px; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
        .cta { margin-top: 56px; border: 1px solid var(--card-border); border-radius: var(--radius-lg); background: var(--bg-soft); padding: 32px; display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap; }
        .cta h2 { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 6px; }
        .cta p { color: var(--text-secondary); margin: 0; }
        @media (max-width: 960px) { .hero { grid-template-columns: 1fr; padding-top: 40px; } .features, .steps, .host-tiers { grid-template-columns: 1fr 1fr; } .split { grid-template-columns: 1fr; } }
        @media (max-width: 640px) { .features, .steps, .host-tiers { grid-template-columns: 1fr; } }
      </style>
    </head>
    <body>

        <nav class="nav">
          <div class="shell nav-inner">
            <a class="brand" href="/">${brandMark(28)}<span>EdgeCoder</span></a>
            <div class="nav-links">
              <a href="/#how">How it works</a>
              <a href="/#market">Market</a>
              <a href="/#hosting">Run a node</a>
              <a href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer">Docs</a>
              <a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
            </div>
            <div class="nav-actions">
              <a class="btn" href="/portal">Sign in</a>
              <a class="btn primary" href="/portal#signup">Get started</a>
            </div>
          </div>
        </nav>

      <main class="shell">
        <section class="hero">
          <div>
            <div class="eyebrow" style="color:var(--brand-2);">Decentralized compute · settled in Bitcoin</div>
            <h1>A global market for AI compute, priced in sats.</h1>
            <p class="lead">
              EdgeCoder turns idle machines into a coding swarm. Agents sell measured seconds of CPU and GPU time,
              requesters buy them with Lightning, and every hardware class trades against Bitcoin on an open order book.
              Your code runs on your machines first; only what you allow crosses to approved public capacity.
            </p>
            <div class="hero-cta">
              <a class="btn primary" href="/portal#signup">Create an account</a>
              <a class="btn" href="/portal/download">Run an agent</a>
              <a class="btn ghost" href="#how">How it works ${icon("arrowRight", 14)}</a>
            </div>
          </div>
          <aside class="ticker" aria-label="Reference compute prices">
            <div class="ticker-head"><span class="eyebrow">Compute / BTC</span>${pricingMeta(pricing)}</div>
            ${heroRows}
            <div class="ticker-foot">${liveNote}</div>
          </aside>
        </section>

        <section class="section" id="how">
          <div class="section-head">
            <div class="eyebrow">How it works</div>
            <h2>Measured work, market price, Lightning settlement.</h2>
            <p>No tokens to speculate on. One credit is one server-measured second of work on a known hardware class, and its sats value is locked the moment it is earned.</p>
          </div>
          <div class="steps">
            <div class="step"><h3>Contribute or buy</h3><p>Install the agent to sell idle capacity, or buy credits with a Lightning invoice at the day's market rate.</p></div>
            <div class="step"><h3>Match on the book</h3><p>Agents post an ask per hardware class, tasks carry a bid. A task is claimed only when the ask clears the bid, and it trades at the ask.</p></div>
            <div class="step"><h3>Verify and pay</h3><p>The coordinator measures run time itself, samples results for redundant verification, and credits the worker at the agreed price.</p></div>
            <div class="step"><h3>Withdraw in sats</h3><p>Earned sats are paid to your Lightning wallet on request or automatically to a Lightning address. Infrastructure hosts are paid from the network fee pool.</p></div>
          </div>
        </section>

        <section class="section" id="market">
          <div class="section-head">
            <div class="eyebrow">Pricing</div>
            <h2>Four capability classes, one pair each, priced in sats.</h2>
            <p>Each class has one flat price per credit, converted from public market rates for compute and Bitcoin, recalibrated daily with outlier rejection and a daily move cap, then discovered on the order book. Faster hardware in a class earns more credits per second: a 24 GB GPU-hour is 3.5 GPU credit-hours.</p>
          </div>
          <div class="split">
            <div class="formula">
              <div><b>btcUsd</b> = median(Coinbase, Kraken, Bitstamp, mempool.space)</div>
              <div><b>satsPerCreditHour</b> = usdPerHour(class) / btcUsd × 1e8 × (1 + markup)</div>
              <div><b>satsPerCredit</b> = satsPerCreditHour / 3600 <span style="color:var(--muted);">(flat within a class)</span></div>
              <div><b>credits</b> = seconds × weight(tier) <span style="color:var(--muted);">(base tier 1)</span></div>
              <div style="margin-top:8px;color:var(--muted);">× model size (≤3B 1.0 … &gt;35B 4.0) × modality (vision, thinking) × scarcity</div>
              <div style="margin-top:8px;"><b>trade</b> = agent ask ≤ task bid → priced at the ask, locked on the ledger</div>
            </div>
            <div class="classes">
              <table>
                <thead><tr><th>Class / tier</th><th>Hardware</th><th class="num">Weight</th><th class="num">Hour</th></tr></thead>
                <tbody>
                  ${tableRows}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="section" id="hosting">
          <div class="section-head">
            <div class="eyebrow">Run infrastructure</div>
            <h2>Host the network, earn the fees.</h2>
            <p>A share of every settled task and every purchase goes to a fee pool that is distributed to infrastructure hosts by uptime and by what they run. Hosting a Bitcoin node for the network is paid work.</p>
          </div>
          <div class="host-tiers">
            <div class="tier"><div class="wl">Weight</div><div class="w">1.0×</div><h3>Coordinator</h3><ul><li>Schedules tasks, runs the order book</li><li>Anchors ledger checkpoints</li><li>Serves local inference for chat</li></ul></div>
            <div class="tier"><div class="wl">Weight</div><div class="w">+1.0×</div><h3>Bitcoin node</h3><ul><li>Bitcoin Core or Knots</li><li>Anchoring and fee estimation for the mesh</li><li>Block data for wallets and peers</li></ul></div>
            <div class="tier"><div class="wl">Weight</div><div class="w">+1.0×</div><h3>Lightning node</h3><ul><li>LND or Core Lightning</li><li>Settles purchases and payouts</li><li>Earns routing fees on top</li></ul></div>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div class="eyebrow">Built for teams</div>
            <h2>Private by policy, auditable by design.</h2>
          </div>
          <div class="features">
            <div class="feature"><div class="ic">${icon("shield", 16)}</div><h3>Private policy boundaries</h3><p>Decide what stays on your machines, what may cross into public capacity, and which nodes are eligible to take it.</p></div>
            <div class="feature"><div class="ic">${icon("key", 16)}</div><h3>Signed everything</h3><p>Agents and coordinators hold Ed25519 keys. Requests, results, and ledger records are signed; task payloads are encrypted end to end.</p></div>
            <div class="feature"><div class="ic">${icon("layers", 16)}</div><h3>Anchored ledger</h3><p>A hash-chained ledger of claims, results and earnings, with periodic OP_RETURN checkpoints on Bitcoin for third-party verification.</p></div>
            <div class="feature"><div class="ic">${icon("cpu", 16)}</div><h3>Sandboxed execution</h3><p>Remote code runs in Docker with no network, read-only filesystem and resource limits. No sandbox, no swarm work.</p></div>
            <div class="feature"><div class="ic">${icon("globe", 16)}</div><h3>One mesh, many devices</h3><p>macOS, Linux, Windows, iOS, Docker and VS Code agents; coordinators federate and gossip tasks across regions.</p></div>
            <div class="feature"><div class="ic">${icon("user", 16)}</div><h3>Operational access control</h3><p>Passkeys, SSO, node enrollment tokens, operator approval and admin tooling for managed deployments.</p></div>
          </div>
        </section>

        <section class="cta">
          <div><h2>Start with an account or an agent.</h2><p>Create an account to buy compute and manage your wallet, or install the agent and start earning sats for idle time.</p></div>
          <div class="row"><a class="btn primary" href="/portal#signup">Create account</a><a class="btn" href="/portal/download">Install the agent</a></div>
        </section>
      </main>

        <footer class="footer">
          <div class="shell footer-inner">
            <div>
              <div class="brand">${brandMark(24)}<span>EdgeCoder</span> <span class="status-badge ok" style="margin-left:8px;">online</span></div>
              <div class="footer-note">A compute network settled in Bitcoin: agents sell measured seconds of CPU and GPU time, requesters buy them with sats, and every ledger checkpoint is anchored on-chain.</div>
              <div class="footer-legal"><span>&copy; 2025 EdgeCoder, LLC</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">Source (BUSL-1.1)</a></div>
            </div>
            <a class="btn primary" href="/portal">Open the portal</a>
          </div>
        </footer>

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
        ${TOKENS_CSS}
        ${BASE_CSS}
        .shell { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
        .nav { position: sticky; top: 0; z-index: 30; background: var(--bg); border-bottom: 1px solid var(--card-border); }
        .nav-inner { height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -0.01em; font-size: 15px; }
        .mark { display: inline-flex; align-items: center; justify-content: center; background: var(--brand); }
        .nav-links { display: flex; align-items: center; gap: 4px; }
        .nav-links a { padding: 7px 10px; border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 13px; font-weight: 500; }
        .nav-links a:hover { color: var(--text); background: var(--bg-elevated); }
        .nav-actions { display: flex; gap: 8px; align-items: center; }
        .footer { border-top: 1px solid var(--card-border); margin-top: 56px; padding: 28px 0 40px; }
        .footer-inner { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
        .footer-note { color: var(--muted); font-size: 13px; max-width: 520px; margin-top: 6px; }
        .footer-legal { font-size: 12px; color: var(--muted); margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
        .footer-legal a { color: var(--muted); } .footer-legal a:hover { color: var(--text); }
        .ok { color: var(--ok); font-weight: 600; }
        @media (max-width: 760px) { .nav-links { display: none; } }
        .content { max-width: 760px; margin: 40px auto 0; border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: 32px; background: var(--card); }
        .content h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }
        .content .updated { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
        .content h2 { margin: 28px 0 8px; font-size: 18px; color: var(--text); }
        .content p { margin: 0 0 12px; color: var(--text-secondary); line-height: 1.65; }
        .content ul { margin: 0 0 12px; padding-left: 20px; color: var(--text-secondary); line-height: 1.65; }
        .content li { margin-bottom: 4px; }
        .content a { color: var(--brand-2); text-decoration: underline; }
      </style>
    </head>
    <body>
      <main class="shell">

        <nav class="nav">
          <div class="shell nav-inner">
            <a class="brand" href="/">${brandMark(28)}<span>EdgeCoder</span></a>
            <div class="nav-links">
              <a href="/#how">How it works</a>
              <a href="/#market">Market</a>
              <a href="/#hosting">Run a node</a>
              <a href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer">Docs</a>
              <a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
            </div>
            <div class="nav-actions">
              <a class="btn" href="/portal">Sign in</a>
              <a class="btn primary" href="/portal#signup">Get started</a>
            </div>
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
          <p>To exercise any of these rights, contact <a href="mailto:${supportEmail()}">${supportEmail()}</a>.</p>

          <h2>Children</h2>
          <p>EdgeCoder is not directed at users under the age of 13. We do not knowingly collect personal information from children. If you believe a child has provided us with personal data, please contact us so we can remove it.</p>

          <h2>Changes to This Policy</h2>
          <p>We may update this Privacy Policy from time to time. When we do, we will revise the "Last updated" date at the top of this page. Continued use of EdgeCoder after changes constitutes acceptance of the updated policy.</p>

          <h2>Contact</h2>
          <p>If you have questions about this Privacy Policy, contact us at <a href="mailto:${supportEmail()}">${supportEmail()}</a>.</p>
          <p style="margin-top: 4px;">EdgeCoder, LLC</p>
        </div>


        <footer class="footer">
          <div class="shell footer-inner">
            <div>
              <div class="brand">${brandMark(24)}<span>EdgeCoder</span> <span class="status-badge ok" style="margin-left:8px;">online</span></div>
              <div class="footer-note">A compute network settled in Bitcoin: agents sell measured seconds of CPU and GPU time, requesters buy them with sats, and every ledger checkpoint is anchored on-chain.</div>
              <div class="footer-legal"><span>&copy; 2025 EdgeCoder, LLC</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">Source (BUSL-1.1)</a></div>
            </div>
            <a class="btn primary" href="/portal">Open the portal</a>
          </div>
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
        ${TOKENS_CSS}
        ${BASE_CSS}
        .shell { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
        .nav { position: sticky; top: 0; z-index: 30; background: var(--bg); border-bottom: 1px solid var(--card-border); }
        .nav-inner { height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -0.01em; font-size: 15px; }
        .mark { display: inline-flex; align-items: center; justify-content: center; background: var(--brand); }
        .nav-links { display: flex; align-items: center; gap: 4px; }
        .nav-links a { padding: 7px 10px; border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 13px; font-weight: 500; }
        .nav-links a:hover { color: var(--text); background: var(--bg-elevated); }
        .nav-actions { display: flex; gap: 8px; align-items: center; }
        .footer { border-top: 1px solid var(--card-border); margin-top: 56px; padding: 28px 0 40px; }
        .footer-inner { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
        .footer-note { color: var(--muted); font-size: 13px; max-width: 520px; margin-top: 6px; }
        .footer-legal { font-size: 12px; color: var(--muted); margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
        .footer-legal a { color: var(--muted); } .footer-legal a:hover { color: var(--text); }
        .ok { color: var(--ok); font-weight: 600; }
        @media (max-width: 760px) { .nav-links { display: none; } }
        .content { max-width: 760px; margin: 40px auto 0; border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: 32px; background: var(--card); }
        .content h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }
        .content .updated { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
        .content h2 { margin: 28px 0 8px; font-size: 18px; color: var(--text); }
        .content p { margin: 0 0 12px; color: var(--text-secondary); line-height: 1.65; }
        .content ul { margin: 0 0 12px; padding-left: 20px; color: var(--text-secondary); line-height: 1.65; }
        .content li { margin-bottom: 4px; }
        .content a { color: var(--brand-2); text-decoration: underline; }
      </style>
    </head>
    <body>
      <main class="shell">

        <nav class="nav">
          <div class="shell nav-inner">
            <a class="brand" href="/">${brandMark(28)}<span>EdgeCoder</span></a>
            <div class="nav-links">
              <a href="/#how">How it works</a>
              <a href="/#market">Market</a>
              <a href="/#hosting">Run a node</a>
              <a href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer">Docs</a>
              <a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
            </div>
            <div class="nav-actions">
              <a class="btn" href="/portal">Sign in</a>
              <a class="btn primary" href="/portal#signup">Get started</a>
            </div>
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
          <p>If you have questions about these Terms, contact us at <a href="mailto:${supportEmail()}">${supportEmail()}</a>.</p>
          <p style="margin-top: 4px;">EdgeCoder, LLC</p>
        </div>


        <footer class="footer">
          <div class="shell footer-inner">
            <div>
              <div class="brand">${brandMark(24)}<span>EdgeCoder</span> <span class="status-badge ok" style="margin-left:8px;">online</span></div>
              <div class="footer-note">A compute network settled in Bitcoin: agents sell measured seconds of CPU and GPU time, requesters buy them with sats, and every ledger checkpoint is anchored on-chain.</div>
              <div class="footer-legal"><span>&copy; 2025 EdgeCoder, LLC</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">Source (BUSL-1.1)</a></div>
            </div>
            <a class="btn primary" href="/portal">Open the portal</a>
          </div>
        </footer>
      </main>
    </body>
  </html>`;
}

export interface PublicPagesDeps {
  /** Current public pricing (src/portal/public-pricing.ts); omitted = reference prices. */
  getPricing?: () => Promise<PublicPricing>;
}

export function registerPublicPages(app: FastifyInstance, deps: PublicPagesDeps = {}): void {
app.get("/", async (_req, reply) => {
  const pricing = deps.getPricing ? await deps.getPricing().catch(() => referencePricing()) : referencePricing();
  return reply.type("text/html").send(marketingHomeHtml(pricing));
});
app.get("/privacy", async (_req, reply) => reply.type("text/html").send(privacyPolicyHtml()));
// One-line installers (docs/install.md): served from the image's deploy/ copy, else from GitHub.
for (const name of ["install.sh", "install.ps1"] as const) {
  app.get(`/${name}`, async (_req, reply) => {
    for (const dir of [resolve(process.cwd(), "deploy"), resolve(process.cwd(), "..", "deploy")]) {
      try {
        return reply.type("text/plain; charset=utf-8").header("cache-control", "public, max-age=300").send(readFileSync(resolve(dir, name), "utf8"));
      } catch {
        // try the next location
      }
    }
    return reply.redirect(`${GITHUB_REPO_URL.replace("github.com", "raw.githubusercontent.com")}/main/deploy/${name}`, 302);
  });
}
app.get("/terms", async (_req, reply) => reply.type("text/html").send(termsOfServiceHtml()));
}

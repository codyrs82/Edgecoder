// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASE_CSS, TOKENS_CSS, brandMark, icon } from "./design-system.js";
import { htmlOpenTag, themeHeadTags, themeToggleButton } from "../assets.js";
import { HERO_CLASSES, formatSats, formatUsd, referencePricing, type PublicPricing } from "../public-pricing.js";
import { DOCS_SITE_URL, GITHUB_REPO_URL } from "./urls.js";
import { escapeHtml } from "./escape.js";
import { CSP_NONCE } from "../csp-nonce.js";
import { LEGAL_LINKS, NOTICES } from "../../common/legal-notices.js";
import { PUBLIC_DOCUMENTS } from "../legal/documents.js";
import { renderMarkdown } from "../legal/markdown.js";

/** Sats-per-hour cell with the USD conversion underneath (reference mode: USD only). */
function priceCell(c: { satsPerHour?: number; usdPerHour: number }): string {
  if (c.satsPerHour === undefined) {
    return `<span class="sats muted">${escapeHtml(formatUsd(c.usdPerHour))}/h</span><span class="usd">sats rate on the live portal</span>`;
  }
  return `<span class="sats">${escapeHtml(formatSats(c.satsPerHour))} <small>sats/h</small></span><span class="usd">≈ ${escapeHtml(formatUsd(c.usdPerHour))}/h</span>`;
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
    .map((c) => `<div class="ticker-row"><span class="pair">${escapeHtml(c.label)} / BTC<span class="cls">${escapeHtml(c.hardware)}</span></span><span class="px">${priceCell(c)}</span><span class="px mono-id">${escapeHtml(c.id)}</span></div>`)
    .join("");
  // One row per class (its credit-hour), then its weight table: a tier's hour = credit-hour × weight.
  const tableRows = pricing.classes
    .map(
      (c) =>
        `<tr><td class="mono"><b>${escapeHtml(c.id)}</b></td><td><b>${escapeHtml(c.label)}</b> · ${escapeHtml(c.hardware)}</td><td class="num">1 credit/s</td><td class="num">${priceCell(c)}</td></tr>` +
        c.tiers
          .map((t) => `<tr><td class="mono muted">${escapeHtml(t.id)}</td><td>${escapeHtml(t.label)}</td><td class="num">${escapeHtml(t.creditsPerSecond)}×</td><td class="num">${priceCell(t)}</td></tr>`)
          .join("")
    )
    .join("");
  const liveNote = pricing.mode === "live"
    ? "Sats per hour are today's rate epoch: the class's USD reference divided by the BTC/USD median of four exchanges, plus the network markup. Agents' asks and requesters' bids trade around it on the Market page."
    : "Reference USD prices per class. The live sats rate is recalibrated daily from four BTC/USD sources and shown on the portal.";
  return `<!doctype html>
  ${htmlOpenTag()}
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder | Private AI Coding on Your Infrastructure</title>
      <meta
        name="description"
        content="EdgeCoder is a decentralized compute network for AI coding workloads, priced and settled in Bitcoin. Buy compute at a daily market rate; hosting is by invitation during early access."
      />
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
              <a href="/host">Host with us</a>
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
        <section class="hero">
          <div>
            <div class="eyebrow u-brand-2">Decentralized compute · settled in Bitcoin</div>
            <h1>A global market for AI compute, priced in sats.</h1>
            <p class="lead">
              EdgeCoder turns idle machines into a coding swarm. Agents sell measured seconds of CPU and GPU time,
              requesters buy them with Lightning, and every hardware class trades against Bitcoin on an open order book.
              Your code runs on your machines first; only what you allow crosses to approved public capacity.
            </p>
            <div class="hero-cta">
              <a class="btn primary" href="/portal#signup">Create an account</a>
              <a class="btn" href="/host">Host with us</a>
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
            <div class="step"><h3>Buy or host</h3><p>Fund with Lightning (Bitcoin on-chain coming soon) at the day's market rate. Hosting capacity for others is by invitation during early access.</p></div>
            <div class="step"><h3>Match on the book</h3><p>Agents post an ask per hardware class, tasks carry a bid. A task is claimed only when the ask clears the bid, and it trades at the ask.</p></div>
            <div class="step"><h3>Verify and pay</h3><p>The coordinator measures run time itself, samples results for redundant verification, and credits the worker at the agreed price.</p></div>
            <div class="step"><h3>Withdraw in sats</h3><p>Hosts' earned sats are paid to their Lightning wallet on request or automatically to a Lightning address. Infrastructure hosts are paid from the network fee pool.</p></div>
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
              <div><b>satsPerCredit</b> = satsPerCreditHour / 3600 <span class="u-muted">(flat within a class)</span></div>
              <div><b>credits</b> = seconds × weight(tier) <span class="u-muted">(base tier 1)</span></div>
              <div class="u-mt-8 u-muted">× model size (≤3B 1.0 … &gt;35B 4.0) × modality (vision, thinking) × scarcity</div>
              <div class="u-mt-8"><b>trade</b> = agent ask ≤ task bid → priced at the ask, locked on the ledger</div>
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
            <div class="eyebrow">Infrastructure hosts · by invitation</div>
            <h2>Hosting is by request during early access.</h2>
            <p>We are adding hosts one at a time while the network is in early access. A share of every settled task and every purchase goes to a fee pool; early-access hosts are paid from it by uptime and by what they run, including hosting a Bitcoin node for the network. <a href="/host">Request to host</a>.</p>
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
            <div class="feature"><div class="ic">${icon("globe", 16)}</div><h3>One mesh, many devices</h3><p>macOS, Linux, Windows, iOS, Docker and VS Code agents; coordinators federate and gossip tasks across regions. Offline Macs and iPhones can also reach nearby devices over <a href="/bluetooth">Bluetooth</a> (early).</p></div>
            <div class="feature"><div class="ic">${icon("user", 16)}</div><h3>Operational access control</h3><p>Passkeys, SSO, node enrollment tokens, operator approval of every host and admin tooling for managed deployments.</p></div>
          </div>
        </section>

        <section class="cta">
          <div><h2>Start with an account, or ask to host.</h2><p>Create an account to buy compute and manage your wallet. Want to run a node for the network? Hosting is by invitation during early access: tell us what you would run.</p></div>
          <div class="row"><a class="btn primary" href="/portal#signup">Create account</a><a class="btn" href="/host#request">Request to host</a></div>
        </section>
      </main>

        <footer class="footer">
          <div class="shell footer-inner">
            <div>
              <div class="brand">${brandMark(24)}<span>EdgeCoder</span> <span class="status-badge ok u-ml-8">online</span></div>
              <div class="footer-note">A compute network settled in Bitcoin: agents sell measured seconds of CPU and GPU time, requesters buy them with sats, and every ledger checkpoint is anchored on-chain.</div>
              <div class="footer-legal">${footerLegalLinks()}</div>
            </div>
            <a class="btn primary" href="/portal">Open the portal</a>
          </div>
        </footer>

    </body>
  </html>`;
}

/** Footer links on every public page (the legal drafts and the Bluetooth explainer). */
export function footerLegalLinks(): string {
  return `<span>&copy; 2025 EdgeCoder, LLC</span>${LEGAL_LINKS.map((l) => `<a href="${l.href}">${escapeHtml(l.label.replace(/ of Service| Policy/g, ""))}</a>`).join("")}<a href="/bluetooth">Bluetooth mesh</a><a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">Source (BUSL-1.1)</a>`;
}

/** Nav, footer and document styling shared by the public document pages (legal drafts, Bluetooth). */
function publicDocumentPage(opts: { title: string; description: string; banner?: string; body: string }): string {
  return `<!doctype html>
  ${htmlOpenTag()}
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(opts.title)} | EdgeCoder</title>
      <meta name="description" content="${escapeHtml(opts.description)}" />
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
        .nav-links a:hover { color: var(--text); background: var(--bg-elevated); }
        .nav-actions { display: flex; gap: 8px; align-items: center; }
        .footer { border-top: 1px solid var(--card-border); margin-top: 56px; padding: 28px 0 40px; }
        .footer-inner { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
        .footer-note { color: var(--muted); font-size: 13px; max-width: 520px; margin-top: 6px; }
        .footer-legal { font-size: 12px; color: var(--muted); margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
        .footer-legal a { color: var(--muted); } .footer-legal a:hover { color: var(--text); }
        @media (max-width: 760px) { .nav-links { display: none; } }
        .content { max-width: 760px; margin: 40px auto 0; border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: 32px; background: var(--card); overflow-wrap: anywhere; }
        @media (max-width: 640px) { .content { padding: 20px 16px; } }
        .content h1 { margin: 0 0 12px; font-size: 26px; letter-spacing: -0.02em; }
        .content h2 { margin: 28px 0 8px; font-size: 18px; color: var(--text); }
        .content h3 { margin: 20px 0 6px; font-size: 15px; color: var(--text); }
        .content p { margin: 0 0 12px; color: var(--text-secondary); line-height: 1.65; }
        .content ul, .content ol { margin: 0 0 12px; padding-left: 20px; color: var(--text-secondary); line-height: 1.65; }
        .content li { margin-bottom: 4px; }
        .content a { color: var(--brand-2); text-decoration: underline; }
        .content code { font-family: var(--font-mono); font-size: 12.5px; background: var(--bg-input); padding: 1px 4px; border-radius: 4px; }
        .content blockquote { margin: 0 0 18px; padding: 12px 16px; border: 1px solid var(--card-border); border-left: 3px solid var(--warn); border-radius: var(--radius-sm); background: var(--bg-soft); }
        .content blockquote p:last-child { margin-bottom: 0; }
        .content mark.placeholder { background: var(--brand-soft); color: var(--text); border-radius: 3px; padding: 0 3px; }
        .draft-banner { max-width: 760px; margin: 24px auto 0; padding: 12px 16px; border: 1px solid var(--warn); border-radius: var(--radius-md); background: var(--bg-soft); color: var(--text); font-size: 13px; line-height: 1.5; }
        .draft-banner strong { color: var(--warn); }
        .doc-nav { max-width: 760px; margin: 16px auto 0; display: flex; gap: 6px 14px; flex-wrap: wrap; font-size: 13px; }
        .doc-nav a { color: var(--text-secondary); } .doc-nav a[aria-current="page"] { color: var(--text); font-weight: 600; }
      </style>
    </head>
    <body>
      <nav class="nav">
        <div class="shell nav-inner">
          <a class="brand" href="/">${brandMark(28)}<span>EdgeCoder</span></a>
          <div class="nav-links">
            <a href="/#how">How it works</a>
            <a href="/#market">Market</a>
            <a href="/host">Host with us</a>
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
        ${opts.banner ?? ""}
        <article class="content">
          ${opts.body}
        </article>
      </main>
      <footer class="footer">
        <div class="shell footer-inner">
          <div>
            <div class="brand">${brandMark(24)}<span>EdgeCoder</span></div>
            <div class="footer-note">A compute network settled in Bitcoin: agents sell measured seconds of CPU and GPU time, requesters buy them with sats, and every ledger checkpoint is anchored on-chain.</div>
            <div class="footer-legal">${footerLegalLinks()}</div>
          </div>
          <a class="btn primary" href="/portal">Open the portal</a>
        </div>
      </footer>
    </body>
  </html>`;
}

/** The legal pages: path, page title and description. The text is docs/legal/<key>.md. */
export const LEGAL_PAGES = {
  terms: { path: "/terms", title: "Terms of Service", description: "EdgeCoder Terms of Service (draft pending legal review)." },
  privacy: { path: "/privacy", title: "Privacy Policy", description: "EdgeCoder Privacy Policy (draft pending legal review): what we collect, how hosts see your prompts, retention and your rights." },
  "acceptable-use": { path: "/acceptable-use", title: "Acceptable Use Policy", description: "EdgeCoder Acceptable Use Policy (draft pending legal review)." },
  "host-agreement": { path: "/host-agreement", title: "Host Agreement", description: "EdgeCoder Host Agreement for people who run the agent (draft pending legal review)." }
} as const;
export type LegalPageKey = keyof typeof LEGAL_PAGES;

/** A legal page: the visible DRAFT banner, links between the four documents, then the Markdown. */
export function legalPageHtml(key: LegalPageKey): string {
  const page = LEGAL_PAGES[key];
  const banner = `<div class="draft-banner" role="note" data-legal-draft="true"><strong>DRAFT — pending legal review.</strong> ${escapeHtml(NOTICES.draft.replace(/^DRAFT — pending legal review\. /, ""))}</div>
        <nav class="doc-nav" aria-label="Legal documents">${(Object.keys(LEGAL_PAGES) as LegalPageKey[]).map((k) => `<a href="${LEGAL_PAGES[k].path}"${k === key ? ' aria-current="page"' : ""}>${escapeHtml(LEGAL_PAGES[k].title)}</a>`).join("")}</nav>`;
  return publicDocumentPage({ title: page.title, description: page.description, banner, body: renderMarkdown(PUBLIC_DOCUMENTS[key]) });
}

export const privacyPolicyHtml = (): string => legalPageHtml("privacy");
export const termsOfServiceHtml = (): string => legalPageHtml("terms");
export const acceptableUseHtml = (): string => legalPageHtml("acceptable-use");
export const hostAgreementHtml = (): string => legalPageHtml("host-agreement");

/** /bluetooth: what Bluetooth mesh is for, how it works, what it shares, and what is built (docs/bluetooth-mesh.md). */
export function bluetoothPageHtml(): string {
  return publicDocumentPage({
    title: "Bluetooth mesh",
    description: "How EdgeCoder devices use Bluetooth to get AI work done through nearby peers when offline: what is shared, security, battery, payment and current status.",
    body: renderMarkdown(PUBLIC_DOCUMENTS.bluetooth)
  });
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
// The legal drafts (docs/legal/*.md) and the Bluetooth explainer (docs/bluetooth-mesh.md).
for (const key of Object.keys(LEGAL_PAGES) as LegalPageKey[]) {
  app.get(LEGAL_PAGES[key].path, async (_req, reply) => reply.type("text/html").send(legalPageHtml(key)));
}
app.get("/bluetooth", async (_req, reply) => reply.type("text/html").send(bluetoothPageHtml()));
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
}

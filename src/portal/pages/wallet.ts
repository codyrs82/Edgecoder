// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings > Wallet (/portal/settings/plan): balance and Add funds (Lightning top-up with a live
 * invoice), where your sats go (buying is free unless the coordinator sets a purchase fee; EdgeCoder
 * keeps the 5 % network fee of every compute payment), Earnings & withdrawals
 * (earned, held, available, paid; payout methods; payout history with the asset), and Activity.
 * Design: docs/design/wallet-and-market.md. All numbers come from the coordinator through
 * /portal/api/wallet/overview, /portal/api/wallet/topup and /wallet/payouts*; the page never
 * prices anything itself except the preview of the purchase fee before an invoice exists, which
 * uses the coordinator's own rate (purchaseFeeBps) and is replaced by the invoice's figures.
 *
 * Under the CSP: styles in one nonce'd block, no style attributes, no inline handlers.
 */
import { CSP_NONCE } from "../csp-nonce.js";
import { icon } from "./design-system.js";
import { SETTINGS_HELPERS_SCRIPT } from "./settings-shell.js";

/** Styles shared by the Wallet page and the Compute page's price board. */
export const WALLET_CSS = `
  <style nonce="${CSP_NONCE}">
    .wl { --wl-gap: 16px; }
    .wl-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
    .wl-head .set-title { margin: 0; }
    .net-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
      border: 1px solid var(--border-strong); color: var(--text-secondary); background: var(--bg-elevated); }
    .net-badge .dot { width: 7px; height: 7px; }
    .net-badge.test { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); background: color-mix(in srgb, var(--yellow) 10%, transparent); }
    .net-badge.test .dot { background: var(--yellow); }
    .net-badge.main { color: var(--brand-2); border-color: var(--brand-border); background: var(--brand-soft); }
    .net-badge.main .dot { background: var(--brand); }
    .wl-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: var(--wl-gap); align-items: stretch; margin-bottom: var(--wl-gap); }
    @media (max-width: 1000px) { .wl-grid { grid-template-columns: 1fr; } }
    .wl-card { border: 1px solid var(--card-border); border-radius: 14px; background: var(--card); padding: 22px; min-width: 0; }
    .wl-balance { display: flex; flex-direction: column; gap: 6px;
      background: radial-gradient(120% 90% at 0% 0%, var(--brand-soft), transparent 60%), var(--card); }
    .wl-eyebrow { font-size: 12px; font-weight: 600; color: var(--muted); display: flex; align-items: center; gap: 6px; }
    .wl-amount { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
    .wl-amount .big { font-size: 44px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.05; }
    .wl-amount .unit { font-size: 16px; font-weight: 600; color: var(--text-secondary); }
    .wl-sub { color: var(--text-secondary); font-size: 13px; }
    .wl-faint { color: var(--muted); font-size: 12.5px; line-height: 1.5; }
    .wl-mini { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
    .wl-mini > div { border: 1px solid var(--card-border); border-radius: 10px; padding: 10px 12px; background: var(--bg-surface); }
    .wl-mini .k { font-size: 12px; color: var(--muted); }
    .wl-mini .v { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
    .wl-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: auto; }
    .wl-actions button, .wl-actions .btn { min-height: 38px; padding: 9px 16px; font-size: 13.5px; }
    .wl-card h3 { font-size: 16px; display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .wl-pill { white-space: nowrap; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--card-border); }
    .wl-pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); background: color-mix(in srgb, var(--ok) 10%, transparent); }
    .wl-pill.soon { color: var(--muted); }
    .wl-presets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 14px 0 10px; }
    @media (max-width: 520px) { .wl-presets { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .wl-presets button { min-height: 44px; flex-direction: column; gap: 2px; font-variant-numeric: tabular-nums; }
    .wl-presets button small { font-size: 11px; color: var(--muted); font-weight: 500; }
    .wl-presets button[aria-checked="true"] { border-color: var(--brand); background: var(--brand-soft); color: var(--text); box-shadow: 0 0 0 1px var(--brand) inset; }
    .wl-custom { display: none; margin-bottom: 10px; }
    .wl-custom.show { display: block; }
    .wl-custom label { margin-top: 0; }
    .wl-break { margin: 6px 0 14px; border-top: 1px solid var(--card-border); }
    .wl-break div { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--card-border); font-size: 13.5px; }
    .wl-break dt { color: var(--text-secondary); margin: 0; }
    .wl-break dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; }
    .wl-break dd small { display: block; color: var(--muted); font-size: 11.5px; font-weight: 400; }
    .wl-break .get dt, .wl-break .get dd { color: var(--text); font-weight: 650; font-size: 15px; }
    .wl-break .fee dd { color: var(--text-secondary); }
    .wl-primary { width: 100%; min-height: 44px; font-size: 14.5px; }
    .wl-step[hidden] { display: none; }
    .wl-fund-methods { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 10px; }
    .wl-fund { display: inline-flex; align-items: center; gap: 6px; height: var(--control-md, 28px); padding: 0 10px; border-radius: 999px; border: 1px solid var(--card-border); font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
    .wl-fund.active { border-color: var(--brand); color: var(--text); background: var(--bg-elevated); }
    .wl-fund.soon { border-style: dashed; }
    .wl-fund small { font-weight: 500; }
    .wl-invoice { display: grid; grid-template-columns: 176px minmax(0, 1fr); gap: 16px; align-items: start; margin-top: 12px; }
    @media (max-width: 560px) { .wl-invoice { grid-template-columns: 1fr; } }
    .wl-bolt { width: 176px; height: 176px; border-radius: 14px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
      border: 1px dashed var(--brand-border); background: var(--brand-soft); color: var(--brand-2); text-align: center; font-size: 11.5px; padding: 10px; }
    .wl-bolt svg { width: 34px; height: 34px; }
    .wl-qr { display: block; width: 176px; height: 176px; border-radius: 12px; border: 1px solid var(--card-border); }
    .wl-qr[hidden], .wl-bolt[hidden] { display: none; }
    @media (max-width: 560px) { .wl-qr { width: min(240px, 100%); height: auto; aspect-ratio: 1; margin: 0 auto; } }
    .wl-inv-text { font-family: var(--font-mono); font-size: 12px; line-height: 1.5; word-break: break-all; padding: 10px 12px; border-radius: 10px;
      background: var(--bg-input); border: 1px solid var(--card-border); max-height: 92px; overflow: auto; color: var(--text-secondary); }
    .wl-inv-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .wl-wait { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: var(--bg-surface); border: 1px solid var(--card-border); font-size: 13.5px; }
    .wl-wait .grow { flex: 1; }
    .wl-pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 0 0 var(--brand-border); animation: wl-pulse 1.6s ease-out infinite; flex: none; }
    @keyframes wl-pulse { 0% { box-shadow: 0 0 0 0 var(--brand-border); } 70% { box-shadow: 0 0 0 10px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
    .wl-count { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12.5px; }
    .wl-done { text-align: center; padding: 10px 0 4px; }
    .wl-check { width: 56px; height: 56px; border-radius: 50%; margin: 6px auto 12px; display: flex; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--ok) 14%, transparent); color: var(--ok); animation: wl-pop 360ms cubic-bezier(.2,.9,.3,1.3) both; }
    .wl-check svg { width: 28px; height: 28px; }
    .wl-check.warn { background: color-mix(in srgb, var(--yellow) 14%, transparent); color: var(--yellow); }
    @keyframes wl-pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .wl-done .big { font-size: 28px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .wl-done .wl-break { text-align: left; margin-top: 14px; }
    .wl-err { margin-top: 10px; color: var(--danger-ink); font-size: 13px; }
    .wl-testnote { margin-top: 10px; font-size: 12.5px; color: var(--yellow); display: flex; gap: 6px; align-items: flex-start; }
    .wl-testnote svg { flex: none; margin-top: 2px; }
    /* Where your sats go */
    .wl-flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin: 10px 0 14px; }
    @media (max-width: 760px) { .wl-flow { grid-template-columns: 1fr; } }
    .wl-flow > div { padding: 12px 14px; border: 1px solid var(--card-border); background: var(--bg-surface); position: relative; }
    .wl-flow > div:first-child { border-radius: 10px 0 0 10px; }
    .wl-flow > div:last-child { border-radius: 0 10px 10px 0; }
    @media (max-width: 760px) { .wl-flow > div:first-child { border-radius: 10px 10px 0 0; } .wl-flow > div:last-child { border-radius: 0 0 10px 10px; } }
    .wl-flow .k { font-size: 12px; color: var(--muted); }
    .wl-flow .v { font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; margin: 2px 0; }
    .wl-flow .d { font-size: 12px; color: var(--text-secondary); }
    .wl-split { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--bg-elevated); margin: 8px 0 6px; }
    .wl-split .owner { background: var(--ok); }
    .wl-split .net { background: var(--brand); }
    .wl-split-legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-secondary); }
    .wl-split-legend > span { display: inline-flex; align-items: center; gap: 6px; }
    .wl-split-legend i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
    .wl-split-legend i.owner { background: var(--ok); } .wl-split-legend i.net { background: var(--brand); }
    /* Earnings */
    .wl-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 12px 0 14px; }
    @media (max-width: 860px) { .wl-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .wl-kpis > div { border: 1px solid var(--card-border); border-radius: 12px; padding: 12px 14px; background: var(--card); }
    .wl-kpis .k { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
    .wl-kpis .v { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
    .wl-kpis .d { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .wl-kpis .avail { border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
    .wl-kpis .avail .v { color: var(--ok); }
    .wl-kpis .held .v { color: var(--yellow); }
    .wl-methods { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 8px 0 14px; }
    @media (max-width: 860px) { .wl-methods { grid-template-columns: 1fr; } }
    .wl-method { border: 1px solid var(--card-border); border-radius: 12px; padding: 12px 14px; background: var(--card); display: flex; flex-direction: column; gap: 4px; }
    .wl-method.active { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand) inset; }
    .wl-method.soon { opacity: 0.62; }
    .wl-method .t { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; font-size: 14px; }
    .wl-method .d { font-size: 12.5px; color: var(--muted); line-height: 1.45; }
    .wl-banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; margin: 10px 0; font-size: 13px;
      border: 1px solid color-mix(in srgb, var(--yellow) 45%, transparent); background: color-mix(in srgb, var(--yellow) 8%, transparent); }
    .wl-banner.danger { border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent); }
    .wl-banner svg { flex: none; margin-top: 2px; }
    .wl-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--wl-gap); }
    @media (max-width: 1000px) { .wl-two { grid-template-columns: 1fr; } }
    .wl-card textarea { font-family: var(--font-mono); font-size: 12px; }
    .wl-table-wrap { overflow-x: auto; }
    .wl-asset { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
    .wl-asset small { color: var(--muted); font-weight: 500; }
    td.pos { color: var(--ok); }
    .wl-section-title { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; margin: 28px 0 2px; }
    .wl-skel { display: inline-block; min-width: 4ch; border-radius: 6px; background: var(--bg-elevated); color: transparent; animation: wl-shimmer 1.4s ease-in-out infinite; }
    @keyframes wl-shimmer { 50% { opacity: 0.55; } }
    /* Price board (Compute page) */
    .pb-classes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 10px 0 14px; }
    @media (max-width: 980px) { .pb-classes { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .pb-class { border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; background: var(--card); }
    .pb-class .t { font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; gap: 8px; }
    .pb-class .t small { color: var(--muted); font-weight: 500; font-size: 12px; }
    .pb-class .v { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin-top: 6px; }
    .pb-class .v small { font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: 0; }
    .pb-class .d { font-size: 12.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    @media (prefers-reduced-motion: reduce) {
      .wl-pulse, .wl-check, .wl-skel { animation: none; }
    }
  </style>`;

const presets = [5_000, 20_000, 100_000];

export const WALLET_CONTENT = `
  ${WALLET_CSS}
  <section class="set-section wl" id="sec-plan" data-section="plan">
    <div class="wl-head">
      <h2 class="set-title">Wallet</h2>
      <span class="net-badge" id="netBadge" title="Which Bitcoin network this coordinator settles on"><span class="dot"></span><span id="netBadgeText">Checking network…</span></span>
    </div>
    <p class="set-lead">cSats pay for compute on the network. 1 cSat = 1 sat. Buy cSats with Lightning, see what the network keeps, and withdraw what your machines earn.</p>

    <div class="wl-grid">
      <div class="wl-card wl-balance" aria-labelledby="balanceLabel">
        <div class="wl-eyebrow" id="balanceLabel">${icon("wallet", 14)}Balance</div>
        <div class="wl-amount"><span class="big" id="balanceValue"><span class="wl-skel">00,000</span></span><span class="unit">cSats</span></div>
        <div class="wl-sub" id="balanceUsd">&nbsp;</div>
        <div class="wl-mini">
          <div><div class="k">Earned by your machines</div><div class="v" id="balanceEarned">–</div></div>
          <div><div class="k">Available to withdraw</div><div class="v" id="balancePayable">–</div></div>
        </div>
        <div class="wl-faint" id="balanceNote">Spend it on model calls, code jobs and reserved machines. Models on your own machines are free.</div>
        <div class="wl-actions u-mt-12">
          <button class="primary" id="addFundsBtn">${icon("zap", 14)}Buy cSats</button>
          <a class="btn" href="#earnings" id="withdrawJump">Withdraw</a>
        </div>
      </div>

      <div class="wl-card" id="add-funds">
        <div class="wl-step" id="stepAmount">
          <h3>Buy cSats</h3>
          <div class="wl-fund-methods" role="list" aria-label="How to fund">
            <div class="wl-fund active" role="listitem">${icon("zap", 14)}<span>Fund with Lightning</span></div>
            <div class="wl-fund soon" role="listitem" title="Coming soon">${icon("bitcoin", 14)}<span>Fund with Bitcoin</span><small>Coming soon</small></div>
          </div>
          <div class="wl-faint">Pay from any Lightning wallet. Your cSats arrive the moment the payment lands.</div>
          <div class="wl-testnote hidden" id="launchNote" role="note">${icon("alert", 14)}<span id="launchNoteText"></span></div>
          <div class="wl-presets" role="radiogroup" aria-label="Amount in sats">
            ${presets.map((p, i) => `<button type="button" role="radio" aria-checked="${i === 1 ? "true" : "false"}" data-amount="${p}">${p.toLocaleString("en-US")}<small>sats</small></button>`).join("")}
            <button type="button" role="radio" aria-checked="false" data-amount="custom">Custom<small>100 to 1M</small></button>
          </div>
          <div class="wl-custom" id="customWrap">
            <label for="topupAmount">Amount in sats</label>
            <input id="topupAmount" type="number" inputmode="numeric" min="100" max="1000000" step="1" value="20000" />
          </div>
          <dl class="wl-break" id="breakdown">
            <div><dt>You pay</dt><dd><span id="bdPay">20,000 sats</span><small id="bdPayUsd"></small></dd></div>
            <div class="fee hidden" id="bdFeeRow"><dt id="bdFeeLabel">Purchase fee</dt><dd id="bdFee"></dd></div>
            <div class="get"><dt>You get</dt><dd id="bdGet">20,000 cSats</dd></div>
          </dl>
          <div class="wl-faint u-mb-10" id="bdFreeNote">No purchase fee: 1 sat buys 1 cSat.</div>
          <button class="primary wl-primary" id="topupBtn">Fund with Lightning</button>
          <div class="wl-err hidden" id="topupError" role="alert"></div>
          <div class="wl-testnote hidden" id="topupTestNote">${icon("alert", 14)}<span id="topupTestNoteText"></span></div>
        </div>

        <div class="wl-step" id="stepInvoice" hidden>
          <h3>Scan to pay <span class="wl-pill" id="invoiceNet">Lightning</span></h3>
          <div class="wl-faint" id="invoiceSummary"></div>
          <div class="wl-invoice">
            <div>
              <img class="wl-qr" id="invoiceQr" alt="Lightning payment QR code. Scan it with your wallet." hidden />
              <div class="wl-bolt" id="invoiceQrFallback" aria-hidden="true">${icon("zap", 34)}<span>Open in your Lightning wallet, or copy the payment code</span></div>
            </div>
            <div>
              <div class="wl-inv-text" id="invoiceText" tabindex="0" aria-label="Lightning payment code"></div>
              <div class="wl-inv-actions">
                <button class="primary" id="copyInvoiceBtn">${icon("copy", 14)}<span id="copyInvoiceLabel">Copy payment code</span></button>
                <a class="btn" id="openWalletLink" href="#">${icon("external", 14)}Open in wallet</a>
              </div>
            </div>
          </div>
          <div class="wl-wait" role="status">
            <span class="wl-pulse" aria-hidden="true"></span>
            <span class="grow" id="invoiceStatus">Waiting for payment…</span>
            <span class="wl-count" id="invoiceCountdown"></span>
          </div>
          <div class="u-mt-10"><button class="ghost sm" id="invoiceBackBtn">Choose another amount</button></div>
        </div>

        <div class="wl-step" id="stepPaid" hidden>
          <div class="wl-done">
            <div class="wl-check">${icon("check", 28)}</div>
            <div class="wl-eyebrow u-center">Payment received</div>
            <div class="big" id="paidAmount"></div>
            <dl class="wl-break" id="paidBreakdown">
              <div><dt>You paid</dt><dd id="paidPay"></dd></div>
              <div class="fee hidden" id="paidFeeRow"><dt id="paidFeeLabel">Purchase fee</dt><dd id="paidFee"></dd></div>
              <div class="get"><dt>Added to your balance</dt><dd id="paidGet"></dd></div>
              <div><dt>New balance</dt><dd id="paidBalance">–</dd></div>
            </dl>
            <button class="primary wl-primary" id="paidDoneBtn">Done</button>
          </div>
        </div>

        <div class="wl-step" id="stepExpired" hidden>
          <div class="wl-done">
            <div class="wl-check warn">${icon("clock", 28)}</div>
            <div class="big">This payment code expired</div>
            <p class="wl-faint u-mt-6">Nothing was charged. Get a new code to try again.</p>
            <div class="wl-actions u-mt-12">
              <button class="primary wl-primary" id="retryInvoiceBtn">New payment code</button>
              <button class="ghost wl-primary" id="expiredBackBtn">Change amount</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="wl-card">
      <h3>Where your sats go</h3>
      <div class="wl-faint">Adding funds is free. When you use compute on someone else's machine, 95 % goes to that machine's owner and EdgeCoder keeps 5 %. Nothing else is taken.</div>
      <div class="wl-flow">
        <div><div class="k">You pay</div><div class="v" id="flowPay">20,000 sats</div><div class="d">From any Lightning wallet</div></div>
        <div><div class="k" id="flowFeeLabel">Purchase fee · free</div><div class="v" id="flowFee">0 sats</div><div class="d" id="flowFeeDesc">Buying cSats costs nothing</div></div>
        <div><div class="k">Your balance</div><div class="v" id="flowGet">20,000 cSats</div><div class="d">Spent per token on model calls, per second on jobs</div></div>
      </div>
      <div class="wl-sub">When you spend cSats on someone else's machine</div>
      <div class="wl-split" role="img" id="splitBar" aria-label="95 % to the machine's owner, 5 % kept by EdgeCoder"><span class="owner" id="splitOwner"></span><span class="net" id="splitNet"></span></div>
      <div class="wl-split-legend">
        <span><i class="owner"></i><span id="splitOwnerText">95 % to the machine's owner (the compute host)</span></span>
        <span><i class="net"></i><span id="splitNetText">5 % kept by EdgeCoder (the network fee)</span></span>
      </div>
      <div class="wl-faint u-mt-8">Work on your own machines costs nothing. Failed work is not charged.</div>
    </div>

    <h2 class="wl-section-title" id="earnings">Earnings &amp; withdrawals</h2>
    <p class="set-lead">What your machines earned: 95 % of what their work was paid (EdgeCoder keeps 5 %). Purchased cSats can be spent but not withdrawn.</p>
    <div class="wl-banner danger hidden" id="payoutPausedBanner" role="alert">${icon("alert", 16)}<span>Withdrawals are paused on this coordinator while it is checked. Your earnings are safe and keep counting; buying cSats still works.</span></div>
    <div class="wl-kpis">
      <div><div class="k">Earned</div><div class="v" id="payoutEarned">–</div><div class="d">All time</div></div>
      <div class="held"><div class="k">${icon("clock", 12)}Held</div><div class="v" id="payoutHeld">–</div><div class="d" id="payoutHeldNote">Earnings wait before they can leave</div></div>
      <div class="avail"><div class="k">Available</div><div class="v" id="payoutPayable">–</div><div class="d">Ready to withdraw</div></div>
      <div><div class="k">Paid out</div><div class="v" id="payoutPaid">–</div><div class="d" id="payoutPendingNote">&nbsp;</div></div>
    </div>

    <div class="wl-sub">Payout method</div>
    <div class="wl-methods" role="list">
      <div class="wl-method active" role="listitem"><div class="t"><span class="wl-asset">${icon("zap", 15)} Lightning</span> <span class="wl-pill ok">Active</span></div><div class="d">BTC. Withdraw now from any Lightning wallet, or get paid automatically to a Lightning address.</div></div>
      <div class="wl-method soon" role="listitem"><div class="t"><span class="wl-asset">${icon("bitcoin", 15)} Bitcoin on-chain</span> <span class="wl-pill soon">Coming soon</span></div><div class="d">BTC. Batched payouts above a minimum, to your own address. Not available yet.</div></div>
      <div class="wl-method soon" role="listitem"><div class="t"><span class="wl-asset">${icon("layers", 15)} Litecoin on-chain</span> <span class="wl-pill soon">Coming soon</span></div><div class="d">LTC. Batched payouts. Not available yet.</div></div>
    </div>

    <div class="wl-two">
      <div class="wl-card">
        <h3>Withdraw now</h3>
        <div class="wl-faint">In your Lightning wallet, choose Receive for the exact amount, paste its payment code here, and confirm with the code we email you.</div>
        <label for="withdrawInvoice">Your wallet's payment code (starts with lnbc)</label>
        <textarea id="withdrawInvoice" rows="3" placeholder="lnbc…" spellcheck="false" autocomplete="off"></textarea>
        <div class="row u-mt-8"><button class="primary" id="withdrawBtn">Email me a code</button></div>
        <div id="withdrawCodeWrap" class="hidden u-mt-8">
          <label for="withdrawCode">Email code</label>
          <div class="row">
            <input id="withdrawCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" class="u-flex-1" />
            <button class="primary" id="withdrawConfirmBtn">Confirm withdrawal</button>
          </div>
          <div class="wl-faint u-mt-6" id="withdrawCodeInfo"></div>
        </div>
        <div class="wl-faint u-mt-10" id="payoutPolicyNote"></div>
      </div>

      <div class="wl-card" id="payoutDestinationCard">
        <h3>Where should we pay you?</h3>
        <div class="wl-faint">Automatic payouts go to a Lightning address from a wallet you control (it looks like name@wallet-domain.com). EdgeCoder never creates or stores your wallet keys.</div>
        <div id="payoutDestRetired" class="hidden payout-warning">
          The address EdgeCoder generated for this account earlier has been retired because no one holds its keys.
          Nothing was ever paid to it. Your earnings are kept until you set a destination below.
        </div>
        <div id="payoutCallbackChanged" class="hidden payout-warning" role="alert">
          <p class="u-m-0 u-mb-6"><strong id="payoutCallbackText"></strong></p>
          <p class="muted u-m-0 u-mb-6">Payouts to this address are paused and your earnings are kept. Confirm only if your wallet provider moved its servers; otherwise change your address to a wallet you trust.</p>
          <div class="row"><button class="primary" id="payoutCallbackSendBtn">Email me a code</button></div>
          <div id="payoutCallbackCodeWrap" class="hidden u-mt-8">
            <label for="payoutCallbackCode">Email code</label>
            <div class="row">
              <input id="payoutCallbackCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" class="u-flex-1" />
              <button class="primary" id="payoutCallbackConfirmBtn">Confirm payment server</button>
            </div>
          </div>
          <div id="payoutCallbackMsg" class="muted hidden u-mt-6"></div>
        </div>
        <dl class="wl-break u-mt-10">
          <div><dt>Current</dt><dd id="payoutDestCurrent">Loading…</dd></div>
          <div><dt>Network</dt><dd id="payoutDestNetwork">–</dd></div>
        </dl>
        <label for="payoutDestInput">Lightning address</label>
        <div class="row">
          <input id="payoutDestInput" type="text" autocomplete="off" spellcheck="false" placeholder="you@wallet.example" class="u-flex-1" />
          <button class="primary" id="payoutDestSaveBtn">Save</button>
        </div>
        <div id="payoutDestCodeWrap" class="hidden u-mt-8">
          <label for="payoutDestCode">Email code</label>
          <div class="row">
            <input id="payoutDestCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" class="u-flex-1" />
            <button class="primary" id="payoutDestConfirmBtn">Confirm change</button>
          </div>
        </div>
        <div id="payoutDestError" role="alert" class="hidden u-mt-8 u-danger"></div>
        <div id="payoutDestInfo" class="muted hidden u-mt-8"></div>
      </div>
    </div>

    <div class="wl-card u-mt-12">
      <h3>Payout history</h3>
      <div class="wl-table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Asset</th><th>Kind</th><th class="num">Amount (sats)</th><th class="num">Routing fee</th><th>Status</th></tr></thead>
          <tbody id="payoutsBody"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>

    <h2 class="wl-section-title">Activity</h2>
    <p class="set-lead">Every change to your balance, newest first.</p>
    <div class="wl-two">
      <div class="wl-card">
        <h3>Balance changes</h3>
        <div class="wl-table-wrap">
          <table>
            <thead><tr><th>Time</th><th>What</th><th class="num">cSats</th></tr></thead>
            <tbody id="creditHistoryBody"><tr><td colspan="3" class="muted">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="wl-card">
        <h3>Top-ups</h3>
        <div class="wl-table-wrap">
          <table>
            <thead><tr><th>Created</th><th class="num">Paid</th><th class="num">cSats</th><th>Status</th></tr></thead>
            <tbody id="paymentIntentsBody"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="wl-card u-mt-12 hidden" id="sendRequestsCard">
      <h3>Earlier send requests</h3>
      <div class="wl-faint">Requests from the old manual send flow. New withdrawals use Lightning above.</div>
      <div class="wl-table-wrap">
        <table>
          <thead><tr><th>Created</th><th>Destination</th><th class="num">Sats</th><th>Status</th></tr></thead>
          <tbody id="sendRequestsBody"></tbody>
        </table>
      </div>
    </div>
  </section>
`;

/** Formatting and network helpers shared by the Wallet page and the Compute page's price board. */
export const WALLET_HELPERS_SCRIPT = `
    const fmtSats = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
    /** msat as sats with up to 3 decimals, so earnings below 1 sat are not shown as 0. */
    const fmtMsat = (m) => (Number(m || 0) / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
    function fmtUsd(sats, btcUsd) {
      if (!btcUsd || !isFinite(sats)) return "";
      const usd = sats / 1e8 * btcUsd;
      if (usd === 0) return "≈ $0.00";
      return "≈ $" + usd.toLocaleString("en-US", { minimumFractionDigits: usd < 1 ? 3 : 2, maximumFractionDigits: usd < 1 ? 4 : 2 });
    }
    const pct = (bps) => (bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + " %";
    /** The network badge: mainnet is real money, everything else is test sats with no value. */
    function networkInfo(n) {
      if (n === "bitcoin" || n === "mainnet") return { label: "Bitcoin mainnet · real sats", tone: "main", test: false, short: "mainnet" };
      if (n === "regtest") return { label: "Regtest · test sats, no value", tone: "test", test: true, short: "regtest" };
      if (n === "signet" || n === "testnet") return { label: (n === "signet" ? "Signet" : "Testnet") + " · test sats, no value", tone: "test", test: true, short: n };
      return { label: "Unknown network", tone: "", test: true, short: String(n || "unknown") };
    }
    function renderNetBadge(n) {
      const info = networkInfo(n);
      const b = document.getElementById("netBadge");
      if (!b) return info;
      b.classList.remove("main", "test");
      if (info.tone) b.classList.add(info.tone);
      document.getElementById("netBadgeText").textContent = info.label;
      return info;
    }
`;

export const WALLET_SCRIPT = SETTINGS_HELPERS_SCRIPT + WALLET_HELPERS_SCRIPT + `
    const $ = (id) => document.getElementById(id);
    const state = { overview: null, amount: 20000, intent: null, poll: null, tick: null, expiresAt: 0, net: null, feeBps: null };
    function fmtTime(ms) { return ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–"; }
    const KINDS = { withdraw: "Withdrawal", auto: "Automatic", fee_pool: "Host share" };
    const REASONS = {
      credit_purchase: "Bought cSats", inference_reserve: "Model call (set aside)", inference: "Model call", task_submit: "Code job (set aside)",
      task_submit_refund: "Unused set-aside returned", compute_reservation: "Reserved a machine", reservation_refund: "Reservation time returned",
      compute_contribution: "Earned running jobs", reservation_earning: "Earned from a reservation", payout: "Withdrawal",
      payout_refund: "Withdrawal returned", payout_fee_excess: "Withdrawal routing fee", fee_pool_distribution: "Infrastructure host share", faucet: "Test sats grant"
    };
    function reasonText(r) { const base = String(r || "").replace(/:.*/, ""); return REASONS[base] || base.replace(/_/g, " ") || "–"; }

    /* ── Add funds ── */
    // The coordinator's purchase fee; 0 (free) is the default when it does not say.
    function feeBps() { return state.feeBps === null ? 0 : state.feeBps; }
    function preview(amount) { const fee = Math.floor(amount * feeBps() / 10000); return { fee, get: amount - fee }; }
    function btc() { return state.overview && state.overview.btcUsd; }
    function renderBreakdown() {
      const a = state.amount;
      const valid = Number.isInteger(a) && a >= 100 && a <= 1000000;
      const p = preview(valid ? a : 0);
      const approx = state.feeBps === null ? "≈ " : "";
      $("bdPay").textContent = valid ? fmtSats(a) + " sats" : "100 to 1,000,000 sats";
      $("bdPayUsd").textContent = valid ? fmtUsd(a, btc()) : "";
      const charged = feeBps() > 0;
      $("bdFeeRow").classList.toggle("hidden", !charged);
      $("bdFreeNote").classList.toggle("hidden", charged);
      $("bdFeeLabel").textContent = "Purchase fee (" + pct(feeBps()) + ")";
      $("bdFee").textContent = valid ? "− " + approx + fmtSats(p.fee) + " sats" : "–";
      $("bdGet").textContent = valid ? (charged ? approx : "") + fmtSats(p.get) + " cSats" : "–";
      $("flowPay").textContent = valid ? fmtSats(a) + " sats" : "–";
      $("flowFeeLabel").textContent = "Purchase fee · " + (charged ? pct(feeBps()) : "free");
      $("flowFeeDesc").textContent = charged ? "Set by this coordinator and kept by it" : "Buying cSats costs nothing";
      $("flowFee").textContent = valid ? fmtSats(p.fee) + " sats" : "–";
      $("flowGet").textContent = valid ? fmtSats(p.get) + " cSats" : "–";
      $("topupBtn").disabled = !valid;
      $("topupBtn").textContent = valid ? "Buy " + fmtSats(a) + " cSats with Lightning" : "Enter 100 to 1,000,000 sats";
    }
    function pickAmount(btn) {
      for (const b of document.querySelectorAll(".wl-presets button")) b.setAttribute("aria-checked", b === btn ? "true" : "false");
      const v = btn.getAttribute("data-amount");
      const custom = v === "custom";
      $("customWrap").classList.toggle("show", custom);
      if (custom) { $("topupAmount").focus(); state.amount = Math.round(Number($("topupAmount").value)); }
      else state.amount = Number(v);
      renderBreakdown();
    }
    for (const b of document.querySelectorAll(".wl-presets button")) {
      b.addEventListener("click", () => pickAmount(b));
      b.addEventListener("keydown", (e) => {
        const all = [...document.querySelectorAll(".wl-presets button")];
        const i = all.indexOf(b);
        const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? all[(i + 1) % all.length] : e.key === "ArrowLeft" || e.key === "ArrowUp" ? all[(i - 1 + all.length) % all.length] : null;
        if (next) { e.preventDefault(); next.focus(); pickAmount(next); }
      });
    }
    $("topupAmount").addEventListener("input", () => { const n = Number($("topupAmount").value); state.amount = Number.isFinite(n) ? n : 0; renderBreakdown(); });
    function showStep(id) { for (const s of ["stepAmount", "stepInvoice", "stepPaid", "stepExpired"]) $(s).hidden = s !== id; }
    function stopPolling() { clearInterval(state.poll); clearInterval(state.tick); state.poll = null; state.tick = null; }
    function topupError(text) { const e = $("topupError"); e.textContent = text || ""; e.classList.toggle("hidden", !text); }
    const TOPUP_ERRORS = {
      payments_disabled: "Buying cSats is turned off on this coordinator.", invalid_amount: "Enter whole sats from 100 to 1,000,000.",
      launch_buy_daily_cap: "Early access: you reached today's purchase limit.", launch_balance_cap: "Early access: that would take your balance over the early-access limit.",
      no_coordinator: "No coordinator is reachable right now. Try again in a minute.", coordinator_unreachable: "No coordinator is reachable right now. Try again in a minute.",
      not_authenticated: "Your session ended. Sign in again."
    };
    async function createInvoice() {
      topupError("");
      const btn = $("topupBtn");
      btn.disabled = true; btn.textContent = "Preparing payment…";
      const r = await call("/portal/api/wallet/topup", { method: "POST", body: JSON.stringify({ amountSats: state.amount }) }).catch(() => ({ ok: false, json: {} }));
      renderBreakdown();
      // A soft-launch refusal carries its own sentence (with the sats still allowed).
      if (!r.ok || !r.json.invoice) { topupError((/^launch_/.test(r.json.error || "") && r.json.detail) || TOPUP_ERRORS[r.json.error] || "Could not create the invoice (" + (r.json.error || r.status || "network error") + ")."); return; }
      state.intent = r.json;
      state.expiresAt = Date.now() + Number(r.json.expiresInSeconds || 0) * 1000;
      const net = networkInfo(r.json.network);
      $("invoiceNet").textContent = net.test ? net.short + " · test sats" : "Lightning · mainnet";
      $("invoiceNet").className = "wl-pill" + (net.test ? "" : " ok");
      $("invoiceSummary").textContent = "Pay " + fmtSats(r.json.amountSats) + " sats" + (fmtUsd(r.json.amountSats, btc()) ? " (" + fmtUsd(r.json.amountSats, btc()) + ")" : "") + ". You get " + fmtNum(r.json.cSats, 3) + " cSats" + (r.json.feeSats > 0 ? " after the " + fmtSats(r.json.feeSats) + " sat purchase fee." : "; there is no purchase fee.");
      $("invoiceText").textContent = r.json.invoice;
      // The server's QR (an SVG built from the BOLT11 only) goes in as an image: no markup enters the page.
      const qr = typeof r.json.qrSvg === "string" && r.json.qrSvg.startsWith("<svg") ? r.json.qrSvg : "";
      $("invoiceQr").hidden = !qr;
      $("invoiceQrFallback").hidden = !!qr;
      if (qr) $("invoiceQr").setAttribute("src", "data:image/svg+xml;base64," + btoa(qr)); else $("invoiceQr").removeAttribute("src");
      $("openWalletLink").setAttribute("href", "lightning:" + r.json.invoice);
      $("invoiceStatus").textContent = "Waiting for payment…";
      $("copyInvoiceLabel").textContent = "Copy payment code";
      showStep("stepInvoice");
      stopPolling();
      state.poll = setInterval(checkInvoice, 3000);
      state.tick = setInterval(renderCountdown, 1000);
      renderCountdown();
    }
    function renderCountdown() {
      if (!state.expiresAt) { $("invoiceCountdown").textContent = ""; return; }
      const s = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
      $("invoiceCountdown").textContent = s > 0 ? "Expires in " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : "Expiring…";
      if (s === 0) checkInvoice(true);
    }
    async function checkInvoice(final) {
      if (!state.intent) return;
      const r = await call("/portal/api/wallet/topup/" + encodeURIComponent(state.intent.intentId)).catch(() => null);
      if (!r || !r.ok) return;
      if (r.json.status === "settled") return paid(r.json);
      if (r.json.status === "expired" || (final === true && Date.now() > state.expiresAt + 15000)) { stopPolling(); showStep("stepExpired"); }
    }
    async function paid(status) {
      stopPolling();
      const i = state.intent;
      $("paidAmount").textContent = "+" + fmtNum(status.cSats ?? i.cSats, 3) + " cSats";
      $("paidPay").textContent = fmtSats(i.amountSats) + " sats";
      $("paidFeeRow").classList.toggle("hidden", !(i.feeSats > 0));
      $("paidFeeLabel").textContent = "Purchase fee (" + pct(i.amountSats ? Math.round(i.feeSats / i.amountSats * 10000) : feeBps()) + ")";
      $("paidFee").textContent = "− " + fmtSats(i.feeSats) + " sats";
      $("paidGet").textContent = fmtNum(status.cSats ?? i.cSats, 3) + " cSats";
      showStep("stepPaid");
      await loadOverview();
      if (state.overview && state.overview.cSats !== null) $("paidBalance").textContent = fmtNum(state.overview.cSats) + " cSats";
      if (typeof loadTopTicker === "function") loadTopTicker();
      loadIntents();
    }
    $("topupBtn").addEventListener("click", () => createInvoice().catch((e) => topupError(String(e.message || e))));
    $("addFundsBtn").addEventListener("click", () => { $("add-funds").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }); const c = document.querySelector('.wl-presets button[aria-checked="true"]'); if (c) c.focus(); });
    $("copyInvoiceBtn").addEventListener("click", async () => {
      if (!state.intent) return;
      try { await navigator.clipboard.writeText(state.intent.invoice); $("copyInvoiceLabel").textContent = "Copied"; }
      catch { const sel = window.getSelection(); const range = document.createRange(); range.selectNodeContents($("invoiceText")); sel.removeAllRanges(); sel.addRange(range); $("copyInvoiceLabel").textContent = "Press Ctrl/Cmd+C"; }
      setTimeout(() => { $("copyInvoiceLabel").textContent = "Copy payment code"; }, 1800);
    });
    const backToAmount = () => { stopPolling(); state.intent = null; showStep("stepAmount"); renderBreakdown(); };
    $("invoiceBackBtn").addEventListener("click", backToAmount);
    $("expiredBackBtn").addEventListener("click", backToAmount);
    $("paidDoneBtn").addEventListener("click", backToAmount);
    $("retryInvoiceBtn").addEventListener("click", () => { showStep("stepAmount"); createInvoice().catch((e) => topupError(String(e.message || e))); });

    /* ── Early access (LAUNCH_MODE=invite on the coordinator: src/economy/launch-gate.ts) ── */
    function launchText(l) {
      if (!l || l.mode !== "invite") return "";
      const parts = [];
      if (l.maxBuySatsPerDay > 0) parts.push("up to " + fmtSats(l.maxBuySatsPerDay) + " sats per day" + (l.boughtWindowSats ? " (" + fmtSats(Math.max(0, l.maxBuySatsPerDay - l.boughtWindowSats)) + " left today)" : ""));
      if (l.maxBalanceSats > 0) parts.push("a balance of up to " + fmtSats(l.maxBalanceSats) + " cSats");
      if (l.maxPayoutSatsPerDay > 0) parts.push("withdrawals of up to " + fmtSats(l.maxPayoutSatsPerDay) + " sats per day");
      return parts.length ? "Early access: " + parts.join(", ") + "." : "";
    }
    function renderLaunch(l) {
      const text = launchText(l);
      $("launchNote").classList.toggle("hidden", !text);
      $("launchNoteText").textContent = text;
    }

    /* ── Overview: balance, network, fees, earnings ── */
    function renderOverview(o) {
      state.overview = o;
      state.feeBps = o.fees && o.fees.purchaseFeeBps !== null && o.fees.purchaseFeeBps !== undefined ? o.fees.purchaseFeeBps : null;
      const net = renderNetBadge(o.network);
      $("topupTestNote").classList.toggle("hidden", !net.test);
      $("topupTestNoteText").textContent = net.test ? "This coordinator runs on " + net.short + ". Pay with a " + net.short + " wallet; these sats have no value." : "";
      renderLaunch(o.launch);
      if (o.connected && o.cSats !== null) {
        $("balanceValue").textContent = fmtNum(o.cSats);
        $("balanceUsd").textContent = (fmtUsd(o.cSats, o.btcUsd) || "") + (o.btcUsd ? " · BTC $" + fmtSats(o.btcUsd) + (o.rateStale ? " (rate is stale)" : "") : "");
      } else {
        $("balanceValue").textContent = "–";
        $("balanceUsd").textContent = "Not connected to the network right now. Your balance is safe; try again in a minute.";
      }
      // The payout balance carries msat; earnedSats is whole sats only, so it is the fallback.
      const earnedMsat = o.payouts && o.payouts.balance ? o.payouts.balance.earnedMsat : null;
      $("balanceEarned").textContent = earnedMsat !== null && earnedMsat !== undefined ? fmtMsat(earnedMsat) + " sats" : o.earnedSats !== null ? fmtSats(o.earnedSats) + " sats" : "–";
      const nf = o.fees && o.fees.networkFeeBps !== null && o.fees.networkFeeBps !== undefined ? o.fees.networkFeeBps : 500;
      $("splitOwnerText").textContent = pct(10000 - nf) + " to the machine's owner (the compute host)";
      $("splitNetText").textContent = pct(nf) + " kept by EdgeCoder (the network fee)";
      $("splitBar").setAttribute("aria-label", pct(10000 - nf) + " to the machine's owner, " + pct(nf) + " kept by EdgeCoder");
      // The bar's proportions: flex-grow set through CSSOM (allowed under the CSP; no style attribute in markup).
      $("splitOwner").style.flexGrow = String(10000 - nf); $("splitNet").style.flexGrow = String(nf);
      renderPayouts(o.payouts);
      renderLedger(o.recent || []);
      renderBreakdown();
    }
    function renderPayouts(p) {
      const b = (p && p.balance) || {};
      const pol = (p && p.policy) || {};
      $("payoutEarned").textContent = p ? fmtMsat(b.earnedMsat) + " sats" : "–";
      $("payoutHeld").textContent = p ? fmtMsat(b.heldMsat) + " sats" : "–";
      $("payoutHeldNote").textContent = b.heldMsat > 0 && b.maturesAtMs ? "Next becomes available " + fmtTime(b.maturesAtMs) : (pol.network === "bitcoin" ? "Earnings wait 24 h before they can leave" : "No hold on this network");
      $("payoutPayable").textContent = p ? fmtMsat(b.payableMsat) + " sats" : "–";
      $("balancePayable").textContent = p ? fmtMsat(b.payableMsat) + " sats" : "–";
      $("payoutPaid").textContent = p ? fmtMsat(b.paidMsat) + " sats" : "–";
      $("payoutPendingNote").textContent = b.pendingMsat > 0 ? fmtMsat(b.pendingMsat) + " sats on the way" : "\\u00a0";
      const paused = pol.paused === true;
      $("payoutPausedBanner").classList.toggle("hidden", !paused);
      $("withdrawBtn").disabled = paused || pol.lightningEnabled === false;
      const lim = pol.limits || {};
      const parts = [];
      if (!p) parts.push("Payout details are unavailable right now.");
      else if (pol.lightningEnabled === false) parts.push("Lightning payouts are not enabled on this coordinator yet.");
      else {
        parts.push("Minimum " + fmtSats(pol.minPayoutSats || 0) + " sats.");
        parts.push("Routing fee up to " + pct(pol.maxFeeBps || 0) + " (at least " + fmtSats(pol.minFeeFloorSats || 0) + " sats) is set aside and the unused part returned.");
        if (lim.maxSingleSats) parts.push("Up to " + fmtSats(lim.maxSingleSats) + " sats per payout" + (lim.maxAccountDailySats ? " and " + fmtSats(lim.maxAccountDailySats) + " per 24 h" : "") + ".");
        if (pol.autoMinPayoutSats) parts.push("Automatic payouts start at " + fmtSats(pol.autoMinPayoutSats) + " sats.");
        if (pol.network) parts.push("Network: " + networkInfo(pol.network).short + ".");
      }
      $("payoutPolicyNote").textContent = parts.join(" ");
      const rows = ((p && p.payouts) || []).map((x) => "<tr><td>" + escapeHtml(fmtTime(x.createdAtMs)) + "</td><td><span class='wl-asset'>BTC <small>Lightning</small></span></td><td>" + escapeHtml(KINDS[x.kind] || x.kind) +
        "</td><td class='num'>" + fmtMsat(x.amountMsat) + "</td><td class='num'>" + fmtMsat(x.feeMsat) + "</td><td>" + statusBadge(x.status, x.status === "paid" ? "ok" : x.status === "failed" ? "danger" : "warn") +
        (x.error ? " <span class='muted'>" + escapeHtml(x.error) + "</span>" : "") + "</td></tr>");
      $("payoutsBody").innerHTML = rows.length ? rows.join("") : "<tr><td colspan='6' class='muted'>No payouts yet. Earnings you withdraw show up here.</td></tr>";
    }
    function renderLedger(recent, legacy) {
      const rows = recent.length
        ? recent.map((t) => { const earn = t.type === "earn"; return "<tr><td>" + escapeHtml(fmtTime(t.atMs)) + "</td><td>" + escapeHtml(reasonText(t.reason)) + "</td><td class='num" + (earn ? " pos" : "") + "'>" + (earn ? "+" : "−") + escapeHtml(fmtNum(Math.abs(Number(t.cSats) || 0), 3)) + "</td></tr>"; })
        : (legacy || []).map((t) => "<tr><td>" + escapeHtml(fmtTime(t.timestampMs)) + "</td><td>" + escapeHtml(reasonText(t.reason) + " · " + t.type) + "</td><td class='num'>" + escapeHtml(t.credits) + "</td></tr>");
      $("creditHistoryBody").innerHTML = rows.length ? rows.join("") : "<tr><td colspan='3' class='muted'>Nothing yet. Buy cSats or connect a machine to get started.</td></tr>";
    }
    async function loadOverview() {
      const r = await call("/portal/api/wallet/overview").catch(() => null);
      if (!r || !r.ok) {
        renderNetBadge(null);
        $("balanceValue").textContent = "–";
        $("balanceUsd").textContent = "The wallet could not load (" + ((r && (r.json.error || r.status)) || "network error") + ").";
        $("payoutsBody").innerHTML = "<tr><td colspan='6' class='muted'>Unavailable.</td></tr>";
        return;
      }
      renderOverview(r.json);
    }
    async function loadIntents() {
      const summary = await api("/dashboard/summary", { method: "GET", headers: {} }).catch(() => null);
      const ws = (summary && summary.walletSnapshot) || {};
      const intents = [...(ws.paymentIntents || [])].sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0)).slice(0, 12);
      const rows = intents.map((p) => {
        const tone = p.status === "settled" ? "ok" : p.status === "expired" ? "danger" : "warn";
        const label = p.status === "settled" ? "Paid" : p.status === "expired" ? "Expired" : p.status === "created" ? "Waiting" : p.status;
        return "<tr><td>" + escapeHtml(fmtTime(p.createdAtMs)) + "</td><td class='num'>" + escapeHtml(fmtSats(p.amountSats)) + "</td><td class='num'>" + escapeHtml(fmtNum(p.quotedCredits || 0, 3)) + "</td><td>" + statusBadge(label, tone) + "</td></tr>";
      });
      $("paymentIntentsBody").innerHTML = rows.length ? rows.join("") : "<tr><td colspan='4' class='muted'>No top-ups yet.</td></tr>";
      if (!state.overview || !(state.overview.recent || []).length) renderLedger([], ws.creditHistory || []);
    }
    async function loadSendRequests() {
      const payload = await api("/wallet/send/requests", { method: "GET", headers: {} }).catch(() => ({ requests: [] }));
      const reqs = payload.requests || [];
      $("sendRequestsCard").classList.toggle("hidden", reqs.length === 0);
      $("sendRequestsBody").innerHTML = reqs.map((req) => {
        const tone = req.status === "sent" ? "ok" : req.status === "rejected" ? "danger" : "warn";
        return "<tr><td>" + escapeHtml(fmtTime(req.createdAtMs)) + "</td><td class='mono'>" + escapeHtml(req.destination) + "</td><td class='num'>" + escapeHtml(req.amountSats) + "</td><td>" + statusBadge(req.status, tone) + "</td></tr>";
      }).join("");
    }

    /* ── Withdraw (Lightning): POST { bolt11 } -> 202 { challengeId }, then POST { bolt11, challengeId, emailCode } ── */
    let withdrawChallenge = null;
    function resetWithdrawCode() { withdrawChallenge = null; $("withdrawCodeWrap").classList.add("hidden"); $("withdrawCode").value = ""; }
    async function submitWithdraw(withCode) {
      const bolt11 = $("withdrawInvoice").value.trim();
      if (!bolt11) { showToast("Paste your wallet's payment code first.", true); return; }
      const body = { bolt11 };
      if (withCode) {
        const emailCode = $("withdrawCode").value.trim();
        if (!emailCode || !withdrawChallenge || withdrawChallenge.bolt11 !== bolt11) { showToast("Enter the code from the email, or request a new one.", true); return; }
        body.challengeId = withdrawChallenge.id; body.emailCode = emailCode;
      }
      try {
        const res = await fetch("/wallet/payouts/withdraw", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        let r = {}; try { r = await res.json(); } catch {}
        if (res.status === 202 && r.verificationRequired) {
          withdrawChallenge = { id: r.challengeId, bolt11 };
          $("withdrawCode").value = "";
          $("withdrawCodeInfo").textContent = (r.detail || "We emailed you a code.") + " Amount: " + fmtMsat(r.amountMsat) + " sats.";
          $("withdrawCodeWrap").classList.remove("hidden");
          $("withdrawCode").focus();
          return;
        }
        if (withCode) resetWithdrawCode();
        if (res.ok && r.ok) { showToast("Paid " + fmtMsat(r.payout.amountMsat) + " sats to your wallet."); $("withdrawInvoice").value = ""; }
        else showToast("Withdrawal " + (r.code || r.error || "failed") + (r.detail ? ": " + r.detail : ""), true);
      } catch (err) { showToast("Withdrawal failed: " + String(err.message || err), true); }
      loadOverview();
    }
    $("withdrawBtn").addEventListener("click", () => { resetWithdrawCode(); submitWithdraw(false); });
    $("withdrawConfirmBtn").addEventListener("click", () => submitWithdraw(true));

    /* ── Where we pay you (payout destination) ── */
    let payoutDestChallenge = null;
    function payoutDestMessage(kind, text) {
      const err = $("payoutDestError"), info = $("payoutDestInfo");
      err.classList.add("hidden"); info.classList.add("hidden");
      if (!text) return;
      const target = kind === "error" ? err : info;
      target.textContent = text; target.classList.remove("hidden");
    }
    async function payoutDestRequest(method, body) {
      const res = await fetch("/wallet/payout-destination", { method, credentials: "include", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      let payload = {}; try { payload = await res.json(); } catch {}
      return { status: res.status, payload };
    }
    function originHost(o) { try { return new URL(o).host; } catch { return String(o); } }
    function renderPayoutDest(v) {
      const current = v.destination ? v.destination.destination : null;
      $("payoutDestCurrent").textContent = current || "Not set. Automatic payouts wait until you add one.";
      $("payoutDestNetwork").textContent = networkInfo(v.network).short;
      $("payoutDestRetired").classList.toggle("hidden", !(v.legacyAddressRetired && !current));
      if (current && !$("payoutDestInput").value) $("payoutDestInput").value = current;
      const cc = v.callbackChange;
      $("payoutCallbackChanged").classList.toggle("hidden", !cc);
      if (cc) $("payoutCallbackText").textContent = "Your wallet's payment server changed from " + originHost(cc.previousOrigin) + " to " + originHost(cc.newOrigin) + ". Confirm to keep receiving payouts.";
    }
    let payoutCallbackChallenge = null;
    function payoutCallbackMsg(text, isError) { const m = $("payoutCallbackMsg"); m.textContent = text || ""; m.classList.toggle("hidden", !text); m.classList.toggle("u-danger", !!isError); }
    async function confirmPayoutCallback(withCode) {
      const body = {};
      if (withCode) {
        const emailCode = $("payoutCallbackCode").value.trim();
        if (!emailCode || !payoutCallbackChallenge) { payoutCallbackMsg("Enter the code from the email.", true); return; }
        body.challengeId = payoutCallbackChallenge; body.emailCode = emailCode;
      }
      const res = await fetch("/wallet/payout-destination/callback/confirm", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      let r = {}; try { r = await res.json(); } catch {}
      if (res.status === 202 && r.verificationRequired) { payoutCallbackChallenge = r.challengeId; $("payoutCallbackCodeWrap").classList.remove("hidden"); payoutCallbackMsg(r.detail || "We emailed you a code."); return; }
      payoutCallbackChallenge = null; $("payoutCallbackCodeWrap").classList.add("hidden"); $("payoutCallbackCode").value = "";
      if (res.ok && r.ok) { payoutCallbackMsg(""); showToast("Confirmed. Payouts will resume."); loadPayoutDestination().catch(() => undefined); return; }
      payoutCallbackMsg(res.status === 429 ? "Too many attempts. Wait a minute and try again." : (r.detail || ("Could not confirm: " + (r.error || res.status))), true);
    }
    $("payoutCallbackSendBtn").addEventListener("click", () => confirmPayoutCallback(false).catch((e) => payoutCallbackMsg(String(e.message || e), true)));
    $("payoutCallbackConfirmBtn").addEventListener("click", () => confirmPayoutCallback(true).catch((e) => payoutCallbackMsg(String(e.message || e), true)));
    async function loadPayoutDestination() {
      const r = await payoutDestRequest("GET");
      if (r.status !== 200) { $("payoutDestCurrent").textContent = "Unavailable"; payoutDestMessage("error", "Could not load your payout destination (" + (r.payload.error || r.status) + ")."); return; }
      renderPayoutDest(r.payload);
    }
    async function savePayoutDest(withCode) {
      const destination = $("payoutDestInput").value.trim();
      if (!destination) { payoutDestMessage("error", "Enter a Lightning address from your wallet."); return; }
      const body = { destination };
      if (withCode) {
        const emailCode = $("payoutDestCode").value.trim();
        if (!emailCode || !payoutDestChallenge) { payoutDestMessage("error", "Enter the code from the email."); return; }
        body.challengeId = payoutDestChallenge; body.emailCode = emailCode;
      }
      payoutDestMessage(null);
      const r = await payoutDestRequest("PUT", body);
      if (r.status === 200) {
        payoutDestChallenge = null; $("payoutDestCodeWrap").classList.add("hidden"); $("payoutDestCode").value = "";
        renderPayoutDest(r.payload);
        const reg = r.payload.registration || {};
        payoutDestMessage("info", reg.controlPlane === "ok" || reg.coordinator === "ok" ? "Saved. Payouts will go to " + r.payload.destination.destination + "." : "Saved here, but the payout service could not be reached. Save again later so payouts can reach you.");
        return;
      }
      if (r.status === 202 && r.payload.verificationRequired) { payoutDestChallenge = r.payload.challengeId; $("payoutDestCodeWrap").classList.remove("hidden"); payoutDestMessage("info", r.payload.detail || "We emailed you a code. Enter it to confirm the change."); return; }
      if (r.status === 429) { payoutDestMessage("error", "Too many attempts. Wait a minute and try again."); return; }
      if (withCode) { payoutDestChallenge = null; $("payoutDestCodeWrap").classList.add("hidden"); }
      payoutDestMessage("error", r.payload.detail || ("Could not save: " + (r.payload.error || r.status)));
    }
    $("payoutDestSaveBtn").addEventListener("click", () => savePayoutDest(false).catch((e) => payoutDestMessage("error", String(e.message || e))));
    $("payoutDestConfirmBtn").addEventListener("click", () => savePayoutDest(true).catch((e) => payoutDestMessage("error", String(e.message || e))));

    renderBreakdown();
    if (/[?&]topup=1/.test(location.search)) setTimeout(() => $("addFundsBtn").click(), 50);
    requireAuth().then((me) => {
      revealSettingsAdminTab(me);
      loadOverview().then(loadIntents).catch(() => undefined);
      loadPayoutDestination().catch(() => undefined);
      loadSendRequests().catch(() => undefined);
    }).catch(() => undefined);
    // Keep the balance and earnings fresh while the page is open (not while an invoice is polling).
    setInterval(() => { if (!state.poll && !document.hidden) loadOverview().catch(() => undefined); }, 60000);
`;

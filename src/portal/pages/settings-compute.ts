// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { MARKET_CONTENT, MARKET_SCRIPT, MARKET_SUBTITLE } from "./market.js";
import { SETTINGS_HELPERS_SCRIPT, settingRow, settingsPage, settingsSection } from "./settings-shell.js";
import { WALLET_CSS, WALLET_HELPERS_SCRIPT } from "./wallet.js";

/**
 * Settings > Compute (/portal/settings/compute): the compute market (prices, order book, standing
 * orders) and, below it, reserving a machine and your reservations. Moved from /portal/market and
 * the old Compute section of /portal/settings; both old links land here.
 */
const card = (rows: string) => `<div class="set-card">${rows}</div>`;
const group = (label: string) => `<div class="set-group">${label}</div>`;

const RESERVATIONS = settingsSection(
  "reservations",
  "Reserve a machine",
  "Reserve a machine: it takes only your jobs for the time you pick, paid now in cSats. Unused time comes back when you cancel.",
  group("Reserve a machine") +
    card(
      settingRow("Class", "What kind of machine. Shows how many are free and the price.", `<select id="reserveClass" aria-label="Machine class"><option value="">Loading…</option></select>`, { keywords: "reserve class gpu cpu apple machine lease" }) +
        settingRow("Minutes", "How long to hold it.", `<input id="reserveMinutes" type="number" min="5" max="1440" step="5" value="30" aria-label="Minutes" />`, { keywords: "reserve minutes duration time" }) +
        settingRow("Model", "Optional: only a machine that has this model installed.", `<select id="reserveModel" aria-label="Model"><option value="">Any model</option></select>`, { keywords: "reserve model" }) +
        settingRow("Cost", "Charged now; the unused part is refunded.", `<span class="set-value" id="reserveCost">—</span><button class="primary" id="reserveBtn">Reserve</button>`, { keywords: "reserve cost price" })
    ) +
    group("Your reservations") +
    card(`<div id="leasesList" data-keywords="reservations leases active cancel"><div class="set-row"><div class="set-empty">Loading…</div></div></div>`)
);


/** The price board: what a model call and a second of each class cost now, and the fees. */
const PRICE_BOARD = settingsSection(
  "prices",
  "Prices now",
  "What compute costs right now. 1 cSat = 1 sat. Model calls are priced per token by model size; code jobs and reservations per second by machine class.",
  `${WALLET_CSS}
    <div class="wl-head"><span class="net-badge" id="netBadge"><span class="dot"></span><span id="netBadgeText">Checking network…</span></span><span class="wl-faint" id="pbRate"></span></div>
    <div class="pb-classes" id="pbClasses"><div class="pb-class"><div class="t">Loading…</div></div></div>
    <div class="wl-faint u-mb-12">Per second on the base tier of each class; faster tiers cost more per second and finish sooner. The price an agent is paid comes from the order book below and is held between 0.25x and 4x of the class reference.</div>
    <div class="set-card"><div class="set-row wide">
      <div class="set-text"><div class="set-label">Model calls, per million tokens</div><div class="set-desc">The same price on every class; never below the electricity the machine used.</div></div>
      <div class="wl-table-wrap"><table><thead><tr><th>Model</th><th class="num">Machines</th><th class="num">Input</th><th class="num">Output</th></tr></thead><tbody id="pbModels"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>
    </div></div>
    <div class="wl-faint" id="pbFees"></div>`
);

const PRICE_BOARD_SCRIPT = WALLET_HELPERS_SCRIPT + `
    (function () {
      const $p = (id) => document.getElementById(id);
      fetch("/portal/api/wallet/overview", { credentials: "include" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).then((o) => {
        renderNetBadge(o.network);
        $p("pbRate").textContent = o.btcUsd ? "BTC $" + fmtSats(o.btcUsd) + (o.rateStale ? " (stale)" : "") + " · rate oracle" : "";
        const classes = Object.entries(o.classes || {});
        $p("pbClasses").innerHTML = classes.length ? classes.map(([id, c]) => {
          const perS = Number(c.cSatsPerSecondBaseTier) || 0;
          const perH = perS * 3600;
          return "<div class='pb-class'><div class='t'>" + escapeHtml(c.label || classLabel(id)) + "<small>" + escapeHtml(id) + "</small></div><div class='v'>" + escapeHtml(fmtRate(perS)) + " <small>cSats/s</small></div><div class='d'>" + escapeHtml(fmtNum(perH, perH < 10 ? 2 : 0)) + " sats/h" + (o.btcUsd ? " · " + escapeHtml(fmtUsd(perH, o.btcUsd)) + "/h" : "") + "</div></div>";
        }).join("") : "<div class='pb-class'><div class='t'>Not connected</div><div class='d'>Prices appear when a coordinator is reachable.</div></div>";
        const models = o.models || [];
        $p("pbModels").innerHTML = models.length ? models.map((m) => {
          const p = m.cSatsPerMTokens || {};
          return "<tr><td>" + escapeHtml(m.model) + "</td><td class='num'>" + escapeHtml(m.agents) + "</td><td class='num'>" + (p.input !== undefined ? escapeHtml(fmtNum(p.input, 2)) + " cSats" : "–") + "</td><td class='num'>" + (p.output !== undefined ? escapeHtml(fmtNum(p.output, 2)) + " cSats" : "–") + "</td></tr>";
        }).join("") : "<tr><td colspan='4' class='muted'>No machines are offering models right now.</td></tr>";
        const f = o.fees || {};
        const nf = f.networkFeeBps === null || f.networkFeeBps === undefined ? 500 : f.networkFeeBps;
        const pf = f.purchaseFeeBps === null || f.purchaseFeeBps === undefined ? 0 : f.purchaseFeeBps;
        $p("pbFees").textContent = "Fees: of every payment for compute, the machine's owner gets " + pct(10000 - nf) + " and EdgeCoder keeps " + pct(nf) + ". " + (pf > 0 ? "Buying cSats has a " + pct(pf) + " purchase fee on this coordinator." : "Buying cSats is free.") + " Your own machines are free.";
      }).catch(() => { $p("pbClasses").innerHTML = "<div class='pb-class'><div class='t'>Prices unavailable</div><div class='d'>Try again in a minute.</div></div>"; $p("pbModels").innerHTML = "<tr><td colspan='4' class='muted'>Unavailable.</td></tr>"; });
    })();
`;

const SCRIPT = SETTINGS_HELPERS_SCRIPT + PRICE_BOARD_SCRIPT + `
    /* ── Compute: reserve a machine, your leases ── */
    let computeData = { options: {}, reservations: [] };
    function renderReserveForm() {
      const sel = document.getElementById("reserveClass");
      const prev = sel.value;
      sel.textContent = "";
      for (const cls of ["cpu", "apple", "gpu", "gpu.dc"]) {
        const o = (computeData.options || {})[cls] || { available: 0 };
        const label = classLabel(cls) + " · " + (o.available ? o.available + " free" : "none free") + (o.cSatsPerSecond !== undefined ? " · " + fmtRate(o.cSatsPerSecond) + " cSats/s" : "");
        const opt = el("option", { value: cls }, label);
        if (!o.available) opt.disabled = true;
        sel.appendChild(opt);
      }
      const firstFree = ["gpu", "apple", "cpu", "gpu.dc"].find((c) => ((computeData.options || {})[c] || {}).available);
      sel.value = prev && ((computeData.options || {})[prev] || {}).available ? prev : firstFree || "gpu";
      const m = document.getElementById("reserveMinutes");
      if (computeData.minMinutes) m.min = computeData.minMinutes;
      if (computeData.maxMinutes) m.max = computeData.maxMinutes;
      renderReserveModels();
    }
    function renderReserveModels() {
      const cls = document.getElementById("reserveClass").value;
      const sel = document.getElementById("reserveModel");
      const prev = sel.value;
      sel.textContent = "";
      sel.appendChild(el("option", { value: "" }, "Any model"));
      for (const m of (((computeData.options || {})[cls] || {}).models || [])) sel.appendChild(el("option", { value: m }, m));
      sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "";
      renderReserveCost();
    }
    function renderReserveCost() {
      const cls = document.getElementById("reserveClass").value;
      const o = (computeData.options || {})[cls] || {};
      const minutes = Number(document.getElementById("reserveMinutes").value) || 0;
      const cost = document.getElementById("reserveCost");
      const btn = document.getElementById("reserveBtn");
      if (!o.available) { cost.textContent = "No " + classLabel(cls) + " machine free"; btn.disabled = true; return; }
      btn.disabled = false;
      cost.textContent = o.cSatsPerSecond !== undefined ? "≈ " + fmtNum(o.cSatsPerSecond * minutes * 60, 1) + " cSats" : "—";
    }
    function renderLeases() {
      const list = document.getElementById("leasesList");
      list.textContent = "";
      const rs = [...(computeData.reservations || [])].sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || b.startMs - a.startMs).slice(0, 10);
      if (!rs.length) { const row = el("div", { class: "set-row" }); row.appendChild(el("div", { class: "set-empty" }, "No reservations yet. Reserve a machine above; it shows up in the chat's compute picker.")); list.appendChild(row); return; }
      for (const r of rs) {
        const active = r.status === "active" && r.endMs > Date.now();
        const row = el("div", { class: "set-row lease" });
        const text = el("div", { class: "set-text" });
        const label = el("div", { class: "set-label" }, classLabel(r.computeClass) + " · " + (r.model || "any model"));
        label.insertAdjacentHTML("beforeend", active ? statusBadge("Active", "ok") : statusBadge(r.endReason || r.status || "ended"));
        text.appendChild(label);
        const parts = active
          ? [timeLeft(r.endMs), r.cSatsPerSecond !== undefined ? fmtRate(r.cSatsPerSecond) + " cSats/s" : "", r.prepaidCSats !== undefined ? fmtNum(r.prepaidCSats, 1) + " cSats prepaid" : ""]
          : ["Ended " + fmtDate(r.endMs), r.usedCSats !== undefined ? fmtNum(r.usedCSats, 1) + " cSats used" : "", r.refundCSats ? fmtNum(r.refundCSats, 1) + " refunded" : ""];
        text.appendChild(el("div", { class: "set-desc" }, parts.filter(Boolean).join(" · ")));
        row.appendChild(text);
        const ctl = el("div", { class: "set-control" });
        if (active) {
          const btn = el("button", { class: "danger sm" }, "Cancel");
          btn.addEventListener("click", () => cancelLease(r));
          ctl.appendChild(btn);
        }
        row.appendChild(ctl);
        list.appendChild(row);
      }
    }
    async function loadCompute() {
      const r = await call("/portal/api/compute/reservations");
      if (!r.ok) {
        document.getElementById("reserveClass").innerHTML = '<option value="">Network unreachable</option>';
        document.getElementById("reserveBtn").disabled = true;
        document.getElementById("leasesList").innerHTML = '<div class="set-row"><div class="set-empty">Could not load reservations.</div></div>';
        return;
      }
      computeData = r.json;
      renderReserveForm();
      renderLeases();
    }
    async function cancelLease(r) {
      if (!confirm("End this reservation now? The unused time is refunded.")) return;
      const res = await call("/portal/api/compute/reservations/cancel", { method: "POST", body: JSON.stringify({ reservationId: r.id }) });
      if (!res.ok) { showToast("Could not cancel: " + (res.json.error || res.status), true); return; }
      showToast("Reservation ended." + (res.json.reservation && res.json.reservation.refundCSats ? " Refunded " + fmtNum(res.json.reservation.refundCSats, 1) + " cSats." : ""));
      loadCompute(); loadTopTicker();
    }
    document.getElementById("reserveClass").addEventListener("change", renderReserveModels);
    document.getElementById("reserveMinutes").addEventListener("input", renderReserveCost);
    document.getElementById("reserveBtn").addEventListener("click", async () => {
      const computeClass = document.getElementById("reserveClass").value;
      const minutes = Math.round(Number(document.getElementById("reserveMinutes").value));
      const model = document.getElementById("reserveModel").value;
      const btn = document.getElementById("reserveBtn");
      btn.disabled = true;
      const res = await call("/portal/api/compute/reservations", { method: "POST", body: JSON.stringify({ computeClass, minutes, ...(model ? { model } : {}) }) });
      btn.disabled = false;
      if (!res.ok) {
        const e = res.json.error;
        showToast(e === "insufficient_credits" ? "Not enough cSats: this needs " + fmtNum(res.json.neededCSats, 1) + " cSats. Add funds under Settings > Wallet."
          : e === "no_agent_available" ? "No " + classLabel(computeClass) + " machine is free right now." : "Could not reserve: " + (e || res.status), true);
        loadCompute();
        return;
      }
      showToast("Reserved a " + classLabel(computeClass) + " machine for " + minutes + " min. Pick it in the chat's compute picker.");
      loadCompute(); loadTopTicker();
    });
    setInterval(renderLeases, 30000);

    requireAuth().then((me) => { revealSettingsAdminTab(me); loadCompute(); }).catch(() => undefined);
`;

export function registerSettingsComputePage(app: FastifyInstance): void {
  app.get("/portal/settings/compute", async (_req, reply) => {
    const content = PRICE_BOARD + settingsSection("compute", "Market", MARKET_SUBTITLE, MARKET_CONTENT) + RESERVATIONS;
    return reply.type("text/html").send(settingsPage("compute", "Compute market and machine reservations.", content, SCRIPT + MARKET_SCRIPT, { wide: true }));
  });
}

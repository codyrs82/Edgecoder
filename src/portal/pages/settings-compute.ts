// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { MARKET_CONTENT, MARKET_SCRIPT, MARKET_SUBTITLE } from "./market.js";
import { SETTINGS_HELPERS_SCRIPT, settingRow, settingsPage, settingsSection } from "./settings-shell.js";

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


const SCRIPT = SETTINGS_HELPERS_SCRIPT + `
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
        showToast(e === "insufficient_credits" ? "Not enough cSats: this needs " + fmtNum(res.json.neededCSats, 1) + " cSats. Buy more under Plan & usage."
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
    const content = settingsSection("compute", "Compute", MARKET_SUBTITLE, MARKET_CONTENT) + RESERVATIONS;
    return reply.type("text/html").send(settingsPage("compute", "Compute market and machine reservations.", content, SCRIPT + MARKET_SCRIPT, { wide: true }));
  });
}

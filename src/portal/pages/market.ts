// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";

/**
 * /portal/market: exchange-style view of compute priced in Bitcoin. One "pair" per compute
 * class (CPU, Apple silicon, GPU, Datacenter GPU / BTC), quoted in msat per credit. The price is
 * flat within a class; one credit is one measured second on the class's base tier and faster
 * tiers mint more credits per second (the weight table under the order book). Candlesticks from the coordinator's minute ticks, a depth chart and order book
 * from live asks/bids, the trade tape, and a panel to place standing buy/sell orders.
 * Chart: TradingView Lightweight Charts, served from /portal/vendor (CSP script-src 'self').
 */
export function registerMarketPage(app: FastifyInstance): void {
  app.get("/portal/market", async (_req, reply) => {
    const content = `
    <style>
      .mkt-top { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
      .mkt-pair { font-size:20px; font-weight:700; letter-spacing:0.01em; }
      .mkt-stat { display:flex; flex-direction:column; min-width:110px; }
      .mkt-stat .k { font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); }
      .mkt-stat .v { font-family:var(--font-mono); font-size:14px; }
      .mkt-grid { display:grid; grid-template-columns: minmax(0,1fr) 320px; gap:12px; }
      @media (max-width: 980px) { .mkt-grid { grid-template-columns: 1fr; } }
      .mkt-chart { height:420px; width:100%; }
      .mkt-depth { height:160px; width:100%; }
      .mkt-toolbar { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }
      .mkt-toolbar button { padding:4px 10px; font-size:12px; }
      .mkt-toolbar button.active { background:var(--brand); color:#111; border-color:var(--brand); }
      .book { font-family:var(--font-mono); font-size:12px; }
      .book table { width:100%; border-collapse:collapse; }
      .book td, .book th { padding:3px 6px; text-align:right; }
      .book th { color:var(--muted); font-weight:500; font-size:10px; text-transform:uppercase; letter-spacing:0.05em; }
      .book .ask { color:var(--danger); }
      .book .bid { color:var(--ok); }
      .book .mid { text-align:center; padding:6px; border-top:1px solid var(--card-border); border-bottom:1px solid var(--card-border); font-weight:700; }
      .tape { font-family:var(--font-mono); font-size:12px; max-height:220px; overflow:auto; }
      .tape div { display:flex; justify-content:space-between; padding:2px 0; border-bottom:1px solid var(--card-border); }
      .order-tabs { display:flex; gap:0; margin-bottom:10px; }
      .order-tabs button { flex:1; border-radius:0; }
      .order-tabs button:first-child { border-radius:var(--radius-sm) 0 0 var(--radius-sm); }
      .order-tabs button:last-child { border-radius:0 var(--radius-sm) var(--radius-sm) 0; }
      .order-tabs button.buy.active { background:var(--ok); color:#000; border-color:var(--ok); }
      .order-tabs button.sell.active { background:var(--danger); color:#000; border-color:var(--danger); }
      .field { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
      .field label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; }
      .field input { font-family:var(--font-mono); }
      .hint { font-size:11px; color:var(--muted); }
      .pos { color:var(--ok); } .neg { color:var(--danger); }
      .agents-list { font-size:12px; }
      .agents-list div { display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px solid var(--card-border); }
    </style>

    <div class="mkt-top">
      <select id="pairSelect" style="width:auto;min-width:260px;font-size:14px;font-weight:600;"></select>
      <div class="mkt-pair" id="pairLabel">…/BTC</div>
      <div class="mkt-stat"><span class="k">Last</span><span class="v" id="statLast">–</span></div>
      <div class="mkt-stat"><span class="k">24h change</span><span class="v" id="statChange">–</span></div>
      <div class="mkt-stat"><span class="k">Best bid</span><span class="v bid" id="statBid">–</span></div>
      <div class="mkt-stat"><span class="k">Best ask</span><span class="v ask" id="statAsk">–</span></div>
      <div class="mkt-stat"><span class="k">Spread</span><span class="v" id="statSpread">–</span></div>
      <div class="mkt-stat"><span class="k">Oracle ref</span><span class="v" id="statRef">–</span></div>
      <div class="mkt-stat"><span class="k">Credit-hour</span><span class="v" id="statHour">–</span></div>
      <div class="mkt-stat"><span class="k">BTC/USD</span><span class="v" id="statBtc">–</span></div>
    </div>

    <div class="mkt-grid">
      <div>
        <div class="card" style="padding:12px;">
          <div class="mkt-toolbar">
            <span class="hint" style="margin-right:6px;">Interval</span>
            ${["1m", "5m", "15m", "1h", "4h", "1d"].map((i) => `<button data-interval="${i}" class="${i === "5m" ? "active" : ""}">${i}</button>`).join("")}
            <span class="hint" style="margin-left:auto;" id="chartMeta">msat per credit · 1 credit = 1 measured second on the base tier of this class</span>
          </div>
          <div id="priceChart" class="mkt-chart"></div>
          <div class="hint" style="margin:8px 0 4px;">Depth (cumulative agents asking / tasks bidding)</div>
          <div id="depthChart" class="mkt-depth"></div>
        </div>
        <div class="card" style="padding:12px;margin-top:12px;">
          <h3 style="margin:0 0 8px;">Recent trades</h3>
          <div class="tape" id="tape"><div class="hint">No trades yet on this class.</div></div>
        </div>
      </div>
      <div>
        <div class="card book" style="padding:12px;">
          <h3 style="margin:0 0 8px;font-family:system-ui;">Order book</h3>
          <table>
            <thead><tr><th>Price (msat/credit)</th><th>Agents</th><th>Cum.</th></tr></thead>
            <tbody id="asksBody"></tbody>
          </table>
          <div class="mid" id="bookMid">–</div>
          <table>
            <tbody id="bidsBody"></tbody>
            <tfoot><tr><th>Price (msat/credit)</th><th>Tasks</th><th>Cum.</th></tr></tfoot>
          </table>
        </div>
        <div class="card book" style="padding:12px;margin-top:12px;">
          <h3 style="margin:0 0 4px;font-family:system-ui;">Hardware tiers</h3>
          <div class="hint" id="tierExplain" style="font-family:system-ui;margin-bottom:6px;"></div>
          <table>
            <thead><tr><th style="text-align:left;">Tier</th><th>Credits/s</th><th>sats/h</th><th>Agents</th></tr></thead>
            <tbody id="tiersBody"></tbody>
          </table>
        </div>
        <div class="card" style="padding:12px;margin-top:12px;">
          <div class="order-tabs">
            <button class="buy active" id="tabBuy">Buy compute</button>
            <button class="sell" id="tabSell">Sell compute</button>
          </div>
          <div class="field">
            <label>Price limit (msat per credit)</label>
            <input id="orderPrice" type="number" min="0" step="1" placeholder="0 = track oracle reference" />
            <span class="hint" id="orderPriceHint"></span>
          </div>
          <div class="field">
            <label>Class</label>
            <select id="orderClass"><option value="any">Any (match by class of the chart)</option></select>
          </div>
          <div class="hint" id="orderExplain" style="margin-bottom:10px;"></div>
          <button class="primary" id="placeOrder" style="width:100%;">Place standing bid</button>
          <div class="hint" id="orderStatus" style="margin-top:8px;"></div>
          <div id="myOrders" class="hint" style="margin-top:10px;"></div>
          <div id="myAgents" class="agents-list" style="margin-top:10px;"></div>
        </div>
      </div>
    </div>`;

    const script = `
      (function () {
        var state = { cls: "cpu", interval: "5m", side: "buy", classes: [], rates: null, chart: null, candles: null, volume: null, depth: null, askSeries: null, bidSeries: null, timer: null };
        var $ = function (id) { return document.getElementById(id); };
        var fmt = function (n, d) { return n === undefined || n === null ? "–" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 0 : d }); };
        var satsHour = function (msatPerCredit, cps) { return msatPerCredit / 1000 * cps * 3600; };
        var esc = function (s) { return String(s).replace(/[&<>"']/g, function (ch) { return "&#" + ch.charCodeAt(0) + ";"; }); };

        function api(path) { return fetch("/portal/api/market" + path, { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error(path + " " + r.status); return r.json(); }); }

        function loadLib() {
          return new Promise(function (resolve, reject) {
            if (window.LightweightCharts) return resolve();
            var s = document.createElement("script"); s.src = "/portal/vendor/lightweight-charts.js"; s.onload = resolve; s.onerror = function () { reject(new Error("chart library failed to load")); }; document.head.appendChild(s);
          });
        }

        function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

        function buildCharts() {
          var LWC = window.LightweightCharts;
          var common = { layout: { background: { color: "transparent" }, textColor: css("--text-secondary") }, grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } }, timeScale: { timeVisible: true, secondsVisible: false, borderColor: css("--card-border") }, rightPriceScale: { borderColor: css("--card-border") }, crosshair: { mode: 0 } };
          state.chart = LWC.createChart($("priceChart"), Object.assign({ autoSize: true }, common));
          state.candles = state.chart.addCandlestickSeries({ upColor: css("--ok"), downColor: css("--danger"), borderUpColor: css("--ok"), borderDownColor: css("--danger"), wickUpColor: css("--ok"), wickDownColor: css("--danger"), priceFormat: { type: "price", precision: 0, minMove: 1 } });
          state.volume = state.chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", color: "rgba(193,120,80,0.5)" });
          state.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
          state.depth = LWC.createChart($("depthChart"), Object.assign({ autoSize: true }, common, { timeScale: { visible: false }, handleScroll: false, handleScale: false }));
          state.bidSeries = state.depth.addAreaSeries({ lineColor: css("--ok"), topColor: "rgba(74,222,128,0.35)", bottomColor: "rgba(74,222,128,0.02)", priceFormat: { type: "price", precision: 0, minMove: 1 } });
          state.askSeries = state.depth.addAreaSeries({ lineColor: css("--danger"), topColor: "rgba(248,113,113,0.35)", bottomColor: "rgba(248,113,113,0.02)", priceFormat: { type: "price", precision: 0, minMove: 1 } });
        }

        function classSpec(id) { for (var i = 0; i < state.classes.length; i++) if (state.classes[i].id === id) return state.classes[i]; return null; }

        function renderTop(book, latest) {
          var spec = classSpec(state.cls) || { label: state.cls, creditsPerSecond: 1 };
          $("pairLabel").textContent = spec.label + " / BTC";
          renderTiers(spec, book.referenceMsatPerCredit);
          var last = latest ? latest.midMsat : book.midMsatPerCredit;
          $("statLast").textContent = fmt(last) + " msat";
          $("statBid").textContent = book.bestBid === undefined ? "–" : fmt(book.bestBid);
          $("statAsk").textContent = book.bestAsk === undefined ? "–" : fmt(book.bestAsk);
          $("statSpread").textContent = book.spreadMsat === undefined ? "–" : fmt(book.spreadMsat) + " msat";
          $("statRef").textContent = fmt(book.referenceMsatPerCredit) + " msat";
          $("statHour").textContent = fmt(satsHour(last, spec.creditsPerSecond), 1) + " sats/h";
          var btc = state.rates && state.rates.epoch ? state.rates.epoch.btcUsd : null;
          $("statBtc").textContent = btc ? "$" + fmt(btc) : "–";
          $("orderPriceHint").textContent = "Reference " + fmt(book.referenceMsatPerCredit) + " msat/credit (" + fmt(satsHour(book.referenceMsatPerCredit, spec.creditsPerSecond), 1) + " sats per credit-hour)" + (btc ? " ≈ $" + fmt(satsHour(book.referenceMsatPerCredit, spec.creditsPerSecond) / 1e8 * btc, 4) + "/h" : "");
        }

        // Weight table: one price per credit in the class; a tier's hour is the credit-hour × its weight.
        function renderTiers(spec, refMsat) {
          var tiers = spec.tiers || [];
          if (!tiers.length) { $("tiersBody").innerHTML = "<tr><td colspan='4' class='hint' style='text-align:center'>one tier</td></tr>"; $("tierExplain").textContent = ""; return; }
          var top = tiers[tiers.length - 1];
          $("tierExplain").textContent = "Same price per credit for every tier. Faster hardware earns more credits per second, so one hour of " + top.label + " costs " + top.creditsPerSecond + " " + spec.label + " credit-hours. Tasks can require minVramGb / minMemoryGb; under-spec agents cannot fill them.";
          $("tiersBody").innerHTML = tiers.map(function (t) {
            return "<tr><td style='text-align:left;'>" + esc(t.label) + " <span class='hint'>" + esc(t.id) + "</span></td><td>" + t.creditsPerSecond + "×</td><td>" + fmt(satsHour(refMsat, t.creditsPerSecond), 1) + "</td><td>" + (t.agents || 0) + "</td></tr>";
          }).join("");
        }

        function renderBook(book) {
          var asks = book.asks.slice().reverse(); var cum = 0; var rows = [];
          var totalA = 0; for (var i = 0; i < book.asks.length; i++) totalA += book.asks[i].count;
          cum = totalA;
          for (var a = 0; a < asks.length; a++) { rows.push("<tr><td class='ask'>" + fmt(asks[a].msatPerCredit) + "</td><td>" + asks[a].count + "</td><td>" + cum + "</td></tr>"); cum -= asks[a].count; }
          $("asksBody").innerHTML = rows.length ? rows.join("") : "<tr><td colspan='3' class='hint' style='text-align:center'>no asks</td></tr>";
          $("bookMid").textContent = fmt(book.midMsatPerCredit) + " msat · clearing " + fmt(book.clearingMsatPerCredit);
          cum = 0; rows = [];
          for (var b = 0; b < book.bids.length; b++) { cum += book.bids[b].count; rows.push("<tr><td class='bid'>" + fmt(book.bids[b].msatPerCredit) + "</td><td>" + book.bids[b].count + "</td><td>" + cum + "</td></tr>"); }
          $("bidsBody").innerHTML = rows.length ? rows.join("") : "<tr><td colspan='3' class='hint' style='text-align:center'>no bids (open tasks)</td></tr>";
        }

        function renderDepth(depth) {
          // Depth chart x-axis must be monotonically increasing "time": use the price as the x value.
          var bids = depth.bids.slice().sort(function (x, y) { return x.price - y.price; }).map(function (p) { return { time: p.price, value: p.cumulative }; });
          var asks = depth.asks.slice().sort(function (x, y) { return x.price - y.price; }).map(function (p) { return { time: p.price, value: p.cumulative }; });
          state.bidSeries.setData(bids); state.askSeries.setData(asks);
          state.depth.timeScale().fitContent();
        }

        function renderTape(trades) {
          if (!trades.length) { $("tape").innerHTML = "<div class='hint'>No trades yet on this class. A trade is a task claimed by an agent at its ask.</div>"; return; }
          $("tape").innerHTML = trades.map(function (t) {
            return "<div><span>" + new Date(t.atMs).toLocaleTimeString() + "</span><span>" + fmt(t.msatPerCredit) + " msat</span><span>" + (t.credits ? fmt(t.credits, 3) + " cr" : "pending") + "</span><span class='hint'>" + t.agentId.slice(0, 14) + "</span></div>";
          }).join("");
        }

        function renderCandles(data) {
          var c = data.candles.map(function (k) { return { time: k.time, open: k.open, high: k.high, low: k.low, close: k.close }; });
          state.candles.setData(c);
          state.volume.setData(data.candles.map(function (k) { return { time: k.time, value: k.volume, color: k.close >= k.open ? "rgba(74,222,128,0.5)" : "rgba(248,113,113,0.5)" }; }));
          if (c.length) state.chart.timeScale().fitContent();
          if (c.length >= 2) {
            var first = c[Math.max(0, c.length - Math.round(86400 / (secondsOf(state.interval))))], lastC = c[c.length - 1];
            var ch = first.open > 0 ? (lastC.close - first.open) / first.open * 100 : 0;
            $("statChange").textContent = (ch >= 0 ? "+" : "") + ch.toFixed(2) + "%"; $("statChange").className = "v " + (ch >= 0 ? "pos" : "neg");
          } else { $("statChange").textContent = "–"; }
        }
        function secondsOf(i) { var n = parseInt(i, 10); return i.endsWith("m") ? n * 60 : i.endsWith("h") ? n * 3600 : n * 86400; }

        function renderOrders(data) {
          var mine = (data.orders || []).map(function (o) { return o.side.toUpperCase() + " " + (o.msatPerCredit ? fmt(o.msatPerCredit) + " msat/credit" : "track reference") + " on " + o.computeClass; });
          $("myOrders").innerHTML = mine.length ? "<strong>Your standing orders:</strong> " + mine.join(" · ") : "No standing orders. Your tasks bid the reference + premium; your agents ask the reference.";
          var ag = data.agents || [];
          $("myAgents").innerHTML = ag.length ? "<div><strong>Your agents</strong><span>ask</span></div>" + ag.map(function (a) { return "<div><span>" + a.agentId + " <span class='hint'>" + a.computeClass + (a.tier ? " · " + a.tier + " " + (a.creditsPerSecond || 1) + "×" : "") + "</span></span><span>" + (a.ask === null ? "–" : fmt(a.ask)) + (a.tracking ? " (ref)" : "") + "</span></div>"; }).join("") : "";
        }

        function refresh() {
          var q = "?computeClass=" + encodeURIComponent(state.cls);
          return Promise.all([
            api("/candles" + q + "&interval=" + state.interval + "&limit=600"),
            api("/depth" + q),
            api("/trades" + q + "&limit=60"),
            api("/rates").catch(function () { return null; }),
            api("/orders").catch(function () { return { orders: [], agents: [] }; })
          ]).then(function (r) {
            state.rates = r[3];
            renderCandles(r[0]); renderTop(r[1].snapshot, r[0].latest); renderBook(r[1].snapshot); renderDepth(r[1]); renderTape(r[2].trades); renderOrders(r[4]);
          }).catch(function (e) { $("chartMeta").textContent = "Market data unavailable: " + e.message; });
        }

        function setSide(side) {
          state.side = side;
          $("tabBuy").classList.toggle("active", side === "buy"); $("tabSell").classList.toggle("active", side === "sell");
          $("placeOrder").textContent = side === "buy" ? "Place standing bid" : "Set ask for my agents";
          $("orderExplain").textContent = side === "buy"
            ? "A standing bid is the most you will pay per credit. Tasks you submit without an explicit price use it; an agent can take your task only if its ask is at or below it. 0 = use the oracle reference plus the default premium."
            : "Your ask is the least your agents will work for per credit. It applies to every agent registered to your account on the chosen class. 0 = track the oracle reference, which moves with the daily BTC/USD recalibration.";
        }

        $("tabBuy").onclick = function () { setSide("buy"); };
        $("tabSell").onclick = function () { setSide("sell"); };
        $("placeOrder").onclick = function () {
          var price = Number($("orderPrice").value || 0);
          $("orderStatus").textContent = "Placing…";
          fetch("/portal/api/market/orders", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ side: state.side, computeClass: $("orderClass").value, msatPerCredit: price }) })
            .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
            .then(function (x) { $("orderStatus").textContent = x.ok ? "Order placed." : "Failed: " + (x.b.error || "unknown"); refresh(); })
            .catch(function (e) { $("orderStatus").textContent = "Failed: " + e.message; });
        };
        Array.prototype.forEach.call(document.querySelectorAll("[data-interval]"), function (btn) {
          btn.onclick = function () { state.interval = btn.getAttribute("data-interval"); Array.prototype.forEach.call(document.querySelectorAll("[data-interval]"), function (b) { b.classList.toggle("active", b === btn); }); refresh(); };
        });
        $("pairSelect").onchange = function () { state.cls = $("pairSelect").value; $("orderClass").value = state.cls; refresh(); };

        loadLib().then(function () {
          buildCharts();
          return api("/classes");
        }).then(function (data) {
          state.classes = data.classes || [];
          $("pairSelect").innerHTML = state.classes.map(function (c) { return "<option value='" + c.id + "'>" + c.label + " / BTC" + (c.agents ? " (" + c.agents + " agents)" : "") + "</option>"; }).join("");
          $("orderClass").innerHTML = "<option value='any'>Any class</option>" + state.classes.map(function (c) { return "<option value='" + c.id + "'>" + c.label + "</option>"; }).join("");
          $("pairSelect").value = state.cls; $("orderClass").value = state.cls;
          setSide("buy");
          refresh();
          state.timer = setInterval(refresh, 10000);
        }).catch(function (e) { $("chartMeta").textContent = e.message; });
      })();
    `;

    reply.type("text/html").send(
      portalAuthedPageHtml({
        title: "EdgeCoder Portal | Market",
        activeTab: "market",
        heading: "Compute market",
        subtitle: "Compute priced in Bitcoin: four pairs (CPU, Apple silicon, GPU, datacenter GPU), each one flat price in msat per credit. Faster hardware in a class earns more credits per second. Agents ask, tasks bid, trades clear at the ask.",
        content,
        script
      })
    );
  });
}

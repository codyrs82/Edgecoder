// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { CSP_NONCE } from "../csp-nonce.js";
import * as W from "../../common/world-view.js";
import { settingsPage } from "./settings-shell.js";

/**
 * Settings > Network (/portal/settings/world), for every signed-in user: the whole network,
 * worldwide, the same page as the desktop app's Settings > Network (desktop/src/pages/MeshTopology.svelte).
 * Coordinators are hubs; machines sit around the coordinator they are on at a distance set by the
 * coordinator's measured round trip to them. Other people's machines are masked; yours are named.
 *
 * The shell carries no data. Its script reads /portal/api/network/world (src/portal/routes/network-world.ts,
 * the account bound from the session) every 15 s, and times this browser's round trip to each
 * coordinator itself (WORLD_PING_SCRIPT). The estimates, sorting, filtering and the graph layout are
 * the desktop's own code (src/common/world-view.ts, byte-identical with desktop/src/lib/world-view.ts),
 * shipped to the browser via Function.prototype.toString (WORLD_VIEW_BROWSER_LIB). The HTML is built
 * by pure functions (WORLD_RENDER_SCRIPT) so tests can render it without a DOM; everything from the
 * network goes through escapeHtml.
 *
 * Pulses: dots travel along the lines while calls are in flight (W.pulseLanes; SVG animateMotion,
 * capped at W.PULSE_MAX_DOTS). Each dot's `begin` is set from the wall clock (W.pulseBegin), so the
 * graph, rebuilt on every refresh and hover, carries on rather than restarting. Your own requests
 * light the path You → coordinator → machine in your accent. Reduced motion draws no moving dots:
 * line weight shows the load and a "Live" badge says the view is live. A hidden tab pauses the
 * animations (SVGSVGElement.pauseAnimations). A text summary is there for screen readers.
 *
 * The admin dashboard at /portal/settings/network (settings-network.ts) is a different page.
 */
export const WORLD_REFRESH_MS = 15_000;
export const WORLD_PING_EVERY_MS = 30_000;

/** The shared module's functions and the constants they read, as browser JS (plain declarations). */
export const WORLD_VIEW_BROWSER_LIB = [
  // esbuild (tests, tsx) may wrap functions in __name(); the browser has no such helper.
  "var __name = function (f) { return f; };",
  `var CONTINENTS = ${JSON.stringify(W.CONTINENTS)};`,
  `var STATUS_ORDER = ${JSON.stringify(W.STATUS_ORDER)};`,
  `var CONTINENT_X = ${JSON.stringify(W.CONTINENT_X)};`,
  `var RING_MIN = ${W.RING_MIN}, RING_MAX = ${W.RING_MAX}, CELL = ${W.CELL}, MS_LO = ${W.MS_LO}, MS_HI = ${W.MS_HI};`,
  `var PULSE_MAX_DOTS = ${W.PULSE_MAX_DOTS}, PULSE_MAX_PER_LANE = ${W.PULSE_MAX_PER_LANE}, HEARTBEAT_MS = ${W.HEARTBEAT_MS};`,
  `var PULSE_PERIODS = ${JSON.stringify(W.PULSE_PERIODS)};`,
  `var LABEL_FONT = ${W.LABEL_FONT}, SMALL_FONT = ${W.SMALL_FONT}, RING_FONT = ${W.RING_FONT}, LABEL_CHAR_EM = ${W.LABEL_CHAR_EM}, LABEL_MAX_CHARS = ${W.LABEL_MAX_CHARS}, LABEL_ALL_MAX = ${W.LABEL_ALL_MAX};`,
  `var HUB_R = ${W.HUB_R}, MESH_BAND = ${W.MESH_BAND}, LINE_CLEAR = ${W.LINE_CLEAR}, MIN_STEP = ${W.MIN_STEP};`,
  `var LABEL_DIRS = ${JSON.stringify(W.LABEL_DIRS)};`,
  ...[
    W.lanMs,
    W.estimateMs,
    W.nearness,
    W.formatMs,
    W.continentName,
    W.regionText,
    W.displayName,
    W.rowsFor,
    W.primaryModel,
    W.sortRows,
    W.filterRows,
    W.nearestPeers,
    W.nearestToYou,
    W.nearestText,
    W.ringRadius,
    W.lanDistance,
    W.nodeRadius,
    W.worldLayout,
    W.shortMachineName,
    W.mapLabelText,
    W.textBox,
    W.boxesOverlap,
    W.boxHitsCircle,
    W.boxHitsSegment,
    W.spreadAngles,
    W.placeLabels,
    W.hostOf,
    W.activityOf,
    W.pulsePeriod,
    W.pulseLevel,
    W.machinePulseCount,
    W.meshPulseCount,
    W.yourPath,
    W.pulseLanes,
    W.pulseDotCount,
    W.pulseBegin,
    W.heartbeatBegin,
    W.plural,
    W.activityText,
    W.activitySummary
  ].map((f) => f.toString())
].join("\n");

/**
 * This browser's round trip to a coordinator. The coordinators' CORS admits only the desktop
 * app's origins and the portal's connect-src is 'self', so fetch() cannot reach them; an image
 * load can (img-src allows https:) and needs neither: the page loads the coordinator's public
 * /identity as an image (no credentials, nothing read back; it fails to decode, which ends the
 * load once the answer is in) and times it. Two loads, the faster counted, so connection setup is
 * left out, as the desktop does. Resource Timing gives the network time when the browser has it.
 */
export const WORLD_PING_SCRIPT = `
    var PING_TIMEOUT_MS = 2500;
    function pingOnce(url) {
      return new Promise(function (resolve) {
        var src = url + "?t=" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        var img = new Image();
        var t0 = performance.now();
        var done = false;
        var timer = setTimeout(function () { finish(false); }, PING_TIMEOUT_MS);
        function finish(answered) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          img.onload = img.onerror = null;
          if (!answered) return resolve(null);
          var ms = performance.now() - t0;
          try {
            var e = performance.getEntriesByName(new URL(src, location.href).href);
            if (e.length && e[e.length - 1].duration > 0) ms = e[e.length - 1].duration;
          } catch (err) {}
          resolve(Math.round(ms));
        }
        img.onload = img.onerror = function () { finish(true); };
        img.referrerPolicy = "no-referrer";
        img.src = src;
      });
    }
    async function pingCoordinator(url) {
      var a = await pingOnce(url);
      var b = await pingOnce(url);
      if (a === null) return b;
      if (b === null) return a;
      return Math.min(a, b);
    }
`;

/**
 * Pure HTML builders (plain JS on top of WORLD_VIEW_BROWSER_LIB and escapeHtml). `s` is the page
 * state: { mode, scope, model, sortKey, sortDir, selectedId, hoverId, focusIndex, reducedMotion,
 * paused, clockMs }.
 */
export const WORLD_RENDER_SCRIPT = `
    var SORTS = [["latency", "Nearest"], ["region", "Region"], ["model", "Model"], ["status", "Status"]];
    function wvStatusText(st) { return st === "busy" ? "Busy" : st === "idle" ? "Idle" : "Not seen lately"; }
    function wvPlural(n, one) { return n + " " + one + (n === 1 ? "" : "s"); }
    function wvNodeLabel(r) {
      var a = r.agent;
      var who = a.mine ? "Your machine " + displayName(a) : "Machine " + a.label;
      var lat = r.estimateMs === null ? "latency unknown" : "about " + r.estimateMs + " ms from you";
      return who + ", " + wvStatusText(a.status).toLowerCase() + ", " + regionText(a) + ", " + wvPlural(a.models.length, "model") + ", " + lat;
    }
    function wvCoordName(view, id) {
      var c = view.coordinators.find(function (x) { return x.id === id; });
      return c ? hostOf(c.url) + (c.region ? " (" + c.region + ")" : "") : "unknown coordinator";
    }
    function wvDerive(view, s) {
      var rows = rowsFor(view);
      var visible = sortRows(filterRows(rows, { scope: s.scope, model: s.model }), s.sortKey, s.sortDir);
      var layout = worldLayout(view, visible);
      return { rows: rows, visible: visible, layout: layout, nearest: nearestPeers(rows), lanes: pulseLanes(view, layout), path: yourPath(view) };
    }

    // One travelling dot (SVG animateMotion; its begin is on the wall clock, see pulseBegin).
    function wvDotHtml(lane, i, clockMs) {
      var back = lane.twoWay && i % 2 === 1;
      var p = back ? "M" + lane.x2 + " " + lane.y2 + " L" + lane.x1 + " " + lane.y1 : "M" + lane.x1 + " " + lane.y1 + " L" + lane.x2 + " " + lane.y2;
      var t = "dur='" + lane.periodMs + "ms' begin='" + pulseBegin(lane, i, clockMs) + "' repeatCount='indefinite'";
      return "<circle class='wv-pulse k-" + lane.kind + (lane.yours ? " yours" : "") + (lane.faint ? " faint" : "") + "' r='" + (lane.kind === "mesh" ? 3.5 : 2.8) + "' opacity='0'>" +
        "<animateMotion " + t + " path='" + p + "'/>" +
        "<animate attributeName='opacity' values='0;1;1;0' keyTimes='0;0.12;0.82;1' " + t + "/></circle>";
    }
    function wvLaneOf(d, id) {
      for (var i = 0; i < d.lanes.length; i++) if (d.lanes[i].id === id) return d.lanes[i];
      return null;
    }
    function wvLvl(lane) { return lane && lane.level ? " lvl-" + lane.level : ""; }

    function wvStatsHtml(view, d) {
      var t = view.totals;
      function tile(label, big, sub) {
        return "<div class='wv-stat'><span class='wv-desc'>" + escapeHtml(label) + "</span><span class='wv-big'>" + escapeHtml(big) + "</span><span class='wv-desc'>" + escapeHtml(sub) + "</span></div>";
      }
      var near = d.nearest.length
        ? tile("Nearest to you", formatMs(d.nearest[0].estimateMs, true), d.nearest.map(function (r) { return (r.agent.label + " " + (r.agent.region || r.agent.country || "")).trim(); }).join(" · "))
        : tile("Nearest to you", "—", "No latency measured yet");
      return tile("Machines online", String(t.online), t.busy + " busy · " + t.slotsUsed + " of " + t.slots + " slots in use") +
        tile("Coordinators", String(t.coordinators), view.coordinators.map(function (c) { return c.region || hostOf(c.url); }).join(" · ")) +
        tile("Models available", String(t.models), view.models.slice(0, 2).map(function (m) { return m.model; }).join(", ") || "None online") +
        near;
    }

    function wvGraphHtml(view, d, s) {
      var L = d.layout;
      var hubById = {};
      L.hubs.forEach(function (h) { hubById[h.id] = h; });
      var detailId = s.hoverId || s.selectedId;
      var focus = Math.min(Math.max(0, s.focusIndex), Math.max(0, L.agents.length - 1));
      var out = [];
      var still = !!s.reducedMotion;
      var clockMs = typeof s.clockMs === "number" ? s.clockMs : Date.now();
      var path = d.path;
      out.push("<svg class='wv-graph" + (still ? " wv-still" : "") + (s.paused ? " wv-paused" : "") + "' viewBox='0 0 " + L.width + " " + L.height + "' role='group' aria-describedby='wvActivity' aria-label='Network graph: " + wvPlural(L.hubs.length, "coordinator") + " and " + wvPlural(L.agents.length, "machine") + ". Arrow keys move between machines, Enter pins a machine&#39;s details.'>");
      L.rings.forEach(function (ring) {
        var hub = hubById[ring.hubId];
        if (!hub) return;
        out.push("<circle class='wv-ring' cx='" + hub.x + "' cy='" + hub.y + "' r='" + ring.r + "' aria-hidden='true'/>");
      });
      view.links.forEach(function (link) {
        var a = hubById[link.from], b = hubById[link.to];
        if (!a || !b) return;
        var mesh = wvLaneOf(d, "mesh:" + [link.from, link.to].sort().join("|"));
        out.push("<line class='wv-clink" + wvLvl(mesh) + "' x1='" + a.x + "' y1='" + a.y + "' x2='" + b.x + "' y2='" + b.y + "' aria-hidden='true'/>");
        if (mesh && mesh.heartbeat && !still) out.push("<line class='wv-beat' x1='" + a.x + "' y1='" + a.y + "' x2='" + b.x + "' y2='" + b.y + "' aria-hidden='true'><animate attributeName='stroke-opacity' values='0;0.5;0;0' keyTimes='0;0.08;0.22;1' dur='" + HEARTBEAT_MS + "ms' begin='" + heartbeatBegin(clockMs) + "' repeatCount='indefinite'/></line>");
      });
      if (L.you) {
        L.hubs.forEach(function (hub) {
          var lane = wvLaneOf(d, "you:" + hub.id);
          if (!lane) return;
          out.push("<line class='wv-you-link" + (lane.yours ? " yours" : "") + "' x1='" + L.you.x + "' y1='" + L.you.y + "' x2='" + hub.x + "' y2='" + hub.y + "' aria-hidden='true'/>");
          if (lane.heartbeat && !still) out.push("<line class='wv-beat' x1='" + L.you.x + "' y1='" + L.you.y + "' x2='" + hub.x + "' y2='" + hub.y + "' aria-hidden='true'><animate attributeName='stroke-opacity' values='0;0.35;0;0' keyTimes='0;0.08;0.22;1' dur='" + HEARTBEAT_MS + "ms' begin='" + heartbeatBegin(clockMs + HEARTBEAT_MS / 2) + "' repeatCount='indefinite'/></line>");
        });
      }
      L.agents.forEach(function (node) {
        var hub = hubById[node.hubId];
        var lane = wvLaneOf(d, "spoke:" + node.id);
        if (hub) out.push("<line class='wv-spoke" + wvLvl(lane) + (lane && lane.yours ? " yours" : "") + (detailId === node.id ? " on" : "") + "' x1='" + hub.x + "' y1='" + hub.y + "' x2='" + node.x + "' y2='" + node.y + "' aria-hidden='true'/>");
      });
      // Busy machines glow softly (static), under the dots and the nodes.
      L.agents.forEach(function (node) {
        if (activityOf(node.row.agent).callsNow > 0) out.push("<circle class='wv-glow' cx='" + node.x + "' cy='" + node.y + "' r='" + (node.r + 7) + "' aria-hidden='true'/>");
      });
      if (!still) {
        out.push("<g class='wv-pulses' aria-hidden='true'>");
        d.lanes.forEach(function (lane) { for (var i = 0; i < lane.count; i++) out.push(wvDotHtml(lane, i, clockMs)); });
        out.push("</g>");
      }
      L.hubs.forEach(function (hub) {
        var c = hub.coordinator;
        out.push("<g class='wv-hub" + (c.reachable ? "" : " down") + "' transform='translate(" + hub.x + " " + hub.y + ")'>" +
          "<title>" + escapeHtml(hostOf(c.url) + " · " + c.agentsOnline + " machines online" + (c.reachable ? "" : " · not reachable")) + "</title>" +
          "<circle r='" + HUB_R + "'/><text class='wv-hub-region' y='4' text-anchor='middle'>" + escapeHtml(String(c.region || "?").toUpperCase()) + "</text></g>");
      });
      L.agents.forEach(function (node, i) {
        var a = node.row.agent;
        var lbl = L.labels[i];
        var sel = s.selectedId === a.id;
        out.push("<g data-node='" + escapeHtml(a.id) + "' data-index='" + i + "' class='wv-node st-" + escapeHtml(a.status) + (a.mine ? " mine" : "") + (sel ? " selected" : "") +
          "' transform='translate(" + node.x + " " + node.y + ")' role='button' tabindex='" + (i === focus ? "0" : "-1") + "' aria-pressed='" + sel + "' aria-label='" + escapeHtml(wvNodeLabel(node.row)) + "'>" +
          "<title>" + escapeHtml(lbl.full) + "</title><circle r='" + node.r + "'/>" + (a.mine ? "<circle class='wv-mine-ring' r='" + (node.r + 4) + "'/>" : "") +
          (path.machines.indexOf(a.id) >= 0 ? "<circle class='wv-serving-ring' r='" + (node.r + (a.mine ? 8 : 5)) + "'/>" : "") +
          "</g>");
      });
      if (L.you) out.push("<g class='wv-you' transform='translate(" + L.you.x + " " + L.you.y + ")' aria-hidden='true'><circle r='10'/></g>");
      // Every word last, over the lines and the nodes, each with a halo in the card's colour.
      // Machine names come placed by placeLabels; a hidden one shows while its machine is hovered,
      // focused or selected.
      out.push("<g class='wv-labels' aria-hidden='true'>");
      L.rings.forEach(function (ring) { out.push("<text class='wv-ring-label' x='" + ring.lx + "' y='" + ring.ly + "'>" + ring.ms + " ms</text>"); });
      view.links.forEach(function (link) {
        var a = hubById[link.from], b = hubById[link.to];
        if (a && b) out.push("<text class='wv-clink-label' x='" + (a.x + b.x) / 2 + "' y='" + ((a.y + b.y) / 2 - 8) + "' text-anchor='middle'>" + escapeHtml(formatMs(link.rttMs)) + "</text>");
      });
      if (L.you) {
        L.hubs.forEach(function (hub) {
          if (wvLaneOf(d, "you:" + hub.id) && typeof hub.coordinator.myRttMs === "number") out.push("<text class='wv-you-link-label' x='" + ((L.you.x + hub.x) / 2 + 6) + "' y='" + ((L.you.y + hub.y) / 2 + 40) + "'>" + escapeHtml(formatMs(hub.coordinator.myRttMs)) + "</text>");
        });
        out.push("<text class='wv-you-label' x='" + L.you.x + "' y='" + (L.you.y + 26) + "' text-anchor='middle'>You</text>");
      }
      L.hubs.forEach(function (hub) { out.push("<text class='wv-hub-host' x='" + hub.x + "' y='" + (hub.y + RING_MAX + 22) + "' text-anchor='middle'>" + escapeHtml(hostOf(hub.coordinator.url)) + "</text>"); });
      var shown = L.labels.filter(function (l) { return l.visible; }).concat(L.labels.filter(function (l) { return !l.visible; }));
      shown.forEach(function (l) {
        var mine = L.agents.some(function (n) { return n.id === l.id && n.row.agent.mine; });
        var on = l.id === s.hoverId || l.id === s.selectedId;
        out.push("<text class='wv-nlabel" + (mine ? " mine" : "") + (l.visible ? "" : " off") + (on ? " on" : "") + "' data-label-for='" + escapeHtml(l.id) + "' x='" + l.x + "' y='" + l.y + "' text-anchor='" + l.anchor + "'>" + escapeHtml(l.text) + "</text>");
      });
      out.push("</g>");
      out.push("</svg>");
      out.push("<p class='wv-vh' id='wvActivity'>" + escapeHtml(activitySummary(view)) + "</p>");
      out.push("<div class='wv-legend' aria-hidden='true'>" + (still ? "<span class='wv-live'><i class='wv-dot idle'></i>Live</span>" : "") +
        "<span><i class='wv-dot idle'></i>Idle</span><span><i class='wv-dot busy'></i>Busy</span><span><i class='wv-dot stale'></i>Not seen lately</span><span><i class='wv-dot mine'></i>Yours</span>" +
        "<span><i class='wv-dot pulse'></i>" + (still ? "Thicker line: more calls" : "Moving dots: calls in flight") + "</span><span><i class='wv-dot path'></i>Your request</span>" +
        "<span>Distance from a coordinator: its round trip to the machine. Size: model slots.</span></div>");
      return out.join("");
    }

    function wvChips(a, max) {
      var list = a.models.slice(0, max);
      var html = list.map(function (m) { return "<span class='wv-chip" + (m === a.activeModel ? " active" : "") + "'>" + escapeHtml(m) + "</span>"; }).join("");
      if (!list.length) html = "<span class='muted'>None reported</span>";
      if (a.modelsTotal > list.length) html += "<span class='muted'>+" + (a.modelsTotal - list.length) + (max >= a.models.length ? " more" : "") + "</span>";
      return html;
    }

    function wvDetailsHtml(view, row) {
      if (!row) return "<h3>Select a machine</h3><p class='muted'>Hover or select a machine to see its models, class, region, load and how far it is from you.</p>";
      var a = row.agent;
      var serving = yourPath(view).machines.indexOf(a.id) >= 0;
      return "<h3 class='wv-name'>" + escapeHtml(displayName(a)) + "</h3>" +
        "<span class='wv-badges'><span class='wv-pill st-" + escapeHtml(a.status) + "'>" + wvStatusText(a.status) + "</span>" + (a.mine ? "<span class='wv-pill yours'>Yours</span>" : "") + (serving ? "<span class='wv-pill yours'>Serving you</span>" : "") + "</span>" +
        "<p class='wv-activity'>" + escapeHtml(activityText(a)) + "</p>" +
        "<dl>" +
        "<dt>Latency to you</dt><dd>" + escapeHtml(formatMs(row.estimateMs, true)) + " <span class='muted'>estimate</span></dd>" +
        "<dt>Region</dt><dd>" + escapeHtml(regionText(a) + (a.continent ? " · " + continentName(a.continent) : "")) + "</dd>" +
        "<dt>Class</dt><dd>" + escapeHtml(a.computeClass + (a.tier ? " · " + a.tier : "") + (a.vramGb ? " · " + a.vramGb + " GB" : "")) + "</dd>" +
        "<dt>Load</dt><dd>" + a.slotsUsed + " of " + wvPlural(a.slots, "slot") + " in use</dd>" +
        "<dt>Coordinator</dt><dd>" + escapeHtml(wvCoordName(view, a.coordinatorId) + " · " + formatMs(a.rttMs)) + "</dd>" +
        "<dt>Models</dt><dd class='wv-models'>" + wvChips(a, a.models.length) + "</dd>" +
        "</dl>";
    }

    function wvCardsHtml(view, d, s) {
      if (!d.visible.length) return "<div class='wv-card wv-empty'>" + (s.scope === "mine" ? "None of your machines match." : "No machines match these filters.") + "</div>";
      var sortName = (SORTS.find(function (x) { return x[0] === s.sortKey; }) || SORTS[0])[1].toLowerCase();
      return "<ul class='wv-cards' aria-label='Machines, sorted by " + sortName + "'>" + d.visible.map(function (r) {
        var a = r.agent;
        var c = view.coordinators.find(function (x) { return x.id === a.coordinatorId; });
        return "<li class='wv-card wv-wcard" + (a.mine ? " mine" : "") + "'>" +
          "<div class='wv-whead'><span class='wv-dot " + escapeHtml(a.status) + "' aria-hidden='true'></span>" +
          "<span class='wv-wname" + (a.mine ? "" : " masked") + "'>" + escapeHtml(displayName(a)) + "</span>" +
          (a.mine ? "<span class='wv-pill yours'>Yours</span>" : "") +
          "<span class='wv-lat near-" + nearness(r.estimateMs) + "' title='Estimated: your round trip to its coordinator plus the coordinator&#39;s to the machine'>" + escapeHtml(formatMs(r.estimateMs, true)) + "</span></div>" +
          "<div class='wv-wmeta'><span>" + wvStatusText(a.status) + " · " + a.slotsUsed + "/" + a.slots + " slots</span><span>" + escapeHtml(regionText(a)) + "</span>" +
          "<span>" + escapeHtml(a.computeClass + (a.tier ? " · " + a.tier : "")) + "</span><span>via " + escapeHtml(c ? c.region || hostOf(c.url) : "") + "</span></div>" +
          "<div class='wv-models'>" + wvChips(a, 4) + "</div></li>";
      }).join("") + "</ul>";
    }

    function wvCoordsHtml(view) {
      var rows = view.coordinators.map(function (c) {
        return "<div class='wv-crow'><span class='wv-cdot" + (c.reachable ? " on" : " err") + "' aria-hidden='true'></span>" +
          "<div class='wv-ctext'><span class='wv-ctitle'>" + escapeHtml(hostOf(c.url) + (c.self ? " · answering" : "")) + "</span>" +
          "<span class='wv-desc'>" + escapeHtml((c.region || "region unknown") + (c.continent ? " · " + continentName(c.continent) : "") + " · " + (c.reachable ? wvPlural(c.agentsOnline, "machine") + " online" : "not reachable right now")) + "</span></div>" +
          "<span class='wv-desc'>Your round trip " + escapeHtml(formatMs(c.myRttMs)) + "</span></div>";
      });
      view.links.forEach(function (l) {
        rows.push("<div class='wv-crow'><span class='wv-desc wrap'>" + escapeHtml(wvCoordName(view, l.from) + " ↔ " + wvCoordName(view, l.to) + " · meshed" + (l.rttMs !== null ? ", " + l.rttMs + " ms apart" : "")) + "</span></div>");
      });
      return rows.join("") || "<div class='wv-crow'><span class='muted'>No coordinators answered.</span></div>";
    }

    function wvNoticeHtml(reason) {
      var text = reason === "rate_limited" ? "The coordinator asked us to slow down; the view will refresh in a moment."
        : reason === "not_authenticated" ? "Sign in to see the network."
        : "Couldn't reach a coordinator. The view will refresh when one answers.";
      return "<h3>The network isn't reachable right now</h3><p class='muted'>" + escapeHtml(text) + "</p>";
    }
`;

export function worldPageContent(): string {
  return `
    <style nonce="${CSP_NONCE}">
      .wv { min-width: 0; }
      .wv .set-lead { margin-bottom: 14px; }
      .wv-vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .wv-card { border: 1px solid var(--card-border); border-radius: var(--radius-lg); background: var(--card); min-width: 0; }
      .wv-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-bottom: 18px; }
      .wv-stat { border: 1px solid var(--card-border); border-radius: var(--radius-lg); background: var(--card); padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .wv-desc { font-size: var(--fs-xs); color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wv-big { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); }
      .wv-notice { padding: 20px; margin-bottom: 14px; }
      .wv-notice h3 { margin: 0 0 6px; font-size: var(--fs-base); font-weight: 600; }
      .wv-notice p { margin: 0; line-height: var(--lh-ui); }
      .wv-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
      .wv-toolbar .wv-sorts { margin-left: auto; }
      .wv-seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); overflow: hidden; }
      .wv-seg button { border: 0; border-radius: 0; min-height: var(--control-md); padding: 4px 12px; background: transparent; color: var(--text-secondary); }
      .wv-seg button + button { border-left: 1px solid var(--border-strong); }
      .wv-seg button[aria-pressed="true"] { background: var(--bg-elevated); color: var(--text); font-weight: 600; }
      .wv-model { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-secondary); }
      .wv-model > span { text-transform: none; letter-spacing: normal; font-weight: 400; }
      .wv-model select { width: auto; min-width: 140px; max-width: 240px; }
      .wv-graph-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 10px; align-items: start; }
      @media (max-width: 860px) { .wv-graph-wrap { grid-template-columns: minmax(0, 1fr); } .wv-toolbar .wv-sorts { margin-left: 0; } }
      .wv-graph-card { padding: 8px; }
      .wv-graph { display: block; width: 100%; height: auto; max-height: 70vh; }
      .wv-ring { fill: none; stroke: var(--border-strong); stroke-dasharray: 2 4; }
      .wv-ring-label { fill: var(--muted); font-size: 10px; }
      .wv-labels text { paint-order: stroke; stroke: var(--card); stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }
      .wv-nlabel { fill: var(--text-secondary); font-size: 10.5px; }
      .wv-nlabel.mine { fill: var(--text); font-weight: 600; }
      .wv-nlabel.off { display: none; }
      .wv-nlabel.off.on, .wv-nlabel.off.focus { display: inline; fill: var(--text); stroke-width: 4px; }
      .wv-clink { stroke: var(--accent-secondary); stroke-width: 2.5; opacity: 0.7; }
      .wv-clink-label, .wv-you-link-label { fill: var(--text-secondary); font-size: 11px; }
      .wv-you-link { stroke: var(--muted); stroke-width: 1.2; stroke-dasharray: 5 5; }
      .wv-spoke { stroke: var(--border-strong); stroke-width: 1; }
      .wv-spoke.lvl-1 { stroke: var(--accent-secondary); stroke-opacity: 0.5; stroke-width: 1.5; }
      .wv-spoke.lvl-2 { stroke: var(--accent-secondary); stroke-opacity: 0.65; stroke-width: 2.25; }
      .wv-spoke.lvl-3 { stroke: var(--accent-secondary); stroke-opacity: 0.8; stroke-width: 3; }
      .wv-clink.lvl-1 { opacity: 0.8; stroke-width: 3; }
      .wv-clink.lvl-2 { opacity: 0.9; stroke-width: 3.75; }
      .wv-clink.lvl-3 { opacity: 1; stroke-width: 4.5; }
      .wv-spoke.yours, .wv-you-link.yours { stroke: var(--brand); stroke-opacity: 1; stroke-width: 2.5; stroke-dasharray: none; }
      .wv-spoke.on { stroke: var(--brand); stroke-width: 2; }
      .wv-beat { stroke: var(--accent-secondary); stroke-width: 5; stroke-opacity: 0; stroke-linecap: round; }
      .wv-glow { fill: color-mix(in srgb, var(--accent-secondary) 16%, transparent); stroke: color-mix(in srgb, var(--accent-secondary) 35%, transparent); stroke-width: 1; }
      .wv-pulse { fill: var(--accent-secondary); stroke: var(--bg-surface); stroke-width: 1; }
      .wv-pulse.yours { fill: var(--brand); }
      .wv-pulse.faint { fill-opacity: 0.45; stroke-opacity: 0.45; }
      .wv-node .wv-serving-ring { fill: none; stroke: var(--brand); stroke-width: 2; stroke-dasharray: 3 2; }
      .wv-paused .wv-pulses { visibility: hidden; }
      @media (prefers-reduced-motion: reduce) { .wv-pulses, .wv-beat { display: none; } }
      .wv-hub circle { fill: var(--accent-secondary); stroke: var(--bg-surface); stroke-width: 3; }
      .wv-hub.down circle { fill: var(--muted); }
      .wv-hub-region { fill: var(--on-accent); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
      .wv-hub-host { fill: var(--text); font-size: 11px; font-weight: 500; }
      .wv-node { cursor: pointer; outline: none; }
      .wv-node circle { stroke: var(--bg-surface); stroke-width: 1.5; }
      .wv-node.st-idle circle { fill: var(--green); }
      .wv-node.st-busy circle { fill: var(--yellow); }
      .wv-node.st-stale circle { fill: var(--muted); }
      .wv-node .wv-mine-ring { fill: none; stroke: var(--text); stroke-width: 2; }
      .wv-node.selected circle:first-child, .wv-node:focus-visible circle:first-child { stroke: var(--text); stroke-width: 3; }
      .wv-node:focus-visible circle:first-child { stroke: var(--focus-ring); }
      .wv-you circle { fill: var(--text); stroke: var(--bg-surface); stroke-width: 3; }
      .wv-you-label { fill: var(--text); font-size: 11px; font-weight: 600; }
      .wv-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 6px 8px 2px; font-size: var(--fs-2xs); color: var(--text-secondary); }
      .wv-legend span { display: inline-flex; align-items: center; gap: 5px; }
      .wv-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
      .wv-dot.idle { background: var(--green); }
      .wv-dot.busy { background: var(--yellow); }
      .wv-dot.mine { background: none; box-shadow: inset 0 0 0 2px var(--text); }
      .wv-dot.pulse { width: 6px; height: 6px; background: var(--accent-secondary); }
      .wv-dot.path { width: 14px; height: 3px; border-radius: 2px; background: var(--brand); }
      .wv-live { font-weight: 600; color: var(--text); }
      .wv-activity { font-size: var(--fs-xs); color: var(--text); }
      .wv-details { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
      .wv-details h3 { margin: 0; font-size: var(--fs-base); font-weight: 600; }
      .wv-details .wv-name { font-family: var(--font-mono); word-break: break-all; }
      .wv-details p { margin: 0; line-height: var(--lh-ui); }
      .wv-badges { display: flex; gap: 6px; }
      .wv-details dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: var(--fs-xs); }
      .wv-details dt { color: var(--text-secondary); }
      .wv-details dd { margin: 0; color: var(--text); min-width: 0; }
      .wv-pill { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: var(--fs-2xs); border: 1px solid var(--border-strong); color: var(--text-secondary); }
      .wv-pill.st-idle { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
      .wv-pill.st-busy { color: var(--text); border-color: color-mix(in srgb, var(--yellow) 60%, transparent); }
      .wv-pill.yours { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 45%, transparent); }
      .wv-models { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
      .wv-chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 7px; border-radius: 999px; font-size: var(--fs-2xs); font-family: var(--font-mono); background: var(--bg-soft); border: 1px solid var(--card-border); color: var(--text-secondary); }
      .wv-chip.active { color: var(--text); border-color: var(--border-strong); }
      .wv-cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 10px; }
      .wv-wcard { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
      .wv-wcard.mine { border-color: color-mix(in srgb, var(--brand) 55%, var(--card-border)); }
      .wv-whead { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .wv-wname { font-size: var(--fs-sm); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wv-wname.masked { font-family: var(--font-mono); font-weight: 500; }
      .wv-lat { margin-left: auto; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--text-secondary); white-space: nowrap; }
      .wv-lat.near-near { color: var(--green); }
      .wv-wmeta { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: var(--fs-xs); color: var(--text-secondary); }
      .wv-empty { padding: 14px 16px; color: var(--muted); font-size: 12.5px; }
      .wv-crow { display: flex; align-items: center; gap: 12px; padding: 12px 16px; min-width: 0; }
      .wv-crow + .wv-crow { border-top: 1px solid var(--card-border); }
      .wv-ctext { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
      .wv-ctitle { font-size: 13.5px; font-weight: 500; color: var(--text); overflow-wrap: anywhere; }
      .wv-cdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
      .wv-cdot.on { background: var(--green); }
      .wv-cdot.err { background: var(--red); }
      .wv-crow > .wv-desc.wrap { white-space: normal; overflow-wrap: anywhere; }
      @media (max-width: 600px) {
        .wv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wv-crow { flex-wrap: wrap; }
        .wv-crow > .wv-desc { flex-basis: 100%; padding-left: 20px; white-space: normal; }
        .wv-crow > .wv-desc.wrap { padding-left: 0; }
      }
      .wv-foot { margin: 8px 4px 0; color: var(--muted); font-size: 12px; line-height: var(--lh-ui); }
    </style>
    <section class="set-section wv" id="sec-world" data-section="world">
      <h2 class="set-title">Network</h2>
      <p class="set-lead">Every EdgeCoder machine online, worldwide, and the coordinators that connect them. Other people's machines are masked; yours are named.</p>
      <div id="wvError" class="callout warn hidden" role="status"></div>
      <div id="wvNotice" class="wv-card wv-notice hidden"></div>
      <section class="wv-stats" id="wvStats" aria-label="Network summary" aria-busy="true">
        <div class="wv-stat"><span class="wv-desc">Loading the network…</span></div>
      </section>
      <div id="wvBody" class="hidden">
        <section aria-label="Machines">
          <div class="wv-toolbar">
            <div class="wv-seg" role="group" aria-label="View">
              <button type="button" data-mode="graph" aria-pressed="true">Graph</button><button type="button" data-mode="cards" aria-pressed="false">Cards</button>
            </div>
            <div class="wv-seg" role="group" aria-label="Whose machines">
              <button type="button" data-scope="all" aria-pressed="true">Everyone</button><button type="button" data-scope="mine" aria-pressed="false" id="wvMineBtn">My machines (0)</button>
            </div>
            <label class="wv-model"><span>Model</span><select id="wvModel"><option value="">Any model</option></select></label>
            <div class="wv-seg wv-sorts hidden" id="wvSorts" role="group" aria-label="Sort machines">
              <button type="button" data-sort="latency" aria-pressed="true">Nearest</button><button type="button" data-sort="region" aria-pressed="false">Region</button><button type="button" data-sort="model" aria-pressed="false">Model</button><button type="button" data-sort="status" aria-pressed="false">Status</button>
            </div>
          </div>
          <div class="wv-graph-wrap" id="wvGraphWrap">
            <div class="wv-card wv-graph-card" id="wvGraph"></div>
            <aside class="wv-card wv-details" id="wvDetails" aria-label="Machine details" aria-live="polite"></aside>
          </div>
          <div id="wvCards" class="hidden"></div>
          <p class="wv-foot hidden" id="wvTruncated"></p>
        </section>
        <h3 class="set-group" id="wvCoordTitle">Coordinators</h3>
        <div class="wv-card" id="wvCoords" aria-labelledby="wvCoordTitle"></div>
        <p class="wv-foot">Latency to a machine is an estimate: your round trip to its coordinator (measured from this browser) plus the coordinator's round trip to the machine (measured on its connection). Regions come from where a machine is hosted or was enrolled; no location lookups are made.</p>
      </div>
    </section>`;
}

export function worldPageScript(): string {
  return `
    ${WORLD_VIEW_BROWSER_LIB}
    ${WORLD_PING_SCRIPT}
    ${WORLD_RENDER_SCRIPT}
    (function () {
      var $ = function (id) { return document.getElementById(id); };
      var motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
      var s = { mode: "graph", scope: "all", model: "", sortKey: "latency", sortDir: "asc", selectedId: null, hoverId: null, focusIndex: 0, reducedMotion: !!(motionQuery && motionQuery.matches), paused: document.hidden, clockMs: 0 };
      var view = null;
      var myRtt = {};
      var pingedAt = 0;
      var pinging = false;
      var timer = null;

      function withRtt(v) {
        return Object.assign({}, v, { coordinators: v.coordinators.map(function (c) { return Object.assign({}, c, { myRttMs: typeof myRtt[c.id] === "number" ? myRtt[c.id] : null }); }) });
      }

      function syncToolbar(v) {
        document.querySelectorAll("[data-mode]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === s.mode)); });
        document.querySelectorAll("[data-scope]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-scope") === s.scope)); });
        document.querySelectorAll("[data-sort]").forEach(function (b) {
          var on = b.getAttribute("data-sort") === s.sortKey;
          var label = (SORTS.find(function (x) { return x[0] === b.getAttribute("data-sort"); }) || ["", ""])[1];
          b.setAttribute("aria-pressed", String(on));
          b.innerHTML = escapeHtml(label) + (on ? "<span aria-hidden='true'> " + (s.sortDir === "asc" ? "↑" : "↓") + "</span><span class='wv-vh'>, " + (s.sortDir === "asc" ? "ascending" : "descending") + "</span>" : "");
        });
        $("wvSorts").classList.toggle("hidden", s.mode !== "cards");
        $("wvMineBtn").textContent = "My machines (" + v.totals.mine + ")";
        var sel = $("wvModel");
        var opts = v.models.filter(function (m) { return m.online > 0 || m.model === s.model; });
        var key = JSON.stringify(opts);
        if (sel.getAttribute("data-key") !== key) {
          sel.setAttribute("data-key", key);
          sel.innerHTML = "<option value=''>Any model</option>" + opts.map(function (m) { return "<option value='" + escapeHtml(m.model) + "'>" + escapeHtml(m.model + " (" + m.online + ")") + "</option>"; }).join("");
          sel.value = s.model;
        }
      }

      function render() {
        if (!view) return;
        var v = withRtt(view);
        var d = wvDerive(v, s);
        if (s.selectedId && !d.visible.some(function (r) { return r.agent.id === s.selectedId; })) s.selectedId = null;
        var active = document.activeElement;
        var focusedNode = active && active.getAttribute && active.getAttribute("data-node");
        $("wvStats").innerHTML = wvStatsHtml(v, d);
        $("wvStats").setAttribute("aria-busy", "false");
        syncToolbar(v);
        $("wvGraphWrap").classList.toggle("hidden", s.mode !== "graph");
        $("wvCards").classList.toggle("hidden", s.mode !== "cards");
        if (s.mode === "graph") {
          s.clockMs = Date.now();
          $("wvGraph").innerHTML = wvGraphHtml(v, d, s);
          syncPause();
          var detailId = s.hoverId || s.selectedId;
          $("wvDetails").innerHTML = wvDetailsHtml(v, d.rows.find(function (r) { return r.agent.id === detailId; }) || null);
          if (focusedNode) {
            var again = $("wvGraph").querySelector("[data-node='" + CSS.escape(focusedNode) + "']");
            if (again) again.focus();
          }
        } else {
          $("wvCards").innerHTML = wvCardsHtml(v, d, s);
        }
        $("wvCoords").innerHTML = wvCoordsHtml(v);
        var tr = $("wvTruncated");
        tr.classList.toggle("hidden", !v.truncated);
        tr.textContent = v.truncated ? "Showing the first " + v.agents.length + " of " + v.totals.agents + " machines." : "";
        $("wvBody").classList.remove("hidden");
      }

      async function measure() {
        if (!view || pinging || Date.now() - pingedAt < ${WORLD_PING_EVERY_MS}) return;
        pinging = true;
        try {
          var targets = view.coordinators.filter(function (c) { return c.pingUrl; }).slice(0, 16);
          for (var i = 0; i < targets.length; i++) {
            var ms = await pingCoordinator(targets[i].pingUrl);
            if (ms === null) delete myRtt[targets[i].id]; else myRtt[targets[i].id] = ms;
            render();
          }
          pingedAt = Date.now();
        } finally {
          pinging = false;
        }
      }

      async function refresh() {
        clearTimeout(timer);
        try {
          var res = await fetch("/portal/api/network/world", { credentials: "include", headers: { accept: "application/json" } });
          var body = null;
          try { body = await res.json(); } catch (e) {}
          if (res.status === 401) { window.location.href = "/portal"; return; }
          if (res.ok && body && body.connected) {
            view = body;
            $("wvError").classList.add("hidden");
            $("wvNotice").classList.add("hidden");
            render();
            measure();
          } else if (view) {
            // A rate limit or a coordinator blip: keep the last view up.
            if (res.status !== 429) { $("wvError").textContent = "Couldn't refresh the network view. Showing the last one."; $("wvError").classList.remove("hidden"); }
          } else {
            $("wvNotice").innerHTML = wvNoticeHtml(body && body.reason);
            $("wvNotice").classList.remove("hidden");
            $("wvStats").innerHTML = "";
            $("wvStats").setAttribute("aria-busy", "false");
          }
        } catch (err) {
          $("wvError").textContent = view ? "Couldn't refresh the network view. Showing the last one." : "Couldn't load the network.";
          $("wvError").classList.remove("hidden");
        }
        if (!document.hidden) timer = setTimeout(refresh, ${WORLD_REFRESH_MS});
      }
      // A hidden tab pauses the pulses; showing it again resumes them (and refreshes).
      function syncPause() {
        var svg = $("wvGraph").querySelector("svg");
        if (!svg) return;
        svg.classList.toggle("wv-paused", s.paused);
        try { if (s.paused) svg.pauseAnimations(); else svg.unpauseAnimations(); } catch (e) {}
      }
      document.addEventListener("visibilitychange", function () {
        s.paused = document.hidden;
        syncPause();
        if (!document.hidden) refresh();
      });
      if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener("change", function () { s.reducedMotion = motionQuery.matches; render(); });

      document.querySelectorAll("[data-mode]").forEach(function (b) { b.addEventListener("click", function () { s.mode = b.getAttribute("data-mode"); render(); }); });
      document.querySelectorAll("[data-scope]").forEach(function (b) { b.addEventListener("click", function () { s.scope = b.getAttribute("data-scope"); render(); }); });
      document.querySelectorAll("[data-sort]").forEach(function (b) {
        b.addEventListener("click", function () {
          var k = b.getAttribute("data-sort");
          if (s.sortKey === k) s.sortDir = s.sortDir === "asc" ? "desc" : "asc"; else { s.sortKey = k; s.sortDir = "asc"; }
          render();
        });
      });
      $("wvModel").addEventListener("change", function () { s.model = $("wvModel").value; render(); });

      var graph = $("wvGraph");
      function nodeOf(t) { return t && t.closest ? t.closest("[data-node]") : null; }
      function toggle(n) { s.focusIndex = Number(n.getAttribute("data-index")) || 0; var id = n.getAttribute("data-node"); s.selectedId = s.selectedId === id ? null : id; render(); }
      graph.addEventListener("click", function (e) { var n = nodeOf(e.target); if (n) { toggle(n); var again = graph.querySelector("[data-index='" + s.focusIndex + "']"); if (again) again.focus(); } });
      graph.addEventListener("mouseover", function (e) { var n = nodeOf(e.target); var id = n ? n.getAttribute("data-node") : null; if (id !== s.hoverId) { s.hoverId = id; render(); } });
      graph.addEventListener("mouseleave", function () { if (s.hoverId) { s.hoverId = null; render(); } });
      // A machine whose name is hidden on the map (it would cover something) shows it while focused.
      function focusLabel(n, on) { var l = n && graph.querySelector("[data-label-for='" + CSS.escape(n.getAttribute("data-node")) + "']"); if (l) l.classList.toggle("focus", on); }
      graph.addEventListener("focusin", function (e) { var n = nodeOf(e.target); if (n) { s.focusIndex = Number(n.getAttribute("data-index")) || 0; focusLabel(n, true); } });
      graph.addEventListener("focusout", function (e) { focusLabel(nodeOf(e.target), false); });
      graph.addEventListener("keydown", function (e) {
        var n = nodeOf(e.target);
        if (!n) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(n); var again = graph.querySelector("[data-index='" + s.focusIndex + "']"); if (again) again.focus(); return; }
        if (e.key === "Escape") { s.selectedId = null; render(); return; }
        var nodes = graph.querySelectorAll("[data-node]");
        var count = nodes.length, i = Number(n.getAttribute("data-index")) || 0, next = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % count;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + count) % count;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = count - 1;
        if (next === null) return;
        e.preventDefault();
        nodes[i].setAttribute("tabindex", "-1");
        nodes[next].setAttribute("tabindex", "0");
        s.focusIndex = next;
        nodes[next].focus();
      });

      refresh();
    })();
  `;
}

export function registerSettingsWorldPage(app: FastifyInstance): void {
  app.get("/portal/settings/world", async (_req, reply) => {
    return reply.type("text/html").send(settingsPage("world", "The network, worldwide.", worldPageContent(), worldPageScript(), { wide: true }));
  });
}

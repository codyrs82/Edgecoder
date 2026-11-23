// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The web bots page's parts for a bot leading with its owner's frontier key (docs/frontier-keys.md,
 * "Bots and your key"): the three-choice ask card and the read-only status line. Plain browser JS
 * included in the bots page script, so it uses that page's escapeHtml, canControl, online and act.
 */
export const BOT_FRONTIER_PAGE_JS = `
    function frontierAskCard(b, p) {
      // Its ask to use the owner's frontier key: this run, every run today, or no (only the owner's account can answer).
      var fchoices = canControl()
        ? '<button type="button" class="primary sm" data-frontier="run" data-call="' + escapeHtml(p.callId) + '">Approve this run</button><button type="button" class="sm" data-frontier="day" data-call="' + escapeHtml(p.callId) + '">Approve for today</button><button type="button" class="sm danger" data-frontier="decline" data-call="' + escapeHtml(p.callId) + '">Decline</button>'
        : '<span class="on-mac">Answer on your machine' + (online() ? "" : " (it's offline)") + "</span>";
      var fq = p.detail || "Use your frontier key for this run?";
      return '<div class="ask-card" role="group" aria-label="' + escapeHtml(b.name + " asks: " + fq) + '"><div class="ask-q">' + escapeHtml(b.name + " asks: " + fq) + '</div><div class="muted u-fs-12">Your own key, billed to you by the provider. No answer in 30 minutes: it carries on without it.</div><div class="ask-choices">' + fchoices + "</div></div>";
    }
    function frontierDetail(b) {
      return (b.frontier ? '<div class="d-sub">' + escapeHtml((b.frontier.on ? (b.frontier.name || "Frontier") + " lead on (your key)" : "Frontier lead off") + " · $" + Number(b.frontier.spentTodayUsd || 0).toFixed(2) + " today") + '</div><div class="d-sub muted">Turned on and off in the EdgeCoder app on the machine.</div>' : "");
    }
    function frontierClick(e) {
      var f = e.target.closest && e.target.closest("[data-frontier]");
      if (f) {
        var fc = f.getAttribute("data-frontier"), fid = f.getAttribute("data-call");
        if (fc === "decline") act("Declined", "decline_frontier", { callId: fid });
        else act("Approved", "approve_frontier", { callId: fid, scope: fc === "day" ? "day" : "run" });
        return true;
      }
      return false;
    }
`;

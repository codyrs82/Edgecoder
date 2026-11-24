// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The web bots page's tool steps and approval cards (split out of bots.ts). A card offers Approve
 * and Deny; when the Mac says the call can be answered for the rest of the run (`allowRun`, newer
 * Macs), also "Allow for this run": this call and later calls of the same kind run without asking
 * until the run ends (src/apps/ide/session-allowances.ts). Plain browser JS included in the bots
 * page script, so it uses that page's state, escapeHtml, canControl, online, act and frontierAskCard.
 */
export const BOT_ASKS_PAGE_JS = `
    function stepsHtml(steps) {
      if (!steps || !steps.length) return "";
      return '<ul class="steps" aria-label="Steps">' + steps.map(function(s) {
        var mark = s.status === "ok" ? "✓" : s.status === "error" ? "✗" : s.status === "denied" ? "denied" : s.status === "pending" ? "waiting" : "…";
        return '<li class="st-' + escapeHtml(s.status) + '"><span class="s-tool">' + escapeHtml(s.tool) + '</span><span class="s-detail" title="' + escapeHtml(s.detail) + '">' + escapeHtml(s.detail) + '</span><span class="s-mark">' + escapeHtml(mark) + "</span></li>";
      }).join("") + "</ul>";
    }
    function askCardsHtml() {
      var b = state.bot;
      if (!b.pending || !b.pending.length) return "";
      return b.pending.map(function(p) {
        if (p.tool === "use_frontier") return frontierAskCard(b, p);
        var q = p.tool === "run_shell" ? "Run this command?" : p.tool === "git_commit" ? "Commit?" : p.tool === "git_push" ? "Push?" : p.tool === "open_pull_request" ? "Open this pull request?" : "Allow " + p.tool.replace(/_/g, " ") + "?";
        var forRun = typeof p.allowRun === "string" && p.allowRun ? p.allowRun : "";
        var choices = canControl()
          ? '<button type="button" class="primary sm" data-approve="' + escapeHtml(p.callId) + '">Approve</button>' +
            (forRun ? '<button type="button" class="sm" data-allow-run="' + escapeHtml(p.callId) + '" title="' + escapeHtml("Also runs " + forRun + " without asking until this run ends") + '">Allow for this run</button>' : "") +
            '<button type="button" class="sm danger" data-deny="' + escapeHtml(p.callId) + '">Deny</button>' +
            (forRun ? '<span class="on-mac">' + escapeHtml("Allow for this run also runs " + forRun + " without asking until this run ends.") + "</span>" : "")
          : '<span class="on-mac">Approve on your machine' + (online() ? "" : " (it's offline)") + "</span>";
        return '<div class="ask-card" role="group" aria-label="' + escapeHtml(b.name + " asks: " + q) + '"><div class="ask-q">' + escapeHtml(b.name + " asks: " + q) + "</div>" + (p.detail ? "<code>" + escapeHtml(p.detail) + "</code>" : "") + '<div class="ask-choices">' + choices + "</div></div>";
      }).join("");
    }
    /* Approve, Allow for this run or Deny on a card; true when the click was one of them. */
    function askClick(e) {
      var a = e.target.closest && e.target.closest("[data-approve],[data-allow-run],[data-deny]");
      if (!a) return false;
      if (a.hasAttribute("data-allow-run")) act("Allowed for this run", "approve", { callId: a.getAttribute("data-allow-run"), approved: true, scope: "run" });
      else act(a.hasAttribute("data-approve") ? "Approved" : "Denied", "approve", { callId: a.getAttribute("data-approve") || a.getAttribute("data-deny"), approved: a.hasAttribute("data-approve") });
      return true;
    }
`;

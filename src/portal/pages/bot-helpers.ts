// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Browser helpers for bots on the web (the sidebar list and pages/bots.ts). The words mirror the
 * desktop app's (desktop/src/lib/bots.ts: statusChip, autoStatus, routineText, scheduleText,
 * computeText, triggerText, RUN_STATUS_TEXT), so a bot reads the same on the machine and on the web.
 * Every value from a bot goes through escapeHtml before it reaches innerHTML; the avatar colour is
 * set through the CSSOM (no style attributes: the portal's style-src has no 'unsafe-inline').
 */
export const CLIENT_BOT_HELPERS_JS = String.raw`
    var BOT_SCHEDULE_PRESETS = [["", "No fixed schedule (check-ins)"], ["every 30 minutes", "Every 30 minutes"], ["hourly", "Every hour"], ["every 6 hours", "Every 6 hours"], ["daily at 09:00", "Daily at 09:00"], ["0 9 * * 1-5", "Weekdays at 09:00"]];
    var BOT_HEARTBEAT_OPTIONS = [["15", "Every 15 minutes"], ["30", "Every 30 minutes"], ["60", "Every hour"], ["240", "Every 4 hours"], ["", "Never (only messages and triggers)"]];
    var BOT_COMPUTE_OPTIONS = [["auto", "Auto"], ["local_first", "Local first"], ["local_only", "This computer only"], ["mine_only", "My machines only"], ["network_only", "Network only"], ["model", "Specific model"]];
    var BOT_CLASS_NAMES = { gpu: "GPU", apple: "Apple", cpu: "CPU", "gpu.dc": "Datacenter GPU" };
    var BOT_RUN_STATUS_TEXT = { running: "Running", needs_approval: "Needs approval", done: "Done", failed: "Failed", budget: "Budget spent", cancelled: "Stopped", interrupted: "Interrupted" };
    function botHref(agentId, botId) { return "/portal/bots?m=" + encodeURIComponent(agentId) + "&b=" + encodeURIComponent(botId); }
    function botTitle(b) { return b.role && b.role.trim() ? b.name + " · " + b.role.trim() : b.name; }
    function botInitial(name) { var m = /[A-Za-z0-9À-￿]/.exec(String(name || "")); return m ? m[0].toUpperCase() : "?"; }
    function botStatusChip(b) {
      switch (b.status) {
        case "running": return { text: "Running", tone: "accent" };
        case "needs_approval": return { text: "Needs approval", tone: "warn" };
        case "error": return { text: "Failed", tone: "err" };
        case "paused": return { text: "Paused", tone: "muted" };
        case "over_budget": return { text: "Budget spent", tone: "warn" };
        case "needs_folder": return { text: "Needs folder", tone: "warn" };
        default: return { text: "Idle", tone: "muted" };
      }
    }
    function botRelative(ms, now) {
      now = now || Date.now();
      var diff = ms - now, min = Math.round(Math.abs(diff) / 60000);
      if (min < 1) return diff >= 0 ? "in less than a minute" : "just now";
      var t = min < 60 ? min + " min" : min < 1440 ? Math.round(min / 60) + " h" : Math.round(min / 1440) + " d";
      return diff >= 0 ? "in " + t : t + " ago";
    }
    function botScheduleText(s) {
      s = String(s || "").trim();
      if (!s) return "No schedule";
      for (var i = 0; i < BOT_SCHEDULE_PRESETS.length; i++) if (BOT_SCHEDULE_PRESETS[i][0] === s) return BOT_SCHEDULE_PRESETS[i][1];
      var l = s.toLowerCase();
      if (l.indexOf("every ") === 0 || l.indexOf("daily") === 0) return s.charAt(0).toUpperCase() + s.slice(1);
      return "Cron: " + s;
    }
    function botChecksIn(b) {
      var m = b.heartbeatMinutes === undefined ? 30 : b.heartbeatMinutes;
      return !!m && !String(b.schedule || "").trim() && !!(String(b.role || "").trim() || String(b.instructions || "").trim());
    }
    function botRoutineText(b) {
      if (String(b.schedule || "").trim()) return botScheduleText(b.schedule);
      if (!botChecksIn(b)) return "Works when you message it";
      var m = b.heartbeatMinutes == null ? 30 : b.heartbeatMinutes;
      for (var i = 0; i < BOT_HEARTBEAT_OPTIONS.length; i++) if (BOT_HEARTBEAT_OPTIONS[i][0] === String(m)) return "Checks in " + BOT_HEARTBEAT_OPTIONS[i][1].toLowerCase();
      return "Checks in " + (m % 60 === 0 ? "every " + m / 60 + " hours" : "every " + m + " minutes");
    }
    function botAutoStatus(b, now) {
      now = now || Date.now();
      if (b.status === "running") return { text: b.activity && !/^(Auto|Compute): /.test(b.activity) ? "Working: " + b.activity : "Working…", tone: "accent" };
      if (b.status === "needs_approval") return { text: "Waiting for your approval", tone: "warn" };
      if (b.status === "needs_folder") return { text: "Needs folder · set it up in the EdgeCoder app on " + ((b.machine && b.machine.machineName) || "your machine"), tone: "warn" };
      if (!b.enabled) return { text: "Paused", tone: "muted" };
      if (b.status === "over_budget" || b.held === "budget") return { text: "Budget spent · resumes tomorrow", tone: "warn" };
      if (b.held === "run_cap") return { text: "Daily limit of " + (b.maxRunsPerDay || 48) + " runs reached · resumes tomorrow", tone: "warn" };
      var failed = b.status === "error" ? "Last run failed · " : "", tone = b.status === "error" ? "err" : "muted", n = b.nextRun;
      if (n) {
        if (n.atMs <= now + 30000) return { text: n.kind === "start" ? "Starting…" : failed + "Continuing…", tone: b.status === "error" ? "err" : "accent" };
        var when = botRelative(n.atMs, now).replace(/^in /, "");
        var t = n.kind === "follow_up" ? "Continuing in " + when : n.kind === "start" ? "Starting in " + when : n.kind === "schedule" ? "Next run in " + when : "Next check in " + when;
        return { text: failed + t, tone: tone };
      }
      return { text: failed + "Waiting for a message", tone: tone };
    }
    function botComputeText(c) {
      c = c || { policy: "auto" };
      if (c.policy === "model") return c.model || "Specific model";
      if (c.policy === "network_only") return "Network " + (c.computeClass && BOT_CLASS_NAMES[c.computeClass] ? BOT_CLASS_NAMES[c.computeClass] + " " : "") + "only" + (c.model ? " · " + c.model.replace(/^network\//, "") : "");
      for (var i = 0; i < BOT_COMPUTE_OPTIONS.length; i++) if (BOT_COMPUTE_OPTIONS[i][0] === c.policy) return BOT_COMPUTE_OPTIONS[i][1];
      return "Auto";
    }
    function botTriggerText(t) {
      if (t.kind === "pr_opened") return "PR opened by others";
      if (t.kind === "pr") return "PR opened or updated" + (t.onlyOthers !== false ? " by others" : "") + (t.label ? " with label " + t.label : "");
      if (t.kind === "ci_failed") return "CI failed " + (t.scope === "default" ? "on the default branch" : t.scope === "prs" ? "on a PR" : "on the default branch or a PR");
      return "Issue labeled " + (String(t.label || "").trim() || "…");
    }
    function botCSats(n) {
      n = Number(n) || 0;
      if (n === 0) return "0";
      if (n < 0.01) return "<0.01";
      return n < 10 ? n.toFixed(2).replace(/\.?0+$/, "") : Math.round(n).toLocaleString("en-US");
    }
    /** The avatar: initial, shape, status dot. The colour is painted by paintBotAvatars (CSSOM). */
    function botAvatarHtml(b, online, size) {
      var chip = botStatusChip(b);
      var shape = /^(robot|orb|hex|block)$/.test(b.avatarShape || "") ? " shape-" + b.avatarShape : "";
      var color = /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "";
      return '<span class="bot-ava' + shape + (size ? " " + size : "") + '" data-bot-color="' + escapeHtml(color) + '" aria-hidden="true">' + escapeHtml(botInitial(b.name)) +
        '<span class="bot-dot ' + (online ? "tone-" + chip.tone : "offline") + '"></span></span>';
    }
    function paintBotAvatars(root) {
      (root || document).querySelectorAll("[data-bot-color]").forEach(function(el) {
        var c = el.getAttribute("data-bot-color");
        if (c && /^#[0-9a-fA-F]{6}$/.test(c)) el.style.setProperty("--bot-color", c);
      });
    }
`;

// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Code page's shared browser helpers (pages/code.ts): the relay calls and the words for its
 * answers. Plain JS included in the page script; it uses the shell's escapeHtml and showToast.
 *
 * Every call goes to the same portal routes the iPhone app's Code mode uses (routes/code.ts):
 *   GET  /portal/api/code/machines             the account's machines, projects and sessions
 *   POST /portal/api/code/:agentId/commands    { action, ...args } -> 202 { commandId }
 *   GET  /portal/api/code/commands/:commandId  polled until done, failed or expired
 * The portal takes the account from the session; the coordinator and the Mac check it again.
 */
export const CODE_COMMON_JS = String.raw`
    var CODE_WORDS = {
      not_authenticated: "Your session ended. Sign in again.",
      agent_not_connected: "Your Mac is offline. Open the EdgeCoder app on it to continue.",
      coordinator_unreachable: "Couldn't reach the network just now. Try again in a moment.",
      relay_off: "Code from your phone is off on this Mac. Turn it on in the EdgeCoder app: Settings, Code from your phone, On.",
      view_only: "This Mac shares its sessions as View only. To reply from here, set Code from your phone to On in the EdgeCoder app's Settings.",
      not_your_machine: "That Mac isn't one of yours.",
      not_this_account: "The account signed in on that Mac isn't this one.",
      rate_limited: "Too many requests at once. Try again in a few minutes.",
      agent_rate_limited: "Your Mac is taking a short break from remote requests. Try again in a few minutes.",
      no_such_session: "That session isn't on this Mac any more, or it's no longer shared.",
      no_such_project: "That project isn't trusted on this Mac.",
      auto_on_mac: "Auto mode is turned on from the Mac.",
      approve_on_mac: "This command is too long to check here. Approve it on the Mac.",
      no_pending_approval: "That approval was already answered or the turn ended.",
      checkpoint_gone: "That turn's checkpoint is gone (the app restarted).",
      unknown_command: "Your Mac didn't answer. Is the EdgeCoder app running?",
      expired: "Your Mac didn't answer. Is the EdgeCoder app running?",
      timed_out: "Your Mac didn't answer in time.",
      bad_request: "That request wasn't valid."
    };
    function codeErr(code, message) { var e = new Error(message || CODE_WORDS[code] || code || "Something went wrong"); e.code = code || ""; return e; }
    function codeErrorText(err) { var c = err && err.code; return (c && CODE_WORDS[c]) || String((err && err.message) || err); }

    /* fetch with the error code and message kept (the shell's api() keeps only the code). */
    async function codeFetch(path, body) {
      var res = await fetch(path, body === undefined ? { credentials: "include" } : { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var j = null;
      try { j = await res.json(); } catch (_e) { j = null; }
      if (!res.ok) throw codeErr((j && j.error) || String(res.status), j && j.message);
      return j || {};
    }
    function codeMachines() { return codeFetch("/portal/api/code/machines").then(function(r) { return r.machines || []; }); }

    /* One command to a Mac through the relay; its result is polled (~0.4 s, then slower, up to 30 s). */
    async function codeCommand(agentId, action, args) {
      var body = Object.assign({ action: action }, args || {});
      var r = await codeFetch("/portal/api/code/" + encodeURIComponent(agentId) + "/commands", body);
      if (!r.commandId) throw codeErr("bad_request", "Unexpected answer from the portal.");
      var end = Date.now() + 30000, wait = 400;
      while (Date.now() < end) {
        await new Promise(function(res) { setTimeout(res, wait); });
        wait = Math.min(1200, wait + 200);
        var s;
        try { s = await codeFetch("/portal/api/code/commands/" + encodeURIComponent(r.commandId)); }
        catch (err) { if (err.code === "unknown_command") throw err; continue; }
        if (s.status === "pending") continue;
        if (s.status === "done") return s.result;
        if (s.status === "expired") throw codeErr("expired");
        throw codeErr(s.error, s.message);
      }
      throw codeErr("timed_out");
    }

    function codeHref(agentId, sessionId) { return "/portal/code/" + encodeURIComponent(agentId) + "/" + encodeURIComponent(sessionId); }
    function codeAgo(ms) {
      if (!ms) return "a while ago";
      var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return "just now";
      if (s < 3600) return Math.round(s / 60) + " min ago";
      if (s < 86400) return Math.round(s / 3600) + " h ago";
      return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    function codeStatusChip(status) {
      if (status === "waiting") return { text: "Waiting for you", tone: "warn" };
      if (status === "running") return { text: "Working", tone: "accent" };
      return { text: "Idle", tone: "muted" };
    }
    var CODE_MODES = [["ask", "Ask", "Asks before every edit and command."], ["auto-edits", "Accept edits", "Edits files without asking; still asks before commands."], ["plan", "Plan", "Writes a plan first; nothing changes until you approve it."]];
    function codeModeLabel(mode) {
      if (mode === "auto") return "Auto (set on the Mac)";
      for (var i = 0; i < CODE_MODES.length; i++) if (CODE_MODES[i][0] === mode) return CODE_MODES[i][1];
      return mode || "";
    }
    /* Why a machine can't be read or driven from here, in plain words (null: it can). */
    function codeMachineNote(m, inSession) {
      if (!m) return "This Mac isn't one of yours, or it was removed from your account.";
      if (!m.online && m.controls === "off") return m.name + " is offline, or Code from your phone is off on it. On the Mac, open the EdgeCoder app, then Settings, Code from your phone, and choose On.";
      if (!m.online) return m.name + " is offline (last heard from " + codeAgo(m.updatedAtMs) + "). Open the EdgeCoder app on it to continue" + (inSession ? " this session." : "; what's below is from its last report.");
      if (m.controls === "off") return "Code from your phone is off on " + m.name + ". On the Mac, open the EdgeCoder app, then Settings, Code from your phone, and choose On.";
      if (m.controls === "view") return m.name + " shares its sessions as View only. To read and reply here, set Code from your phone to On in the EdgeCoder app's Settings.";
      return null;
    }
`;

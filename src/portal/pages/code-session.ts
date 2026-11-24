// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * One coding session on the Code page (/portal/code/:agentId/:sessionId): the conversation (messages,
 * tool steps, file changes), the running turn, queued messages, approval cards and plan approval,
 * with a composer, Stop, Undo and the permission mode. The same actions as the iPhone app's Code
 * mode, through the same relay; the Mac applies the same rules to both (every command that isn't
 * read-only asks, approving covers one call only and never adds an "always allow" rule, Auto is
 * set on the Mac only). Plain browser JS included in pages/code.ts; Mac text reaches innerHTML only
 * through escapeHtml or renderMarkdown (escaped first). Updates are polled: every 2.5 s while a
 * turn runs or waits, every 6 s otherwise, and slowly while the tab is hidden.
 */
export const CODE_SESSION_JS = String.raw`
    var cs = { agentId: "", sessionId: "", machine: null, summary: null, snap: null, older: [], more: null, sig: "", busy: false, timer: null, kick: 0, open: {}, changes: {}, error: "", first: true, mSig: "" };

    function canDrive() { return !!(cs.machine && cs.machine.online && cs.machine.controls === "on"); }
    function sessionStatus() {
      if (cs.snap) return cs.snap.pending.length ? "waiting" : (cs.snap.running || cs.snap.session.running) ? "running" : "idle";
      return cs.summary ? cs.summary.status : "idle";
    }
    function isActive() { return sessionStatus() !== "idle"; }
    function allMessages() { return cs.older.concat(cs.snap ? cs.snap.tail : []); }
    /* The newest turn that wasn't undone (Undo last turn), as the phone picks it. */
    function lastTurnId() {
      var list = allMessages(), i;
      for (i = list.length - 1; i >= 0; i--) if (list[i].turnId && !list[i].undone && list[i].role === "assistant") return list[i].turnId;
      for (i = list.length - 1; i >= 0; i--) if (list[i].turnId && !list[i].undone) return list[i].turnId;
      return null;
    }
    function awaitingPlan() {
      if (!cs.snap || sessionStatus() !== "idle" || cs.snap.session.mode !== "plan") return false;
      var t = cs.snap.tail;
      for (var i = t.length - 1; i >= 0; i--) if (t[i].role === "assistant") return t[i].plan === true;
      return false;
    }
    function timeText(ms) { return ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; }

    var STEP_STATUS = { ok: "done", error: "failed", denied: "denied", pending: "waiting for you", running: "running" };
    function stepsHtml(steps, key, openByDefault) {
      if (!steps || !steps.length) return "";
      var open = key in cs.open ? cs.open[key] : openByDefault;
      return '<details class="steps-d" data-key="' + escapeHtml(key) + '"' + (open ? " open" : "") + '><summary>' + escapeHtml(steps.length === 1 ? "1 tool step" : steps.length + " tool steps") + '</summary><ul class="steps">' + steps.map(function(s) {
        return '<li class="st-' + escapeHtml(s.status) + '"><span class="s-tool">' + escapeHtml(s.tool) + '</span><span class="s-detail" title="' + escapeHtml(s.detail) + '">' + escapeHtml(s.detail) + '</span><span class="s-status">' + escapeHtml(STEP_STATUS[s.status] || s.status) + "</span></li>";
      }).join("") + "</ul></details>";
    }
    function changesHtml(m) {
      if (!m.turnId || !m.changedFiles || !m.changedFiles.length) return m.undone ? '<div class="cmsg-foot">Undone</div>' : "";
      var n = m.changedFiles.length, key = "chg-" + m.turnId;
      var label = (n === 1 ? "1 file changed" : n + " files changed") + (m.undone ? " (undone)" : "");
      var open = !!cs.open[key];
      var body = cs.changes[m.turnId] ? cs.changes[m.turnId] : '<div class="muted u-fs-12">' + escapeHtml(m.changedFiles.join(", ")) + "</div>";
      return '<details class="chg-d" data-key="' + escapeHtml(key) + '" data-turn="' + escapeHtml(m.turnId) + '"' + (open ? " open" : "") + "><summary>" + CODE_ICONS.file + "<span>" + escapeHtml(label) + '</span></summary><div class="chg-body">' + body + "</div></details>";
    }
    function messageHtml(m) {
      if (m.role === "note") return '<div class="cmsg note">' + escapeHtml(m.content) + "</div>";
      var who = m.role === "user" ? (m.by === "remote" ? "You (phone or web)" : m.by === "terminal" ? "You (terminal)" : "You") : "EdgeCoder";
      return '<article class="cmsg ' + (m.role === "user" ? "user" : "assistant") + '"><div class="cmsg-head"><span class="who">' + escapeHtml(who) + "</span>" + (m.plan ? '<span class="chip tone-accent">Plan</span>' : "") + "<time>" + escapeHtml(timeText(m.at)) + "</time></div>" +
        stepsHtml(m.steps, "steps-" + m.id, false) + (m.content ? '<div class="msg-body">' + renderMarkdown(m.content) + "</div>" : "") + (m.role === "assistant" ? changesHtml(m) : "") + "</article>";
    }
    function approvalHtml(p) {
      if (p.tool === "cost_check") return costCheckHtml(p);
      var q = p.tool === "run_shell" ? "Run this command?" : "Allow " + p.tool + "?";
      var choices;
      if (!canDrive()) choices = '<span class="on-mac">Answer on your Mac' + (cs.machine && cs.machine.online ? "" : " (it's offline)") + "</span>";
      else choices = (p.approvable ? '<button type="button" class="primary sm" data-approve="' + escapeHtml(p.callId) + '">Allow</button>' : "") + '<button type="button" class="sm danger" data-deny="' + escapeHtml(p.callId) + '">Deny</button>' +
        '<span class="on-mac">' + escapeHtml(p.approvable ? "Allows this call only. Always-allow rules are set on the Mac." : p.message || "Approve it on the Mac.") + "</span>";
      return '<div class="ask-card" role="group" aria-label="' + escapeHtml(q) + '"><div class="ask-q">' + escapeHtml(q) + '</div><div class="ask-tool"><span class="s-tool">' + escapeHtml(p.tool) + "</span> " + escapeHtml(p.detail) + "</div>" +
        (p.command ? "<code>" + escapeHtml(p.command) + "</code>" : "") + '<div class="ask-choices">' + choices + "</div></div>";
    }
    // A chat's per-reply cost check: Keep going (approve) or Stop (deny); Switch is on the Mac.
    function costCheckHtml(p) {
      var choices = !canDrive() ? '<span class="on-mac">Answer on your Mac</span>'
        : '<button type="button" class="primary sm" data-approve="' + escapeHtml(p.callId) + '">Keep going</button><button type="button" class="sm danger" data-deny="' + escapeHtml(p.callId) + '">Stop</button><span class="on-mac">Switching to a cheaper model is on the Mac.</span>';
      return '<div class="ask-card" role="group" aria-label="Keep going?"><div class="ask-q">Keep going?</div><div class="ask-tool">' + escapeHtml(p.detail) + '</div><div class="ask-choices">' + choices + "</div></div>";
    }
    function planHtml() {
      return '<div class="ask-card plan" role="group" aria-label="Approve this plan"><div class="ask-q">Approve this plan?</div><div class="muted u-fs-12">It starts making changes in the mode you pick.</div><div class="ask-choices">' +
        '<button type="button" class="sm" data-plan="ask">Approve, ask first</button><button type="button" class="primary sm" data-plan="auto-edits">Approve, accept edits</button></div></div>';
    }

    function renderHead() {
      var s = cs.snap ? cs.snap.session : null;
      var title = (s && s.title) || (cs.summary && cs.summary.title) || "Session";
      document.getElementById("csTitle").textContent = title;
      document.title = "EdgeCoder | " + title;
      var chip = codeStatusChip(sessionStatus());
      var c = document.getElementById("csChip");
      c.textContent = chip.text;
      c.className = "chip tone-" + chip.tone;
      var project = s ? s.projectName : cs.machine && cs.summary ? ((cs.machine.projects.find(function(p) { return p.projectId === cs.summary.projectId; }) || {}).name || "") : "";
      var bits = [cs.machine ? cs.machine.name + (cs.machine.online ? "" : " (offline)") : "", project + (s && s.branch ? " · " + s.branch : ""), s ? s.model : "", s && s.cSats ? Number(s.cSats).toLocaleString() + " cSats so far" : ""].filter(Boolean);
      document.getElementById("csMeta").textContent = bits.join(" · ");
      var drive = canDrive() && !!cs.snap;
      var mode = document.getElementById("csMode");
      mode.hidden = !drive;
      if (drive) {
        var cur = s.mode;
        mode.innerHTML = CODE_MODES.map(function(o) { return '<option value="' + escapeHtml(o[0]) + '"' + (o[0] === cur ? " selected" : "") + ' title="' + escapeHtml(o[2]) + '">' + escapeHtml(o[1]) + "</option>"; }).join("") + (cur === "auto" ? '<option value="auto" selected disabled>Auto (set on the Mac)</option>' : "") + (cur === "full" ? '<option value="full" selected disabled>Full access (set on the Mac)</option>' : "");
        mode.disabled = cs.busy;
      }
      var active = isActive();
      document.getElementById("csStop").hidden = !(drive && active);
      document.getElementById("csUndo").hidden = !(drive && !active && lastTurnId());
    }
    function renderNote() {
      var note = codeMachineNote(cs.machine, true) || cs.error;
      if (cs.machine && !cs.summary && !cs.snap && !note) note = "This session isn't shared from " + cs.machine.name + " any more. Sessions show here when they were started from your phone or the web, or shared in the EdgeCoder app.";
      var el = document.getElementById("csNote");
      el.textContent = note || "";
      el.hidden = !note;
    }
    function renderComposer() {
      var input = document.getElementById("csInput"), send = document.getElementById("csSend");
      var drive = canDrive() && !!cs.snap;
      input.disabled = !drive;
      send.disabled = !drive || cs.busy;
      input.placeholder = !drive ? "Answer on your Mac" : isActive() ? "Queue a message…" : "Message your Mac…";
      document.getElementById("csWorking").textContent = cs.busy ? "Sending…" : sessionStatus() === "running" ? "Working on your Mac…" : sessionStatus() === "waiting" ? "Waiting for your approval" : "";
    }
    function renderThread() {
      var box = document.getElementById("csMessages"), live = document.getElementById("csLive"), scroll = document.getElementById("csScroll");
      var atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
      var before = scroll.scrollHeight;
      if (!cs.snap) {
        box.innerHTML = cs.summary || cs.machine ? '<div class="code-wait muted">' + escapeHtml(canDrive() && !cs.error ? "Asking your Mac…" : "The conversation shows here while the Mac is online with Code from your phone On.") + "</div>" : "";
        live.innerHTML = "";
        document.getElementById("csOlder").hidden = true;
        return;
      }
      var list = allMessages();
      box.innerHTML = list.length ? list.map(messageHtml).join("") : '<div class="code-wait muted">No messages yet. Send the first one below.</div>';
      var snap = cs.snap, html = "";
      if (snap.running) {
        html += '<article class="cmsg assistant running"><div class="cmsg-head"><span class="who">EdgeCoder</span><span class="working"><span class="loading-spinner sm"></span>' + escapeHtml(snap.pending.length ? "Waiting for your approval" : "Working…") + "</span></div>" +
          stepsHtml(snap.running.steps, "steps-run-" + snap.running.turnId, true) + (snap.running.text ? '<div class="msg-body">' + renderMarkdown(snap.running.text) + "</div>" : "") + "</article>";
      }
      snap.queue.forEach(function(q) {
        html += '<div class="queued"><div class="q-text"><span class="q-label">Queued</span>' + escapeHtml(q.text) + "</div>" + (canDrive() ? '<button type="button" class="sm ghost" data-unqueue="' + escapeHtml(q.id) + '" aria-label="Remove queued message">' + CODE_ICONS.x + "</button>" : "") + "</div>";
      });
      snap.pending.forEach(function(p) { html += approvalHtml(p); });
      if (awaitingPlan() && canDrive()) html += planHtml();
      live.innerHTML = html;
      var total = snap.session.messages || 0;
      document.getElementById("csOlder").hidden = cs.more === null ? !(total > list.length) : !cs.more;
      if (cs.first || atBottom) scroll.scrollTop = scroll.scrollHeight;
      else if (cs.keepOffset) scroll.scrollTop = scroll.scrollHeight - before + scroll.scrollTop;
      cs.keepOffset = false;
      cs.first = false;
    }
    function render() { renderHead(); renderNote(); renderThread(); renderComposer(); }

    /* What changed decides what's redrawn (polls that bring nothing new leave the page alone, selection included). */
    function paint() {
      var sig = JSON.stringify([cs.snap, cs.older.length, cs.more, cs.busy, cs.error, cs.machine && [cs.machine.online, cs.machine.controls, cs.machine.name], cs.summary]);
      if (sig === cs.sig) return;
      cs.sig = sig;
      render();
    }

    async function refreshMachine() {
      var machines = await codeMachines();
      cs.machine = machines.find(function(m) { return m.agentId === cs.agentId; }) || null;
      cs.summary = cs.machine ? cs.machine.sessions.find(function(s) { return s.sessionId === cs.sessionId; }) || null : null;
      var mSig = cs.summary ? [cs.summary.updatedAtMs, cs.summary.status, cs.summary.pendingApprovals].join("|") : "";
      var changed = mSig !== cs.mSig;
      cs.mSig = mSig;
      return changed;
    }
    async function refreshSnapshot() {
      try {
        cs.snap = await codeCommand(cs.agentId, "snapshot", { sessionId: cs.sessionId });
        cs.error = "";
      } catch (err) {
        cs.error = codeErrorText(err);
        if (err.code === "no_such_session") cs.snap = null;
      }
    }
    async function tick() {
      clearTimeout(cs.timer);
      if (!document.hidden) {
        try {
          var changed = await refreshMachine();
          if (canDrive() && (cs.kick > 0 || isActive() || changed || !cs.snap)) await refreshSnapshot();
          else if (!canDrive()) cs.error = "";
        } catch (err) {
          if (err.code === "not_authenticated") { location.href = "/portal"; return; }
          cs.error = codeErrorText(err);
        }
        if (cs.kick > 0) cs.kick--;
        paint();
      }
      cs.timer = setTimeout(tick, document.hidden ? 15000 : isActive() || cs.kick > 0 ? 2500 : 6000);
    }

    /* One write: then a fresh snapshot, and a few fast polls so the turn shows up. */
    async function act(done, action, args) {
      if (cs.busy) return false;
      cs.busy = true;
      paint();
      var ok = false;
      try {
        await codeCommand(cs.agentId, action, Object.assign({ sessionId: cs.sessionId }, args || {}));
        if (done) showToast(done);
        ok = true;
        cs.kick = 4;
        await refreshSnapshot();
      } catch (err) {
        showToast(codeErrorText(err), true);
      } finally {
        cs.busy = false;
        paint();
      }
      clearTimeout(cs.timer);
      cs.timer = setTimeout(tick, 1500);
      return ok;
    }
    async function sendMessage() {
      var input = document.getElementById("csInput");
      var text = input.value.trim();
      if (!text || cs.busy || !canDrive()) return;
      if (await act(isActive() ? "Queued" : "", "message", { text: text.slice(0, 32000) })) {
        input.value = "";
        grow();
        cs.first = true;
        paint();
      }
    }
    async function loadOlder() {
      var list = allMessages();
      if (!list.length || cs.busy) return;
      var btn = document.getElementById("csOlder");
      btn.disabled = true;
      try {
        var page = await codeCommand(cs.agentId, "messages", { sessionId: cs.sessionId, beforeId: list[0].id });
        cs.older = (page.items || []).concat(cs.older);
        cs.more = !!page.more;
        cs.keepOffset = true;
        paint();
      } catch (err) {
        showToast(codeErrorText(err), true);
      } finally {
        btn.disabled = false;
      }
    }
    async function loadChanges(turnId, details) {
      if (cs.changes[turnId]) return;
      var body = details.querySelector(".chg-body");
      body.innerHTML = '<div class="muted u-fs-12"><span class="loading-spinner sm"></span> Asking your Mac…</div>';
      try {
        cs.changes[turnId] = codeChangesHtml(await codeCommand(cs.agentId, "changes", { sessionId: cs.sessionId, turnId: turnId }));
      } catch (err) {
        body.innerHTML = '<div class="callout danger u-fs-12">' + escapeHtml(codeErrorText(err)) + "</div>";
        return;
      }
      body.innerHTML = cs.changes[turnId];
    }
    function grow() {
      var el = document.getElementById("csInput");
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
    }

    function initSession(agentId, sessionId) {
      cs.agentId = agentId;
      cs.sessionId = sessionId;
      document.getElementById("codeSession").hidden = false;
      var thread = document.getElementById("csScroll");
      // <details> toggles don't bubble: listen in the capture phase and remember each one's state across redraws.
      thread.addEventListener("toggle", function(e) {
        var d = e.target;
        if (!d || !d.getAttribute || !d.getAttribute("data-key")) return;
        cs.open[d.getAttribute("data-key")] = d.open;
        if (d.open && d.getAttribute("data-turn")) loadChanges(d.getAttribute("data-turn"), d);
      }, true);
      thread.addEventListener("click", function(e) {
        var t = e.target.closest && e.target.closest("[data-approve],[data-deny],[data-plan],[data-unqueue]");
        if (!t || cs.busy) return;
        if (t.hasAttribute("data-approve")) act("Allowed", "approve", { callId: t.getAttribute("data-approve"), approved: true });
        else if (t.hasAttribute("data-deny")) act("Denied", "approve", { callId: t.getAttribute("data-deny"), approved: false });
        else if (t.hasAttribute("data-plan")) act("Plan approved", "plan", { mode: t.getAttribute("data-plan") === "auto-edits" ? "auto-edits" : "ask" });
        else act("Removed from the queue", "unqueue", { queuedId: t.getAttribute("data-unqueue") });
      });
      document.getElementById("csOlder").addEventListener("click", loadOlder);
      document.getElementById("csSend").addEventListener("click", sendMessage);
      document.getElementById("csStop").addEventListener("click", function() { act("Stopping", "cancel"); });
      document.getElementById("csUndo").addEventListener("click", function() {
        var turn = lastTurnId();
        if (!turn || !confirm("Undo the last turn? Files it changed go back to how they were before it.")) return;
        act("Undone", "undo", { turnId: turn });
      });
      document.getElementById("csRefresh").addEventListener("click", function() { cs.kick = 1; tick(); });
      document.getElementById("csMode").addEventListener("change", function(e) {
        var v = e.target.value;
        if (v === "ask" || v === "auto-edits" || v === "plan") act("Mode: " + codeModeLabel(v), "settings", { mode: v });
      });
      var input = document.getElementById("csInput");
      input.addEventListener("input", grow);
      input.addEventListener("keydown", function(e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
      document.addEventListener("visibilitychange", function() { if (!document.hidden) tick(); });
      render();
      tick();
    }
`;

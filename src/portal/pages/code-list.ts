// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Code page's list (/portal/code): each of your Macs with its trusted projects and shared
 * sessions, newest first, and New session. Plain browser JS included in pages/code.ts; every value
 * from a Mac reaches innerHTML only through escapeHtml.
 */
export const CODE_LIST_JS = String.raw`
    var listState = { machines: [], timer: null, newAgent: null };

    function sessionRowHtml(m, s) {
      var chip = codeStatusChip(s.status);
      var sub = [codeAgo(s.updatedAtMs), s.pendingApprovals ? (s.pendingApprovals === 1 ? "1 approval waiting" : s.pendingApprovals + " approvals waiting") : "", s.startedFrom === "phone" ? "Started from your phone or the web" : ""].filter(Boolean).join(" · ");
      return '<a class="cs-row" href="' + codeHref(m.agentId, s.sessionId) + '"><span class="cs-row-text"><span class="cs-row-title">' + escapeHtml(s.title || "Untitled session") + '</span><span class="cs-row-sub">' + escapeHtml(sub) + '</span></span><span class="chip tone-' + chip.tone + '">' + escapeHtml(chip.text) + "</span></a>";
    }

    function machineCardHtml(m) {
      var note = codeMachineNote(m);
      var canCreate = m.online && m.controls === "on" && m.projects.length > 0;
      var where = m.online ? "Online" : "Offline · last heard from " + codeAgo(m.updatedAtMs);
      var mode = m.controls === "on" ? "Code from your phone: On" : m.controls === "view" ? "Code from your phone: View only" : "Code from your phone: Off";
      var head = '<header class="cm-head"><div class="cm-who"><h3 class="cm-name">' + escapeHtml(m.name) + '</h3><div class="cm-sub"><span class="dot ' + (m.online ? "on" : "off") + '" aria-hidden="true"></span>' + escapeHtml(where + " · " + mode) + "</div></div>" +
        (canCreate ? '<button type="button" class="sm primary" data-new-session="' + escapeHtml(m.agentId) + '">' + CODE_ICONS.plus + "<span>New session</span></button>" : "") + "</header>";
      var body = note ? '<div class="callout ' + (m.online && m.controls !== "off" ? "info" : "warn") + ' cm-note" role="status">' + escapeHtml(note) + "</div>" : "";
      // Projects ordered by their newest session; sessions newest first inside each.
      var byProject = {};
      m.sessions.slice().sort(function(a, b) { return b.updatedAtMs - a.updatedAtMs; }).forEach(function(s) { (byProject[s.projectId] = byProject[s.projectId] || []).push(s); });
      var projects = m.projects.slice();
      Object.keys(byProject).forEach(function(pid) { if (!projects.some(function(p) { return p.projectId === pid; })) projects.push({ projectId: pid, name: (byProject[pid][0] && byProject[pid][0].projectName) || "Project", parent: "" }); });
      projects.sort(function(a, b) {
        var ta = byProject[a.projectId] ? byProject[a.projectId][0].updatedAtMs : 0, tb = byProject[b.projectId] ? byProject[b.projectId][0].updatedAtMs : 0;
        return tb - ta || String(a.name).localeCompare(String(b.name));
      });
      var groups = projects.map(function(p) {
        var list = byProject[p.projectId] || [];
        var sub = [p.parent, p.branch].filter(Boolean).join(" · ");
        return '<section class="cp"><div class="cp-head"><span class="cp-name">' + CODE_ICONS.folder + "<span>" + escapeHtml(p.name) + "</span></span>" + (sub ? '<span class="cp-sub">' + escapeHtml(sub) + "</span>" : "") + "</div>" +
          (list.length ? '<div class="cs-rows">' + list.map(function(s) { return sessionRowHtml(m, s); }).join("") + "</div>" : '<div class="cp-empty">No shared sessions yet.</div>') + "</section>";
      }).join("");
      if (!groups && !note) groups = '<div class="cp-empty">No projects on this Mac yet. Open a project in the Code view of the EdgeCoder app and chat in it, or trust a folder.</div>';
      return '<article class="cm" data-agent="' + escapeHtml(m.agentId) + '">' + head + body + groups + "</article>";
    }

    async function showList() {
      document.getElementById("codeList").hidden = false;
      var box = document.getElementById("codeMachines");
      try {
        var machines = await codeMachines();
        listState.machines = machines;
        if (!machines.length) {
          box.innerHTML = '<div class="code-empty"><div class="empty-icon">' + CODE_ICONS.code + '</div><h3>No Macs yet</h3><p>Install the EdgeCoder desktop app on your Mac and sign in with this account. Then turn on <strong>Code from your phone</strong> in its Settings, and your projects and sessions show up here.</p><p><a href="/portal/settings/install">Install EdgeCoder</a></p></div>';
        } else {
          // Macs you can drive first, then the other online ones, then offline; by name within each.
          var rank = function(m) { return m.online ? (m.controls === "on" ? 0 : 1) : 2; };
          box.innerHTML = machines.slice().sort(function(a, b) { return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)); }).map(machineCardHtml).join("");
        }
      } catch (err) {
        if (err.code === "not_authenticated") { location.href = "/portal"; return; }
        box.innerHTML = '<div class="callout danger" role="alert">Couldn\'t load your Macs. ' + escapeHtml(codeErrorText(err)) + "</div>";
      }
      clearTimeout(listState.timer);
      listState.timer = setTimeout(function() { if (!document.hidden) showList(); else listState.timer = setTimeout(showList, 15000); }, 15000);
    }

    /* New session: a trusted project on that Mac and a mode (Auto is set on the Mac only). */
    function openNew(agentId) {
      var m = listState.machines.find(function(x) { return x.agentId === agentId; });
      if (!m) return;
      listState.newAgent = agentId;
      var f = document.getElementById("cnForm");
      f.reset();
      document.getElementById("cnWhere").textContent = "Runs on " + m.name + ". Everything it changes stays on that Mac.";
      document.getElementById("cnProject").innerHTML = m.projects.map(function(p) { return '<option value="' + escapeHtml(p.projectId) + '">' + escapeHtml(p.name + (p.parent ? " (" + p.parent + ")" : "")) + "</option>"; }).join("");
      document.getElementById("cnMode").innerHTML = CODE_MODES.map(function(o) { return '<option value="' + escapeHtml(o[0]) + '">' + escapeHtml(o[1] + ": " + o[2]) + "</option>"; }).join("");
      document.getElementById("cnError").hidden = true;
      document.getElementById("cnDialog").showModal();
    }
    async function createSession(e) {
      e.preventDefault();
      var f = document.getElementById("cnForm"), btn = document.getElementById("cnSave");
      var args = { projectId: f.projectId.value, mode: f.mode.value };
      var title = f.title.value.trim();
      if (title) args.title = title.slice(0, 120);
      btn.disabled = true;
      btn.textContent = "Starting…";
      try {
        var r = await codeCommand(listState.newAgent, "create", args);
        if (!r || !r.sessionId) throw codeErr("bad_request", "Your Mac didn't say which session it started.");
        location.href = codeHref(listState.newAgent, r.sessionId);
      } catch (err) {
        var el = document.getElementById("cnError");
        el.textContent = codeErrorText(err);
        el.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = "Start session";
      }
    }

    function initList() {
      document.getElementById("codeMachines").addEventListener("click", function(e) {
        var b = e.target.closest && e.target.closest("[data-new-session]");
        if (b) openNew(b.getAttribute("data-new-session"));
      });
      document.getElementById("codeRefresh").addEventListener("click", showList);
      document.getElementById("cnCancel").addEventListener("click", function() { document.getElementById("cnDialog").close(); });
      document.getElementById("cnForm").addEventListener("submit", createSession);
      showList();
    }
`;

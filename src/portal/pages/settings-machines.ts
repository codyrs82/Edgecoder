// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings > Nodes > "Your machines' models": per machine, what its Ollama has and runs, and the
 * owner's commands (src/portal/routes/machines.ts). Everything a machine reports is agent-supplied
 * and goes through escapeHtml before it reaches innerHTML. No style attributes (CSP, #27): the
 * pull progress is a <progress> element.
 */

/**
 * The note under an installed model this machine does not share on the network (newer
 * coordinators say which it serves: `networkModels`, `ownerModels`, `memory`). Empty when it is
 * served, or when the coordinator does not say. Serialised into the page script with toString(),
 * so it stays self-contained.
 */
export function modelShareNote(
  name: string,
  m: { networkModels?: string[]; ownerModels?: string[]; memory?: { budgetBytes: number; models: Array<{ name: string; bytes: number }> } },
): string {
  if (!m || !Array.isArray(m.networkModels) || m.networkModels.indexOf(name) >= 0 || /embed/i.test(name)) return "";
  const gbOf = function (n: number): string {
    return (n / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + " GB";
  };
  const est = m.memory && Array.isArray(m.memory.models) ? m.memory.models.find(function (x) { return x.name === name; }) : undefined;
  const budget = m.memory && m.memory.budgetBytes > 0 ? m.memory.budgetBytes : 0;
  const nums = est && est.bytes > 0 && budget ? " (needs ~" + gbOf(est.bytes) + "; budget " + gbOf(budget) + ")" : "";
  if (Array.isArray(m.ownerModels) && m.ownerModels.indexOf(name) >= 0) {
    if (est && budget && est.bytes <= budget) return "Runs for you only: this machine shares as many models on the network as its memory budget holds together" + nums;
    return "Runs for you only: too big to share on the network from this machine" + nums;
  }
  return "Not shared on the network from this machine" + nums + ". Update its agent to run it for you only.";
}

/**
 * Under the settings: who chooses the active model and exactly how to change it. Remote control on:
 * the portal's Use writes the choice to the machine (its model-overrides file, kept through updates;
 * src/model/remote-control/overrides.ts), and only a later change to the machine's own config of the
 * model replaces it. A model loaded by hand (`ollama run`) is not the one the agent serves; say so.
 * Serialised into the page script with toString(), so it stays self-contained.
 */
export function modelSourceNote(
  st: { activeModel?: string; remoteControl?: string; localUi?: boolean; sources?: { model?: string }; loaded?: Array<{ name: string }> },
  connected: boolean,
): string {
  if (!st) return "";
  const active = st.activeModel || "n/a";
  const src = st.sources && st.sources.model;
  const cmd = "sudo edgecoder-install apply --keep-config --model <model>";
  const canUse = connected && st.remoteControl === "on";
  const parts: string[] = [];
  if (src === "remote") {
    parts.push("Active model " + active + " was chosen here. It is saved on the machine and kept through updates; a later model change on the machine itself (" + (st.localUi ? "its EdgeCoder app" : cmd) + ") replaces it.");
  } else if (st.localUi) {
    parts.push("This machine's EdgeCoder app chooses " + active + ". Change it in the app" + (canUse ? ", or press Use next to an installed model here (a later change in the app replaces it)." : "."));
  } else {
    const who = src === "env" ? "This machine's own config (OLLAMA_MODEL in /etc/edgecoder/agent-<n>.env) chooses " : "This machine's agent picked ";
    parts.push(who + active + "." + (canUse
      ? " To switch from here, press Use next to an installed model (Pull it first if needed): the choice is saved on the machine and kept through updates. Or on the machine run: " + cmd
      : " Remote control is " + (connected ? "off on this machine" : "unavailable while it is offline") + ", so change it on the machine: " + cmd));
  }
  const others = (st.loaded || []).map(function (l) { return l.name; }).filter(function (n) { return n && n !== st.activeModel && n.replace(/:latest$/, "") !== String(st.activeModel || "").replace(/:latest$/, ""); });
  if (others.length) {
    parts.push("Also loaded in Ollama: " + others.join(", ") + " (for example by ollama run on the machine). Network work runs on the active model, " + active + "; " + (canUse ? "press Use on " + others[0] + " to serve it instead." : "to serve " + others[0] + ", run on the machine: sudo edgecoder-install apply --keep-config --model " + others[0]));
  }
  return parts.join(" ");
}

export function machinesSectionHtml(): string {
  return `
      <div class="set-group" id="machinesGroup">Your machines' models</div>
      <div class="set-card">
        <div class="set-row wide">
          <div class="set-text">
            <div class="set-desc">Choose and manage the model each of your machines serves, including headless Linux hosts.
            Commands go only to machines enrolled to your account, signed by the coordinator the machine trusts.
            A change made here is saved on the machine and kept through updates; a later change to the same setting on the machine itself (re-running the installer with it, or the desktop app) replaces it.
            Hosts can turn this off (<code>AGENT_REMOTE_CONTROL=off</code>) or limit the models (<code>AGENT_MODEL_ALLOWLIST</code>).</div>
          </div>
          <div class="set-control"><button id="machinesReloadBtn">Reload</button></div>
        </div>
        <div class="set-row wide"><div id="machinesList" class="u-w-full"><div class="muted">Loading machines…</div></div></div>
      </div>`;
}

export function machinesPageScript(): string {
  return `
    /* ── Machines: remote model control ── */
    let machinesData = { machines: [], catalog: [] };
    ${modelShareNote.toString()}
    ${modelSourceNote.toString()}
    let machinesTimer = null;
    function fmtBytes(n) {
      if (n === null || n === undefined || !isFinite(Number(n))) return "n/a";
      const v = Number(n);
      if (v >= 1e12) return (v / 1e12).toFixed(1) + " TB";
      if (v >= 1e9) return (v / 1e9).toFixed(1) + " GB";
      if (v >= 1e6) return (v / 1e6).toFixed(0) + " MB";
      return v + " B";
    }
    function attr(v) { return encodeURIComponent(String(v === undefined || v === null ? "" : v)).replace(/'/g, "%27"); }
    function srcLabel(s) { return s === "remote" ? "set here" : s === "env" ? "this machine's config" : "auto"; }
    function pendingCommand(m) { return (m.audit || []).some((e) => ["sent", "accepted", "progress"].indexOf(e.status) >= 0); }
    function statusTone(s) { return s === "done" ? "ok" : s === "refused" || s === "failed" || s === "undelivered" || s === "expired" ? "danger" : "info"; }
    function renderMachine(m) {
      const st = m.state;
      const id = attr(m.agentId);
      const head = "<div class='set-label'>" + escapeHtml(m.agentId) + " " +
        (m.connected ? statusBadge("CONNECTED", "ok") : statusBadge("OFFLINE", "warn")) + " " +
        (st ? (st.remoteControl === "on" ? statusBadge("REMOTE CONTROL ON", "info") : statusBadge("VIEW ONLY", "warn")) : "") +
        (m.version ? " <span class='muted'>v" + escapeHtml(m.version) + "</span>" : "") +
        (m.updateAvailable ? " " + "<span title='The host updates itself within 6 hours (automatic updates), or now with: sudo edgecoder-install update'>" + statusBadge("UPDATE AVAILABLE" + (machinesData && machinesData.latestAgentVersion ? " (" + escapeHtml(machinesData.latestAgentVersion) + ")" : ""), "warn") + "</span>" : "") + "</div>";
      if (!st) {
        return "<div class='set-card u-mt-10'>" + head + "<div class='muted'>No report yet. The machine reports when it connects (agents from this release on).</div></div>";
      }
      const gpu = st.gpu ? escapeHtml((st.gpu.model || st.gpu.vendor || "GPU") + (st.gpu.count > 1 ? " x" + st.gpu.count : "")) + (st.gpu.vramBytes ? ", " + fmtBytes(st.gpu.vramBytes) + " VRAM" : "") : "none";
      const facts = "<div class='muted'>Ollama " + escapeHtml(st.ollamaVersion || (st.ollamaReachable ? "?" : "unreachable")) +
        " · GPU " + gpu + " · RAM " + fmtBytes(st.ramBytes) + " · disk free " + fmtBytes(st.diskFreeBytes) +
        " · reported " + escapeHtml(st.reportedAtMs ? new Date(st.reportedAtMs).toLocaleString() : "n/a") + "</div>";
      const can = m.connected && st.remoteControl === "on";
      const dis = can ? "" : " disabled";
      const loaded = new Set((st.loaded || []).map((l) => l.name));
      const rows = (st.installed || []).map((im) => {
        const active = im.name === st.activeModel;
        return "<tr><td>" + escapeHtml(im.name) + (active ? " " + statusBadge("ACTIVE", "ok") : "") + (loaded.has(im.name) ? " " + statusBadge("LOADED", "info") : "") +
          (function () { const note = modelShareNote(im.name, m); return note ? "<div class='muted'>" + escapeHtml(note) + "</div>" : ""; })() +
          "</td><td>" + fmtBytes(im.sizeBytes) + "</td><td>" +
          (active ? "" : "<button class='mcBtn' data-action='set_model' data-agent='" + id + "' data-model='" + attr(im.name) + "'" + dis + ">Use</button> ") +
          (active ? "" : "<button class='mcBtn' data-action='remove' data-agent='" + id + "' data-model='" + attr(im.name) + "'" + dis + ">Remove</button>") +
          "</td></tr>";
      });
      const table = "<table><thead><tr><th>Installed model</th><th>Size</th><th></th></tr></thead><tbody>" +
        (rows.length ? rows.join("") : "<tr><td colspan='3'>No models installed.</td></tr>") + "</tbody></table>";
      const installedNames = new Set((st.installed || []).map((im) => im.name));
      const options = (st.allowlist || []).filter((a) => !installedNames.has(a.name)).map((a) =>
        "<option value='" + attr(a.name) + "'>" + escapeHtml(a.name) + (a.sizeBytes ? " (" + fmtBytes(a.sizeBytes) + ")" : "") + "</option>").join("");
      const pullPct = st.pull && st.pull.totalBytes ? Math.floor((st.pull.completedBytes || 0) * 100 / st.pull.totalBytes) : null;
      const pullAudit = (m.audit || []).find((e) => e.action === "pull" && (e.status === "accepted" || e.status === "progress" || e.status === "sent"));
      const pct = pullPct !== null ? pullPct : pullAudit && pullAudit.progressPct !== undefined ? pullAudit.progressPct : null;
      const progress = st.pull || pullAudit
        ? "<div class='set-desc'>Pulling " + escapeHtml((st.pull && st.pull.model) || (pullAudit && pullAudit.args) || "") + ": " + escapeHtml((st.pull && st.pull.status) || (pullAudit && pullAudit.message) || (pullAudit ? pullAudit.status : "starting")) +
          (pct !== null ? " <progress max='100' value='" + Number(pct) + "'></progress> " + Number(pct) + "%" : "") + "</div>"
        : "";
      const pull = "<div class='table-controls'><select id='pullSel-" + id + "'" + dis + ">" + (options || "<option value=''>No other allowed models</option>") +
        "</select><button class='mcBtn' data-action='pull' data-agent='" + id + "'" + dis + ">Pull</button></div>" + progress;
      const b = st.bounds || { contextWindow: { min: 2048, max: 131072 }, parallel: { min: 1, max: 8 } };
      const s = st.settings || {};
      const src = st.sources || {};
      const settings = "<div class='table-controls'>" +
        "<label>Context <input type='number' id='ctx-" + id + "' min='" + Number(b.contextWindow.min) + "' max='" + Number(b.contextWindow.max) + "' step='1024' value='" + Number(s.contextWindow) + "'" + dis + " /></label> <span class='muted'>" + srcLabel(src.contextWindow) + "</span> " +
        "<label>Slots <input type='number' id='par-" + id + "' min='" + Number(b.parallel.min) + "' max='" + Number(b.parallel.max) + "' value='" + Number(s.parallel) + "'" + dis + " /></label> <span class='muted'>" + srcLabel(src.parallel) + "</span> " +
        "<label>Keep-alive <input type='text' id='ka-" + id + "' maxlength='8' value='" + escapeHtml(s.keepAlive || "") + "'" + dis + " /></label> <span class='muted'>" + srcLabel(src.keepAlive) + "</span> " +
        "<button class='mcBtn primary' data-action='set_settings' data-agent='" + id + "'" + dis + ">Apply</button> " +
        "<button class='mcBtn' data-action='restart_model' data-agent='" + id + "'" + dis + ">Reload model</button> " +
        "<button class='mcBtn' data-action='refresh' data-agent='" + id + "'" + (m.connected ? "" : " disabled") + ">Refresh</button></div>" +
        "<div class='muted'>" + escapeHtml(modelSourceNote(st, m.connected)) + "</div>" +
        "<div class='muted'>Active model: " + escapeHtml(st.activeModel || "n/a") + " (" + srcLabel(src.model) + "). Context " + Number(b.contextWindow.min) + "-" + Number(b.contextWindow.max) +
        " tokens, slots " + Number(b.parallel.min) + "-" + Number(b.parallel.max) + ", keep-alive -1 (never unload), 0 or up to 24h." +
        (st.ollamaNumParallel ? " Ollama runs " + Number(st.ollamaNumParallel) + " calls at once." : "") + "</div>";
      const notes = (st.notes || []).map((n) => "<div class='muted'>" + escapeHtml(n) + "</div>").join("");
      const audit = (m.audit || []).slice(0, 10).map((e) =>
        "<tr><td>" + escapeHtml(new Date(e.requestedAtMs).toLocaleString()) + "</td><td>" + escapeHtml(e.action) + "</td><td>" + escapeHtml(e.args || "") +
        "</td><td>" + statusBadge(String(e.status || "").toUpperCase(), statusTone(e.status)) + "</td><td>" + escapeHtml([e.error, e.message].filter(Boolean).join(": ")) + "</td></tr>").join("");
      const auditTable = "<div class='set-desc u-mt-10'>Activity</div><table><thead><tr><th>When</th><th>Action</th><th>Details</th><th>Result</th><th></th></tr></thead><tbody>" +
        (audit || "<tr><td colspan='5'>No commands yet.</td></tr>") + "</tbody></table>";
      return "<div class='set-card u-mt-10'>" + head + facts + notes + settings + table + pull + auditTable + "</div>";
    }
    function renderMachines() {
      const list = document.getElementById("machinesList");
      const ms = machinesData.machines || [];
      list.innerHTML = ms.length ? ms.map(renderMachine).join("") : "<div class='muted'>No agent machines enrolled.</div>";
    }
    async function loadMachines() {
      try {
        machinesData = await api("/portal/api/machines", { method: "GET", headers: {} });
        renderMachines();
      } catch (err) {
        document.getElementById("machinesList").innerHTML = "<div class='muted'>Could not load machines: " + escapeHtml(String(err.message || err)) + "</div>";
      }
      clearTimeout(machinesTimer);
      const busy = (machinesData.machines || []).some((m) => pendingCommand(m) || (m.state && m.state.pull));
      machinesTimer = setTimeout(loadMachines, busy ? 3000 : 30000);
    }
    async function sendMachineCommand(agentId, action, args) {
      try {
        await api("/portal/api/machines/" + encodeURIComponent(agentId) + "/commands", { method: "POST", body: JSON.stringify({ action: action, args: args }) });
        showToast(action === "refresh" ? "Asked " + agentId + " for its state" : "Sent " + action + " to " + agentId);
      } catch (err) {
        showToast(action + " failed: " + String(err.message || err), true);
      }
      setTimeout(loadMachines, 1200);
    }
    document.getElementById("machinesList").addEventListener("click", (event) => {
      const t = event.target;
      if (!t || !t.classList || !t.classList.contains("mcBtn")) return;
      const agentId = decodeURIComponent(t.getAttribute("data-agent") || "");
      const action = t.getAttribute("data-action");
      const id = attr(agentId);
      if (action === "set_model" || action === "remove") {
        const model = decodeURIComponent(t.getAttribute("data-model") || "");
        if (action === "remove" && !window.confirm("Remove " + model + " from " + agentId + "?")) return;
        return sendMachineCommand(agentId, action, { model: model });
      }
      if (action === "pull") {
        const sel = document.getElementById("pullSel-" + id);
        const model = sel ? decodeURIComponent(sel.value || "") : "";
        if (!model) return showToast("Pick a model to pull", true);
        return sendMachineCommand(agentId, "pull", { model: model });
      }
      if (action === "set_settings") {
        const args = {};
        const ctx = Number(document.getElementById("ctx-" + id).value);
        const par = Number(document.getElementById("par-" + id).value);
        const ka = String(document.getElementById("ka-" + id).value || "").trim();
        const cur = ((machinesData.machines || []).find((m) => m.agentId === agentId) || {}).state || {};
        const s = cur.settings || {};
        if (ctx && ctx !== s.contextWindow) args.contextWindow = ctx;
        if (par && par !== s.parallel) args.parallel = par;
        if (ka && ka !== s.keepAlive) args.keepAlive = ka;
        if (Object.keys(args).length === 0) return showToast("Nothing changed");
        return sendMachineCommand(agentId, "set_settings", args);
      }
      if (action === "restart_model" || action === "refresh") return sendMachineCommand(agentId, action, {});
    });
    document.getElementById("machinesReloadBtn").addEventListener("click", loadMachines);
  `;
}

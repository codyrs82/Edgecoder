// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The web chat's Web toggle and the numbered sources under a web answer (docs/web-tool.md), for
 * pages/chat.ts. The script expects the page's api(), selectedCompute, selectedModel, activeConvId
 * and WEB_KEY / webOn / webState variables, and the #webToggle and #webNote elements.
 */

export const WEB_TOGGLE_CSS = `      /* ── Web toggle (docs/web-tool.md) and the sources under an answer ── */
      .chat-input-left { display:flex; align-items:center; gap:6px; min-width:0; }
      .web-toggle {
        display:inline-flex; align-items:center; gap:5px; min-height:28px; padding:4px 10px;
        border:1px solid var(--card-border); background:transparent; color:var(--text-secondary);
        border-radius:999px; font-size:12.5px; font-weight:500; cursor:pointer; white-space:nowrap;
      }
      .web-toggle:hover:not(:disabled) { background:var(--bg-elevated); color:var(--text); }
      .web-toggle[aria-pressed="true"] { background:var(--brand-soft); border-color:var(--brand); color:var(--brand); }
      .web-toggle:disabled { opacity:0.55; cursor:not-allowed; }
      .web-toggle .web-note { font-size:11px; color:var(--muted); }
      .msg-sources { margin-top:10px; font-size:12.5px; line-height:1.5; }
      .msg-sources .msg-sources-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); }
      .msg-sources ol { margin:4px 0 0; padding-left:22px; }
      .msg-sources a { color:var(--brand); word-break:break-word; }
      .msg-sources .src-host { color:var(--muted); margin-left:6px; }
      .chat-msg .msg-body a { color:var(--brand); }
`;

export const WEB_TOGGLE_SCRIPT = `    // ── Web toggle: per chat, offered when web search is set up and the chat's model can use tools ──
    function webStatusQuery() {
      if (selectedCompute) return "target=" + encodeURIComponent(selectedCompute.target) + "&model=" + encodeURIComponent(selectedCompute.model || "");
      if (selectedModel) return "target=default&model=" + encodeURIComponent(selectedModel);
      return "target=auto";
    }
    async function refreshWebStatus() {
      try { webState = await api("/portal/api/web/status?" + webStatusQuery()); } catch (e) { webState = null; }
      renderWebToggle();
    }
    function renderWebToggle() {
      var btn = document.getElementById("webToggle");
      var note = document.getElementById("webNote");
      // Not set up on the servers (or unknown): no toggle at all.
      if (!webState || webState.reason === "not_configured" || webState.configured === false) { btn.classList.add("hidden"); return; }
      btn.classList.remove("hidden");
      var reason = webState.reason || null;
      btn.disabled = !!reason;
      btn.setAttribute("aria-pressed", webOn && !reason ? "true" : "false");
      note.textContent = reason === "needs_csats" ? "needs cSats" : "";
      if (reason === "no_tools") btn.title = "Web needs a model that can use tools. Pick another model.";
      else if (reason === "needs_csats") btn.title = "Web search costs cSats (" + webState.searchCSats + " a search, " + webState.readCSats + " a page). Top up to use it.";
      else if (reason) btn.title = webState.message || "Web search isn't available right now.";
      else btn.title = webOn ? "Web is on: the model may search the web and read pages (" + webState.searchCSats + " cSats a search, " + webState.readCSats + " a page)." : "Let the model search the web and read pages (cites sources; " + webState.searchCSats + " cSats a search, " + webState.readCSats + " a page).";
    }
    function restoreWeb(convId) {
      try { webOn = localStorage.getItem(WEB_KEY + convId) === "1"; } catch (e) { webOn = false; }
      renderWebToggle();
    }
    function saveWeb() {
      try { if (activeConvId) { if (webOn) localStorage.setItem(WEB_KEY + activeConvId, "1"); else localStorage.removeItem(WEB_KEY + activeConvId); } } catch (e) {}
    }
    document.getElementById("webToggle").addEventListener("click", function() {
      if (this.disabled) return;
      webOn = !webOn;
      saveWeb();
      renderWebToggle();
    });
    /** Numbered sources (links) and "2 searches · 1 page · 1.2 cSats" under a web answer. */
    function renderWebSources(bubble, w) {
      var sources = (w && w.sources) || [];
      if (sources.length) {
        var box = document.createElement("div");
        box.className = "msg-sources";
        var title = document.createElement("div");
        title.className = "msg-sources-title";
        title.textContent = "Sources";
        box.appendChild(title);
        var ol = document.createElement("ol");
        for (var i = 0; i < sources.length; i++) {
          var src = sources[i];
          if (!/^https?:\\/\\//i.test(String(src.url || ""))) continue;
          var li = document.createElement("li");
          li.value = Number(src.n) || (i + 1);
          var a = document.createElement("a");
          a.href = src.url; a.target = "_blank"; a.rel = "noopener noreferrer";
          a.textContent = src.title || src.url;
          li.appendChild(a);
          var host = document.createElement("span");
          host.className = "src-host";
          try { host.textContent = new URL(src.url).hostname.replace(/^www\\./, ""); } catch (e) {}
          li.appendChild(host);
          ol.appendChild(li);
        }
        box.appendChild(ol);
        bubble.appendChild(box);
      }
      if (w && w.footer) {
        var line = document.createElement("div");
        line.className = "msg-meta";
        line.textContent = w.footer;
        bubble.appendChild(line);
      }
    }

`;

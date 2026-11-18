// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The web chat's Web indicator and the numbered sources under a web answer (docs/web-tool.md), for
 * pages/chat.ts. Web is automatic: when web search is set up, the chat's model can call tools and
 * the account has cSats, the model may search on its own ("Web: Auto"); the quiet indicator's menu
 * turns it off for one chat, and Settings → General sets the default (WEB_AUTO_KEY, this browser).
 * The script expects the page's api(), selectedCompute, selectedModel, activeConvId and WEB_KEY /
 * webMode / webState variables, and the #webToggle, #webLabel, #webMenu elements.
 */

/** Settings → General "Search the web automatically" (this browser): "off" turns it off by default. */
export const WEB_AUTO_KEY = "edgecoder.web.auto";
export const WEB_UNAVAILABLE_TITLE = "Web: unavailable with this model";
export const WEB_NEEDS_CSATS = "Web search needs cSats";

export const WEB_TOGGLE_CSS = `      /* ── Web toggle (docs/web-tool.md) and the sources under an answer ── */
      .chat-input-left { display:flex; align-items:center; gap:6px; min-width:0; }
      .web-toggle {
        display:inline-flex; align-items:center; gap:5px; min-height:28px; padding:4px 10px;
        border:1px solid var(--card-border); background:transparent; color:var(--text-secondary);
        border-radius:999px; font-size:12.5px; font-weight:500; cursor:pointer; white-space:nowrap;
      }
      .web-toggle:hover:not(:disabled) { background:var(--bg-elevated); color:var(--text); }
      .web-wrap { position:relative; display:inline-flex; }
      .web-toggle { border-color:transparent; color:var(--muted); padding:4px 8px; }
      .web-toggle.off { opacity:0.7; }
      .web-toggle.unavailable { opacity:0.5; cursor:default; }
      .web-toggle .web-note { font-size:11px; color:var(--muted); }
      .web-menu {
        position:absolute; bottom:calc(100% + 8px); left:-4px; width:min(270px, 80vw);
        background:var(--bg-surface); border:1px solid var(--border-strong);
        border-radius:var(--radius-md); box-shadow:var(--shadow-up); z-index:100; padding:6px;
      }
      .web-menu button {
        display:flex; flex-direction:column; align-items:flex-start; gap:1px; width:100%; min-height:0;
        padding:7px 10px; border:none; background:none; color:var(--text); cursor:pointer;
        border-radius:var(--radius-sm); text-align:left; font-size:13px; font-weight:400; white-space:normal;
      }
      .web-menu button:hover { background:var(--bg-elevated); }
      .web-menu button[aria-checked="true"] .wm-title::after { content:" ✓"; color:var(--brand); }
      .web-menu .wm-desc { font-size:11.5px; color:var(--muted); }
      .msg-sources { margin-top:10px; font-size:12.5px; line-height:1.5; }
      .msg-sources .msg-sources-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); }
      .msg-sources ol { margin:4px 0 0; padding-left:22px; }
      .msg-sources a { color:var(--brand); word-break:break-word; }
      .msg-sources .src-host { color:var(--muted); margin-left:6px; }
      .chat-msg .msg-body a { color:var(--brand); }
`;

export const WEB_TOGGLE_SCRIPT = `    // ── Web: automatic by default (the model decides when to search), off per chat from the indicator ──
    var WEB_AUTO_KEY = "${WEB_AUTO_KEY}";
    function webDefaultMode() {
      try { return localStorage.getItem(WEB_AUTO_KEY) === "off" ? "off" : "auto"; } catch (e) { return "auto"; }
    }
    function webStatusQuery() {
      if (selectedCompute) return "target=" + encodeURIComponent(selectedCompute.target) + "&model=" + encodeURIComponent(selectedCompute.model || "");
      if (selectedModel) return "target=default&model=" + encodeURIComponent(selectedModel);
      return "target=auto";
    }
    async function refreshWebStatus() {
      try { webState = await api("/portal/api/web/status?" + webStatusQuery()); } catch (e) { webState = null; }
      renderWebToggle();
    }
    /** Offer the web tools with this message: Auto, and the status says it can (set up, tools, cSats). */
    function webWanted() { return webMode === "auto" && !!webState && webState.available === true; }
    function renderWebToggle() {
      var btn = document.getElementById("webToggle");
      var label = document.getElementById("webLabel");
      var note = document.getElementById("webNote");
      // Not set up on the servers (or unknown): nothing to show.
      if (!webState || webState.reason === "not_configured" || webState.configured === false) { btn.classList.add("hidden"); closeWebMenu(); return; }
      btn.classList.remove("hidden");
      var reason = webState.reason || null;
      var unavailable = reason === "no_tools";
      btn.classList.toggle("unavailable", unavailable);
      btn.classList.toggle("off", !unavailable && webMode === "off");
      btn.setAttribute("aria-disabled", unavailable ? "true" : "false");
      label.textContent = unavailable ? "Web" : webMode === "off" ? "Web: Off" : "Web: Auto";
      // "needs cSats" only for chats on the network: on your own machine the web is free (a daily allowance).
      var free = webState.free === true;
      note.textContent = reason === "needs_csats" && !free && webMode === "auto" ? "needs cSats" : "";
      var prices = webState.searchCSats !== undefined ? " (" + webState.searchCSats + " cSats a search, " + webState.readCSats + " a page)" : "";
      if (unavailable) btn.title = "${WEB_UNAVAILABLE_TITLE}";
      else if (webMode === "off") btn.title = "Web is off for this chat. Click to change.";
      else if (reason === "needs_csats" && !free) btn.title = "${WEB_NEEDS_CSATS}" + prices + ". This chat answers without the web until you top up.";
      else if (reason) btn.title = webState.message || "Web search isn't available right now.";
      else if (free) btn.title = "Web: Auto. The model searches the web when a question needs fresh information, and cites its sources. Free on your machine" + (webState.localSearch === true ? ", searched from your machine (no daily limit)" : typeof webState.freeSearchesLeftToday === "number" ? " (" + webState.freeSearchesLeftToday + " free searches left today)" : "") + ".";
      else btn.title = "Web: Auto. The model searches the web when a question needs fresh information, and cites its sources" + prices + ".";
      var items = document.querySelectorAll("#webMenu [data-web-mode]");
      for (var i = 0; i < items.length; i++) items[i].setAttribute("aria-checked", items[i].getAttribute("data-web-mode") === webMode ? "true" : "false");
    }
    function restoreWeb(convId) {
      var saved = null;
      try { saved = localStorage.getItem(WEB_KEY + convId); } catch (e) {}
      // "off": turned off for this chat; "auto" (or "1" from the old toggle): on; nothing: the default.
      webMode = saved === "off" ? "off" : saved === "auto" || saved === "1" ? "auto" : webDefaultMode();
      renderWebToggle();
    }
    function saveWeb() {
      try { if (activeConvId) { if (webMode === webDefaultMode()) localStorage.removeItem(WEB_KEY + activeConvId); else localStorage.setItem(WEB_KEY + activeConvId, webMode); } } catch (e) {}
    }
    function closeWebMenu() {
      var menu = document.getElementById("webMenu");
      if (menu) menu.classList.add("hidden");
      document.getElementById("webToggle").setAttribute("aria-expanded", "false");
    }
    document.getElementById("webToggle").addEventListener("click", function(ev) {
      ev.stopPropagation();
      if (this.getAttribute("aria-disabled") === "true") return;
      var menu = document.getElementById("webMenu");
      var open = menu.classList.contains("hidden");
      menu.classList.toggle("hidden", !open);
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.getElementById("webMenu").addEventListener("click", function(ev) {
      var item = ev.target && ev.target.closest ? ev.target.closest("[data-web-mode]") : null;
      if (!item) return;
      webMode = item.getAttribute("data-web-mode") === "off" ? "off" : "auto";
      saveWeb();
      renderWebToggle();
      closeWebMenu();
    });
    document.addEventListener("click", function(ev) {
      var wrap = document.getElementById("webWrap");
      if (wrap && !wrap.contains(ev.target)) closeWebMenu();
    });
    document.addEventListener("keydown", function(ev) { if (ev.key === "Escape") closeWebMenu(); });
    /** "Web search needs cSats", once per chat, quietly under the reply that answered without the web. */
    function noteWebOffOnce(bubble, message) {
      var key = WEB_KEY + "noted." + (activeConvId || "");
      try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch (e) {}
      var line = document.createElement("div");
      line.className = "msg-meta web-off-note";
      line.textContent = message || "${WEB_NEEDS_CSATS}";
      bubble.appendChild(line);
    }
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

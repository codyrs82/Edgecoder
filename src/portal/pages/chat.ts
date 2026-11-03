// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";
import { icon } from "./design-system.js";

// #16: moved verbatim from src/portal/server.ts (split from home-chat.ts to leave room for #27).
export function registerChatPage(app: FastifyInstance): void {
app.get("/portal/chat", async (_req, reply) => {
  const content = `
    <style>
      .shell { max-width:none !important; margin:0 !important; padding:0 !important; }
      .content-stack { padding:0 !important; margin:0 !important; }
      .chat-layout { display:flex; height:calc(100vh - var(--topbar-h)); }
      .conv-sidebar {
        width:280px; min-width:260px; border-right:1px solid var(--card-border);
        background:var(--bg-soft); display:flex; flex-direction:column; padding:14px;
      }
      .conv-sidebar h3 { margin:0 0 8px 0; font-size:14px; }
      .new-chat-btn {
        display:flex; align-items:center; justify-content:center; gap:6px;
        width:100%; padding:9px 14px; margin-bottom:12px;
        border-radius:var(--radius-sm); font-size:13px; font-weight:600;
        background:var(--brand); border:1px solid var(--brand); color:#111; cursor:pointer;
      }
      .new-chat-btn:hover { background:var(--brand-2); border-color:var(--brand-2); color:#111; }
      .conv-item {
        position:relative; padding:10px 30px 10px 12px; border-radius:var(--radius-sm); cursor:pointer;
        margin:2px 0; font-size:13px; white-space:nowrap; overflow:hidden;
        text-overflow:ellipsis; color:var(--text-secondary);
        transition:all var(--transition-fast); border:1px solid transparent;
      }
      .conv-delete {
        position:absolute; right:8px; top:50%; transform:translateY(-50%);
        opacity:0; background:none; border:none; cursor:pointer;
        color:var(--text-secondary); font-size:14px; padding:2px 4px;
        transition:opacity var(--transition-fast), color var(--transition-fast);
      }
      .conv-item:hover .conv-delete { opacity:0.6; }
      .conv-delete:hover { opacity:1 !important; color:#e74c3c; }
      .conv-item:hover { background:var(--bg-surface); color:var(--text); }
      .conv-item.active { background:var(--brand-soft); color:var(--brand-2); border-color:var(--brand-border); }
      .chat-main { flex:1; display:flex; flex-direction:column; min-width:0; }
      .chat-scroll { flex:1; overflow-y:auto; scroll-behavior:smooth; }
      .chat-thread { max-width:768px; margin:0 auto; padding:16px 24px; }
      .chat-msg { padding:18px 0; line-height:1.7; font-size:15px; }
      .chat-msg + .chat-msg { border-top:1px solid var(--card-border); }
      .chat-msg .msg-header { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
      .chat-msg .msg-role {
        font-size:11px; font-weight:700; text-transform:uppercase;
        letter-spacing:0.5px; color:var(--muted);
      }
      .chat-msg .msg-time { font-size:10px; color:var(--muted); opacity:0.7; }
      .chat-msg.user .msg-role { color:var(--brand); }
      .chat-msg .msg-body { color:var(--text); }
      .chat-msg .msg-body p { margin:0 0 8px; }
      .chat-msg .msg-body p:last-child { margin-bottom:0; }
      /* ── Code blocks in chat ── */
      .chat-msg pre {
        position:relative; background:rgba(0,0,0,0.45); padding:14px 16px;
        border-radius:var(--radius-sm); overflow-x:auto; margin:10px 0;
        border:1px solid rgba(255,255,255,0.06);
      }
      .chat-msg code {
        font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,monospace;
        font-size:13px; line-height:1.5;
      }
      .chat-msg pre code { background:none; padding:0; }
      .chat-msg code:not(pre code) {
        background:rgba(0,0,0,0.3); padding:2px 6px;
        border-radius:4px; font-size:12px;
      }
      .code-copy-btn {
        position:absolute; top:6px; right:6px;
        background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.1);
        color:var(--muted); border-radius:4px; padding:3px 8px;
        font-size:10px; cursor:pointer; transition:all var(--transition-fast);
        font-family:inherit;
      }
      .code-copy-btn:hover { background:rgba(255,255,255,0.15); color:var(--text); }
      /* ── Typing indicator ── */
      .typing-indicator { display:flex; gap:4px; align-items:center; padding:8px 0; }
      .typing-indicator .dot {
        width:7px; height:7px; border-radius:50%; background:var(--muted);
        animation:typingBounce 1.4s ease-in-out infinite;
      }
      .typing-indicator .dot:nth-child(2) { animation-delay:0.2s; }
      .typing-indicator .dot:nth-child(3) { animation-delay:0.4s; }
      @keyframes typingBounce {
        0%,60%,100% { transform:translateY(0); opacity:0.4; }
        30% { transform:translateY(-6px); opacity:1; }
      }
      .chat-input-area { border-top:1px solid var(--card-border); background:var(--bg); }
      .chat-input-wrap { max-width:768px; margin:0 auto; padding:14px 24px 18px; }
      .chat-input-row {
        display:flex; flex-direction:column; gap:4px;
        background:var(--bg-input); border:1px solid var(--card-border);
        border-radius:var(--radius-lg); padding:10px 10px 8px 14px;
        transition:border-color var(--transition-fast), box-shadow var(--transition-fast);
      }
      .chat-input-row:focus-within { border-color:var(--brand); box-shadow:0 0 0 3px var(--brand-soft); }
      .chat-input-row textarea {
        width:100%; resize:none; max-height:200px; border:none; padding:2px 0; min-height:0;
        background:transparent; font-family:inherit; font-size:15px;
        color:var(--text); outline:none; line-height:1.5;
      }
      .chat-input-row textarea:focus { box-shadow:none; }
      .chat-input-tools { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .chat-send-btn {
        padding:7px 16px; border-radius:var(--radius-sm); min-height:30px;
        background:var(--brand); border:1px solid var(--brand); color:#111; font-size:13px; font-weight:600;
        cursor:pointer; white-space:nowrap;
      }
      .chat-send-btn:hover { background:var(--brand-2); border-color:var(--brand-2); color:#111; }
      .chat-send-btn:disabled { opacity:0.5; cursor:not-allowed; filter:none; box-shadow:none; }
      /* ── Compute picker (where the chat runs), like the model picker in Claude or Cursor ── */
      .model-picker-wrap { position:relative; min-width:0; }
      .model-trigger {
        display:inline-flex; align-items:center; gap:6px; max-width:100%; min-height:28px;
        padding:4px 8px; border:1px solid transparent; background:transparent; color:var(--text-secondary);
        border-radius:var(--radius-sm); font-size:12.5px; font-weight:500; cursor:pointer;
      }
      .model-trigger:hover, .model-trigger.open { background:var(--bg-elevated); color:var(--text); border-color:transparent; }
      .model-trigger #modelLabel { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .model-trigger .chev { transition:transform 0.15s; flex:none; }
      .model-trigger.open .chev { transform:rotate(180deg); }
      .model-dropdown {
        position:absolute; bottom:calc(100% + 8px); left:-6px; width:min(380px, 86vw);
        background:var(--bg-surface); border:1px solid var(--border-strong);
        border-radius:var(--radius-md); box-shadow:0 -6px 28px rgba(0,0,0,0.45);
        z-index:100; padding:6px; display:flex; flex-direction:column;
      }
      .model-dropdown input { min-height:30px; padding:6px 10px; font-size:12.5px; margin-bottom:4px; }
      .model-options { max-height:340px; overflow-y:auto; }
      .model-dropdown .section-label {
        padding:8px 10px 4px; font-size:11px; color:var(--muted); font-weight:600;
        text-transform:uppercase; letter-spacing:0.06em;
      }
      .model-option {
        display:flex; align-items:center; gap:8px; width:100%; min-height:0;
        padding:7px 10px; border:none; background:none; justify-content:flex-start;
        color:var(--text); cursor:pointer; border-radius:var(--radius-sm);
        text-align:left; font-size:13px; font-weight:400; white-space:normal;
      }
      .model-option:hover, .model-option.kb { background:var(--bg-elevated); }
      .model-option .opt-text { display:flex; flex-direction:column; gap:1px; min-width:0; flex:1; }
      .model-option .opt-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .model-option .opt-meta { font-size:11.5px; color:var(--muted); }
      .model-option .opt-check { flex:none; width:14px; color:var(--brand); visibility:hidden; }
      .model-option[aria-selected="true"] .opt-check { visibility:visible; }
      .model-empty { padding:12px 10px; font-size:12px; color:var(--muted); text-align:center; }
      .msg-meta { margin-top:8px; font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums; }
      .msg-error { color:var(--danger); }
      .spinner { width:14px; height:14px; border:2px solid var(--muted); border-top-color:var(--brand); border-radius:50%; animation:spin 0.8s linear infinite; display:inline-block; }
      @keyframes spin { to { transform:rotate(360deg); } }
      @media (max-width:680px) {
        .conv-sidebar { display:none; }
        .conv-sidebar.mobile-show { display:flex; position:absolute; z-index:40; left:0; top:var(--topbar-h); bottom:0; width:85vw; box-shadow:var(--shadow-2); }
      }
    </style>
    <div class="chat-layout">
      <!-- Left: Conversation sidebar -->
      <div class="conv-sidebar" id="convSidebar">
        <button class="new-chat-btn" id="newChatBtn">${icon("plus", 14)} New conversation</button>
        <input id="convSearch" type="text" placeholder="Search conversations..." style="margin-bottom:10px; font-size:12px;" />
        <div id="convList" style="flex:1; overflow-y:auto;"></div>
      </div>
      <!-- Right: Chat area -->
      <div class="chat-main">
        <div class="chat-scroll" id="chatScroll">
          <div class="chat-thread" id="chatMessages">
            <div style="padding:60px 0; text-align:center;">
              <div style="display:inline-flex;width:44px;height:44px;border-radius:var(--radius-md);border:1px solid var(--card-border);background:var(--bg-surface);align-items:center;justify-content:center;color:var(--brand-2);margin-bottom:12px;">${icon("chat", 20)}</div>
              <h2 style="margin:0 0 6px; font-size:18px; color:var(--text);">Start a conversation</h2>
              <div class="muted" style="font-size:13px;">Ask EdgeCoder anything about your code, infrastructure, or workflow.</div>
            </div>
          </div>
        </div>
        <div id="streamingIndicator" class="hidden" style="max-width:768px; margin:0 auto; display:flex; align-items:center; gap:8px; padding:6px 24px; color:var(--muted); font-size:12px;">
          <div class="typing-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
          <span id="streamStatus">Thinking...</span>
          <span id="streamTokens" style="margin-left:auto;"></span>
        </div>
        <div class="chat-input-area">
          <div class="chat-input-wrap">
            <div class="chat-input-row">
              <textarea id="chatInput" rows="1" placeholder="Message EdgeCoder..." aria-label="Message"></textarea>
              <div class="chat-input-tools">
                <div class="model-picker-wrap" id="modelPickerWrap">
                  <button type="button" class="model-trigger" id="modelTrigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="modelDropdown" title="Where this chat runs">
                    ${icon("cpu", 14)}<span id="modelLabel">Auto</span>
                    <svg class="chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="model-dropdown hidden" id="modelDropdown">
                    <input id="computeSearch" type="search" placeholder="Search models" aria-label="Search compute" autocomplete="off" />
                    <div class="model-options" id="modelOptions" role="listbox" aria-label="Compute"></div>
                  </div>
                </div>
                <button class="chat-send-btn" id="sendBtn">Send</button>
              </div>
            </div>
            <div class="muted" style="font-size:10px; margin-top:6px; text-align:center;">Enter to send, Shift+Enter for newline</div>
          </div>
        </div>
      </div>
    </div>
  `;
  const script = `
    var activeConvId = null;
    var conversations = [];
    var abortController = null;
    var isStreaming = false;
    var selectedModel = null;      // default path only: a model on the coordinator (no compute)
    var selectedCompute = null;    // { target, model, computeClass?, reservationId?, label } or null for the default path
    var modelPickerOpen = false;
    var portalModels = { local: [], swarm: [] };
    var computeOptions = [];
    var COMPUTE_KEY = "edgecoder.chat.compute.";

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function renderMarkdown(text) {
      var html = escapeHtml(text);
      // Code blocks (triple backtick) with copy button
      html = html.replace(/\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g, function(m, code) {
        var id = "codeblock-" + Math.random().toString(36).substring(2, 8);
        return "<pre id=\\"" + id + "\\"><button class=\\"code-copy-btn\\" onclick=\\"copyCodeBlock('" + id + "')\\">Copy</button><code>" + code.trim() + "</code></pre>";
      });
      // Inline code
      html = html.replace(/\\\`([^\\\`]+?)\\\`/g, "<code>$1</code>");
      // Bold
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
      // Italic
      html = html.replace(/\\*(.+?)\\*/g, "<em>$1</em>");
      // Newlines to br
      html = html.replace(/\\n/g, "<br>");
      return html;
    }

    function copyCodeBlock(id) {
      var el = document.getElementById(id);
      if (!el) return;
      var code = el.querySelector("code");
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(function() {
        var btn = el.querySelector(".code-copy-btn");
        if (btn) { btn.textContent = "Copied!"; setTimeout(function() { btn.textContent = "Copy"; }, 2000); }
      });
    }

    function formatMsgTime(ts) {
      if (!ts) return "";
      var d = new Date(ts);
      var h = d.getHours(); var m = d.getMinutes();
      var ampm = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
    }

    function renderConversations() {
      var list = document.getElementById("convList");
      var search = document.getElementById("convSearch").value.toLowerCase();
      var filtered = conversations.filter(function(c) {
        return !search || (c.title || "").toLowerCase().indexOf(search) !== -1;
      });
      var html = "";
      for (var i = 0; i < filtered.length; i++) {
        var c = filtered[i];
        var cls = "conv-item" + (c.conversationId === activeConvId ? " active" : "");
        html += "<div class=\\"" + cls + "\\" data-id=\\"" + escapeHtml(c.conversationId) + "\\">" + escapeHtml(c.title || "New chat") + "<button class=\\"conv-delete\\" data-delete-id=\\"" + escapeHtml(c.conversationId) + "\\" title=\\"Delete\\">&times;</button></div>";
      }
      if (filtered.length === 0) {
        html = "<div class=\\"muted\\" style=\\"padding:8px; font-size:12px;\\">No conversations yet</div>";
      }
      list.innerHTML = html;
    }

    function renderMessages(messages) {
      var container = document.getElementById("chatMessages");
      var scrollParent = container.parentElement;
      if (!messages || messages.length === 0) {
        container.innerHTML = '<div style="padding:60px 0; text-align:center;"><div style="display:inline-flex;width:44px;height:44px;border-radius:var(--radius-md);border:1px solid var(--card-border);background:var(--bg-surface);align-items:center;justify-content:center;color:var(--brand-2);margin-bottom:12px;">${icon("chat", 20)}</div><h2 style="margin:0 0 6px; font-size:18px; color:var(--text);">Start a conversation</h2><div class="muted" style="font-size:13px;">Ask EdgeCoder anything about your code, infrastructure, or workflow.</div></div>';
        return;
      }
      var html = "";
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        var role = m.role === "user" ? "user" : "assistant";
        var label = m.role === "user" ? "You" : "EdgeCoder";
        var timeStr = m.createdAt || m.timestamp ? formatMsgTime(m.createdAt || m.timestamp) : "";
        var cost = role === "assistant" && Number(m.creditsSpent) > 0 ? "<div class=\\"msg-meta\\">" + formatCSats(m.creditsSpent) + "</div>" : "";
        html += "<div class=\\"chat-msg " + role + "\\"><div class=\\"msg-header\\"><div class=\\"msg-role\\">" + label + "</div>" + (timeStr ? "<div class=\\"msg-time\\">" + timeStr + "</div>" : "") + "</div><div class=\\"msg-body\\">" + renderMarkdown(m.content || "") + "</div>" + cost + "</div>";
      }
      container.innerHTML = html;
      scrollParent.scrollTop = scrollParent.scrollHeight;
    }

    async function loadConversations() {
      try {
        var res = await api("/portal/api/conversations");
        conversations = res.conversations || res || [];
        renderConversations();
      } catch (err) {
        showToast("Could not load conversations: " + String(err.message || err), true);
      }
    }

    async function loadMessages(convId) {
      try {
        var res = await api("/portal/api/conversations/" + convId + "/messages");
        var msgs = res.messages || res || [];
        renderMessages(msgs);
      } catch (err) {
        showToast("Could not load messages: " + String(err.message || err), true);
      }
    }

    async function selectConversation(convId) {
      activeConvId = convId;
      renderConversations();
      var conv = conversations.find(function(c) { return c.conversationId === convId; });
      var titleEl = document.getElementById("chatTitle");
      if (titleEl) titleEl.textContent = (conv && conv.title) || "New chat";
      restoreCompute(convId);
      await loadMessages(convId);
    }

    async function createNewChat() {
      try {
        var res = await api("/portal/api/conversations", { method: "POST", body: JSON.stringify({ title: "New chat" }) });
        await loadConversations();
        var newId = res.conversationId || (res.conversation && res.conversation.conversationId);
        if (newId) {
          await selectConversation(newId);
        }
      } catch (err) {
        showToast("Could not create conversation: " + String(err.message || err), true);
      }
    }

    async function deleteConversation(convId) {
      if (!confirm("Delete this conversation? This cannot be undone.")) return;
      try {
        await api("/portal/api/conversations/" + convId, { method: "DELETE" });
        conversations = conversations.filter(function(c) { return c.conversationId !== convId; });
        if (activeConvId === convId) {
          activeConvId = conversations.length > 0 ? conversations[0].conversationId : null;
          if (activeConvId) await loadMessages(activeConvId);
          else renderMessages([]);
        }
        renderConversations();
      } catch (err) {
        showToast("Could not delete conversation: " + String(err.message || err), true);
      }
    }

    async function sendMessage() {
      var input = document.getElementById("chatInput");
      var text = input.value.trim();
      if (!text || isStreaming) return;
      input.value = "";
      input.style.height = "auto";

      // If no active conversation, create one first
      if (!activeConvId) {
        try {
          var res = await api("/portal/api/conversations", { method: "POST", body: JSON.stringify({ title: "New chat" }) });
          var newId = res.conversationId || (res.conversation && res.conversation.conversationId);
          if (newId) {
            activeConvId = newId;
            saveCompute();
            await loadConversations();
            renderConversations();
          }
        } catch (err) {
          showToast("Could not create conversation: " + String(err.message || err), true);
          return;
        }
      }

      // Append user message immediately
      var chatMessages = document.getElementById("chatMessages");
      var scrollParent = chatMessages.parentElement;
      var emptyMsg = chatMessages.querySelector(".muted");
      if (emptyMsg) emptyMsg.remove();
      var userBubble = document.createElement("div");
      userBubble.className = "chat-msg user";
      var nowTime = formatMsgTime(Date.now());
      userBubble.innerHTML = "<div class=\\"msg-header\\"><div class=\\"msg-role\\">You</div><div class=\\"msg-time\\">" + nowTime + "</div></div><div class=\\"msg-body\\">" + renderMarkdown(text) + "</div>";
      chatMessages.appendChild(userBubble);
      scrollParent.scrollTop = scrollParent.scrollHeight;

      // Start streaming
      isStreaming = true;
      var indicator = document.getElementById("streamingIndicator");
      indicator.classList.remove("hidden");
      document.getElementById("streamStatus").textContent = "Thinking...";
      document.getElementById("streamTokens").textContent = "";
      var startTime = Date.now();
      var tokenCount = 0;

      // Create assistant message block
      var assistantBubble = document.createElement("div");
      assistantBubble.className = "chat-msg assistant";
      assistantBubble.innerHTML = "<div class=\\"msg-header\\"><div class=\\"msg-role\\">EdgeCoder</div><div class=\\"msg-time\\">" + formatMsgTime(Date.now()) + "</div></div><div class=\\"msg-body\\"></div>";
      chatMessages.appendChild(assistantBubble);
      var assistantBody = assistantBubble.querySelector(".msg-body");

      var fullContent = "";
      abortController = new AbortController();

      try {
        var chatBody = { conversationId: activeConvId, message: text };
        var computeUsed = selectedCompute;
        if (computeUsed) chatBody.compute = { target: computeUsed.target, model: computeUsed.model, computeClass: computeUsed.computeClass, reservationId: computeUsed.reservationId };
        else if (selectedModel) chatBody.model = selectedModel;
        var response = await fetch("/portal/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chatBody),
          signal: abortController.signal,
          credentials: "same-origin"
        });

        if (!response.ok) {
          var errBody = await response.text();
          var errMsg = errBody;
          try { var ej = JSON.parse(errBody); errMsg = ej.error || errBody; } catch (e) {}
          if (response.status === 402) errMsg += " Buy cSats on the Wallet page.";
          throw new Error(errMsg || ("Chat request failed: " + response.status));
        }

        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        while (true) {
          var result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });

          var lines = buffer.split("\\n");
          buffer = lines.pop() || "";

          for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line.startsWith("data: ")) continue;
            var payload = line.substring(6);
            if (payload === "[DONE]") continue;
            try {
              var parsed = JSON.parse(payload);
              if (parsed.warning) {
                var warnBanner = document.createElement("div");
                warnBanner.style.cssText = "padding:8px 16px;font-size:12px;color:#fbbf24;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:6px;margin-bottom:8px;";
                warnBanner.textContent = parsed.warning;
                assistantBubble.insertBefore(warnBanner, assistantBody);
              }
              if (parsed.error) {
                var errLine = document.createElement("div");
                errLine.className = "msg-meta msg-error";
                errLine.textContent = parsed.error;
                assistantBubble.appendChild(errLine);
              }
              if (parsed.done) {
                var meta = document.createElement("div");
                meta.className = "msg-meta";
                meta.textContent = [typeof parsed.cSatsSpent === "number" ? formatCSats(parsed.cSatsSpent) : "", parsed.compute || ""].filter(Boolean).join(" \u00B7 ");
                if (meta.textContent) assistantBubble.appendChild(meta);
                if (typeof parsed.cSatsSpent === "number" && parsed.cSatsSpent > 0) loadTopTicker();
              }
              if (parsed.content) {
                fullContent += parsed.content;
                tokenCount++;
                assistantBody.innerHTML = renderMarkdown(fullContent);
                scrollParent.scrollTop = scrollParent.scrollHeight;
                var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                document.getElementById("streamStatus").textContent = "Streaming...";
                document.getElementById("streamTokens").textContent = tokenCount + " chunks, " + elapsed + "s";
              }
            } catch (parseErr) {
              // skip unparseable lines
            }
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          showToast("Chat error: " + String(err.message || err), true);
          if (!fullContent) {
            assistantBody.innerHTML = "<span class=\\"msg-error\\">" + escapeHtml(String(err.message || err)) + "</span>";
          }
        }
      }

      // Done streaming
      isStreaming = false;
      abortController = null;
      indicator.classList.add("hidden");

      // Auto-rename if title is still "New chat"
      var conv = conversations.find(function(c) { return c.conversationId === activeConvId; });
      var currentTitle = (conv && conv.title) || "New chat";
      if (currentTitle === "New chat" && text.length > 0) {
        var newTitle = text.length > 40 ? text.substring(0, 40) + "..." : text;
        try {
          await api("/portal/api/conversations/" + activeConvId, {
            method: "PATCH",
            body: JSON.stringify({ title: newTitle })
          });
          var titleEl = document.getElementById("chatTitle");
          if (titleEl) titleEl.textContent = newTitle;
          await loadConversations();
        } catch (renameErr) {
          // non-critical, ignore
        }
      }
    }

    // ── Compute picker: where the chat runs (network model + class, a reservation, your machines, or the default) ──
    function formatCSats(n) {
      var v = Number(n);
      return v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 0 : v >= 1 ? 2 : 4 }) + " cSats";
    }

    function displayModelName(name) {
      if (!name) return "Auto";
      var parts = name.split(":");
      var tag = (parts[1] || "").split("-")[0];
      return tag ? parts[0] + ":" + tag : parts[0];
    }
    function currentLabel() {
      if (selectedCompute) return selectedCompute.label || selectedCompute.model;
      return selectedModel ? "EdgeCoder · " + displayModelName(selectedModel) : "Auto";
    }
    function updateModelLabel() {
      document.getElementById("modelLabel").textContent = currentLabel();
    }
    function computeKey(c) {
      return c ? [c.target, c.model, c.computeClass || "", c.reservationId || ""].join("|") : (selectedModel ? "default|" + selectedModel : "auto");
    }
    function saveCompute() {
      var v = selectedCompute ? JSON.stringify(selectedCompute) : (selectedModel ? JSON.stringify({ defaultModel: selectedModel }) : "");
      try {
        if (activeConvId) { if (v) localStorage.setItem(COMPUTE_KEY + activeConvId, v); else localStorage.removeItem(COMPUTE_KEY + activeConvId); }
        if (v) localStorage.setItem(COMPUTE_KEY + "last", v); else localStorage.removeItem(COMPUTE_KEY + "last");
      } catch (e) {}
    }
    function restoreCompute(convId) {
      var raw = null;
      try { raw = localStorage.getItem(COMPUTE_KEY + convId) || localStorage.getItem(COMPUTE_KEY + "last"); } catch (e) {}
      selectedCompute = null; selectedModel = null;
      if (raw) {
        try {
          var v = JSON.parse(raw);
          if (v && v.defaultModel) selectedModel = String(v.defaultModel);
          else if (v && v.target && v.model) selectedCompute = v;
        } catch (e) {}
      }
      updateModelLabel();
    }
    function optionHtml(key, name, meta, selected) {
      return '<button type="button" role="option" tabindex="-1" class="model-option" data-key="' + escapeHtml(key) + '" aria-selected="' + (selected ? "true" : "false") + '">' +
        '<svg class="opt-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>' +
        '<span class="opt-text"><span class="opt-name">' + escapeHtml(name) + '</span>' + (meta ? '<span class="opt-meta">' + escapeHtml(meta) + '</span>' : '') + '</span></button>';
    }
    var optionByKey = {};
    function renderModelDropdown() {
      var q = (document.getElementById("computeSearch").value || "").trim().toLowerCase();
      var match = function(t) { return !q || String(t).toLowerCase().indexOf(q) !== -1; };
      var cur = computeKey(selectedCompute);
      var groups = { reserved: [], network: [], mine: [] };
      optionByKey = {};
      for (var i = 0; i < computeOptions.length; i++) {
        var o = computeOptions[i];
        var key = computeKey(o.compute);
        optionByKey[key] = { compute: Object.assign({}, o.compute, { label: o.label }) };
        if (match(o.label + " " + o.detail) && groups[o.group]) groups[o.group].push(optionHtml(key, o.label, o.detail, key === cur));
      }
      var dflt = [];
      if (match("auto default edgecoder")) dflt.push(optionHtml("auto", "Auto", "EdgeCoder's default route", cur === "auto"));
      optionByKey["auto"] = { compute: null, model: null };
      for (var j = 0; j < (portalModels.local || []).length; j++) {
        var m = portalModels.local[j];
        var k = "default|" + m.name;
        optionByKey[k] = { compute: null, model: m.name };
        var meta = [m.parameterSize, m.quantization, "Free"].filter(Boolean).join(" · ");
        if (match("edgecoder " + m.name)) dflt.push(optionHtml(k, "EdgeCoder · " + displayModelName(m.name), meta, cur === k));
      }
      var html = "";
      if (groups.reserved.length) html += '<div class="section-label">Reserved</div>' + groups.reserved.join("");
      if (groups.network.length) html += '<div class="section-label">Network · billed in cSats</div>' + groups.network.join("");
      if (groups.mine.length) html += '<div class="section-label">My machines · free</div>' + groups.mine.join("");
      if (dflt.length) html += '<div class="section-label">Default</div>' + dflt.join("");
      if (!html) html = '<div class="model-empty">' + (q ? "Nothing matches." : "No compute discovered.") + '</div>';
      document.getElementById("modelOptions").innerHTML = html;
    }
    async function refreshModels() {
      var results = await Promise.all([
        api("/portal/api/compute/options").catch(function() { return { options: [] }; }),
        api("/portal/api/models").catch(function() { return { local: [], swarm: [] }; })
      ]);
      computeOptions = results[0].options || [];
      portalModels = results[1] || { local: [], swarm: [] };
      if (modelPickerOpen) renderModelDropdown();
    }
    function optionButtons() { return Array.prototype.slice.call(document.querySelectorAll("#modelOptions .model-option")); }
    function openModelPicker() {
      modelPickerOpen = true;
      document.getElementById("modelDropdown").classList.remove("hidden");
      var trigger = document.getElementById("modelTrigger");
      trigger.classList.add("open"); trigger.setAttribute("aria-expanded", "true");
      var search = document.getElementById("computeSearch");
      search.value = "";
      renderModelDropdown();
      search.focus();
      refreshModels();
    }
    function closeModelPicker(restoreFocus) {
      if (!modelPickerOpen) return;
      modelPickerOpen = false;
      document.getElementById("modelDropdown").classList.add("hidden");
      var trigger = document.getElementById("modelTrigger");
      trigger.classList.remove("open"); trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger.focus();
    }
    function chooseOption(key) {
      var o = optionByKey[key];
      if (!o) return;
      selectedCompute = o.compute || null;
      selectedModel = o.compute ? null : (o.model || null);
      updateModelLabel();
      saveCompute();
      closeModelPicker(false);
      document.getElementById("chatInput").focus();
    }
    document.getElementById("modelTrigger").addEventListener("click", function(e) {
      e.stopPropagation();
      if (modelPickerOpen) closeModelPicker(true); else openModelPicker();
    });
    document.getElementById("computeSearch").addEventListener("input", renderModelDropdown);
    document.getElementById("modelDropdown").addEventListener("keydown", function(e) {
      var list = optionButtons();
      var i = list.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModelPicker(true); }
      else if (e.key === "ArrowDown") { e.preventDefault(); if (list.length) list[Math.min(i + 1, list.length - 1)].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) document.getElementById("computeSearch").focus(); else list[i - 1].focus(); }
      else if (e.key === "Enter" && document.activeElement && document.activeElement.id === "computeSearch") { e.preventDefault(); if (list.length) chooseOption(list[0].dataset.key); }
      else if (e.key === "Tab") { closeModelPicker(false); }
    });
    document.getElementById("modelOptions").addEventListener("click", function(e) {
      var opt = e.target.closest(".model-option");
      if (opt) chooseOption(opt.dataset.key);
    });
    document.addEventListener("click", function(e) {
      if (modelPickerOpen && !document.getElementById("modelPickerWrap").contains(e.target)) closeModelPicker(false);
    });

    // Event listeners
    document.getElementById("newChatBtn").addEventListener("click", createNewChat);
    document.getElementById("sendBtn").addEventListener("click", sendMessage);

    document.getElementById("chatInput").addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    document.getElementById("chatInput").addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 200) + "px";
    });

    document.getElementById("convList").addEventListener("click", function(e) {
      var delBtn = e.target.closest(".conv-delete");
      if (delBtn && delBtn.dataset.deleteId) {
        e.stopPropagation();
        deleteConversation(delBtn.dataset.deleteId);
        return;
      }
      var item = e.target.closest(".conv-item");
      if (item && item.dataset.id) {
        selectConversation(item.dataset.id);
      }
    });

    document.getElementById("convSearch").addEventListener("input", function() {
      renderConversations();
    });

    // Init
    (async function() {
      await requireAuth();
      restoreCompute("last");
      refreshModels();
      await loadConversations();
      if (conversations.length > 0) {
        await selectConversation(conversations[0].conversationId);
      } else {
        renderMessages([]);
      }
    })().catch(function(err) {
      showToast("Could not initialize chat: " + String(err.message || err), true);
    });
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Chat",
    activeTab: "chat",
    heading: "Chat",
    subtitle: "Chat on the EdgeCoder network: pick where it runs below the message box.",
    content,
    script
  }));
});
}

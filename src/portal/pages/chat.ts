// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";

// #16: moved verbatim from src/portal/server.ts (split from home-chat.ts to leave room for #27).
export function registerChatPage(app: FastifyInstance): void {
app.get("/portal/chat", async (_req, reply) => {
  const content = `
    <style>
      .shell { max-width:none !important; margin:0 !important; padding:0 !important; }
      .content-stack { padding:0 !important; margin:0 !important; }
      .chat-layout { display:flex; height:calc(100vh - 52px); }
      .conv-sidebar {
        width:280px; min-width:260px; border-right:1px solid var(--card-border);
        background:var(--bg-soft); display:flex; flex-direction:column; padding:14px;
      }
      .conv-sidebar h3 { margin:0 0 8px 0; font-size:14px; }
      .new-chat-btn {
        display:flex; align-items:center; justify-content:center; gap:6px;
        width:100%; padding:10px 14px; margin-bottom:12px;
        border-radius:var(--radius-md); font-size:13px; font-weight:600;
        background:linear-gradient(140deg, var(--brand), var(--brand-2));
        border:1px solid rgba(193,120,80,0.75); color:white;
        cursor:pointer; transition:all var(--transition-fast);
      }
      .new-chat-btn:hover { filter:brightness(1.1); box-shadow:0 2px 12px rgba(193,120,80,0.3); transform:translateY(-1px); }
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
      .conv-item.active { background:var(--bg-surface); color:var(--brand); border-color:rgba(193,120,80,0.2); }
      .chat-main { flex:1; display:flex; flex-direction:column; min-width:0; }
      .chat-scroll { flex:1; overflow-y:auto; scroll-behavior:smooth; }
      .chat-thread { max-width:768px; margin:0 auto; padding:16px 24px; }
      .chat-msg { padding:18px 0; line-height:1.7; font-size:15px; animation:fadeSlideIn 0.3s ease both; }
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
        display:flex; gap:8px; align-items:flex-end;
        background:var(--bg-input); border:1px solid var(--card-border);
        border-radius:var(--radius-md); padding:6px 6px 6px 14px;
        transition:border-color var(--transition-fast), box-shadow var(--transition-fast);
      }
      .chat-input-row:focus-within {
        border-color:var(--brand); box-shadow:0 0 0 2px rgba(193,120,80,0.15);
      }
      .chat-input-row textarea {
        flex:1; resize:none; max-height:200px; border:none; padding:6px 0;
        background:transparent; font-family:inherit; font-size:15px;
        color:var(--text); outline:none; line-height:1.5;
      }
      .chat-input-row textarea:focus { box-shadow:none; }
      .chat-send-btn {
        padding:8px 18px; border-radius:var(--radius-sm);
        background:linear-gradient(140deg, var(--brand), var(--brand-2));
        border:none; color:white; font-size:13px; font-weight:600;
        cursor:pointer; transition:all var(--transition-fast);
        white-space:nowrap;
      }
      .chat-send-btn:hover { filter:brightness(1.1); box-shadow:0 2px 8px rgba(193,120,80,0.3); }
      .chat-send-btn:disabled { opacity:0.5; cursor:not-allowed; filter:none; box-shadow:none; }
      /* ── Model picker ── */
      .model-picker-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
      .model-picker-wrap { position:relative; }
      .model-trigger {
        display:flex; align-items:center; gap:4px;
        padding:4px 10px; border:1px solid var(--card-border);
        background:var(--bg-input); color:var(--text-secondary);
        border-radius:var(--radius-sm); font-size:12px;
        cursor:pointer; transition:all 0.15s;
      }
      .model-trigger:hover { border-color:var(--brand); color:var(--text); }
      .model-trigger .running-dot { width:6px; height:6px; border-radius:50%; background:var(--brand); display:inline-block; }
      .model-trigger svg { transition:transform 0.15s; }
      .model-trigger.open svg { transform:rotate(180deg); }
      .model-dropdown {
        position:absolute; bottom:calc(100% + 4px); left:0;
        min-width:260px; max-height:320px; overflow-y:auto;
        background:var(--bg-surface); border:1px solid var(--card-border);
        border-radius:var(--radius-md); box-shadow:0 -4px 20px rgba(0,0,0,0.4);
        z-index:100; padding:4px;
      }
      .model-dropdown .section-label {
        padding:8px 10px 4px; font-size:11px; color:var(--muted);
        text-transform:uppercase; letter-spacing:0.5px;
      }
      .model-option {
        display:flex; flex-direction:column; gap:1px; width:100%;
        padding:8px 10px; border:none; background:none;
        color:var(--text); cursor:pointer; border-radius:var(--radius-sm);
        text-align:left; font-size:13px; transition:background 0.1s;
      }
      .model-option:hover { background:rgba(255,255,255,0.05); }
      .model-option.active { border-left:2px solid var(--brand); padding-left:8px; }
      .model-option .opt-name { display:flex; align-items:center; gap:6px; }
      .model-option .opt-meta { font-size:11px; color:var(--muted); }
      .spinner { width:14px; height:14px; border:2px solid var(--muted); border-top-color:var(--brand); border-radius:50%; animation:spin 0.8s linear infinite; display:inline-block; }
      @keyframes spin { to { transform:rotate(360deg); } }
      @media (max-width:680px) {
        .conv-sidebar { display:none; }
        .conv-sidebar.mobile-show { display:flex; position:absolute; z-index:40; left:0; top:52px; bottom:0; width:85vw; box-shadow:4px 0 20px rgba(0,0,0,0.3); }
      }
    </style>
    <div class="chat-layout">
      <!-- Left: Conversation sidebar -->
      <div class="conv-sidebar" id="convSidebar">
        <button class="new-chat-btn" id="newChatBtn">&#10010; New Conversation</button>
        <input id="convSearch" type="text" placeholder="Search conversations..." style="margin-bottom:10px; font-size:12px;" />
        <div id="convList" style="flex:1; overflow-y:auto;"></div>
      </div>
      <!-- Right: Chat area -->
      <div class="chat-main">
        <div class="chat-scroll" id="chatScroll">
          <div class="chat-thread" id="chatMessages">
            <div style="padding:60px 0; text-align:center;">
              <div style="font-size:36px; margin-bottom:12px;">&#9993;</div>
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
            <div class="model-picker-row">
              <div class="model-picker-wrap" id="modelPickerWrap">
                <button class="model-trigger" id="modelTrigger">
                  <span id="modelLabel">Auto</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div class="model-dropdown hidden" id="modelDropdown"></div>
              </div>
            </div>
            <div class="chat-input-row">
              <textarea id="chatInput" rows="1" placeholder="Message EdgeCoder..."></textarea>
              <button class="chat-send-btn" id="sendBtn">Send</button>
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
    var selectedModel = null;
    var modelPickerOpen = false;
    var portalModels = { local: [], swarm: [] };

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
        html += "<div class=\\"" + cls + "\\" data-id=\\"" + escapeHtml(c.conversationId) + "\\">" + escapeHtml(c.title || "New chat") + "<button class=\\"conv-delete\\" data-delete-id=\\"" + escapeHtml(c.conversationId) + "\\" title=\\"Delete\\">&#128465;</button></div>";
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
        container.innerHTML = '<div style="padding:60px 0; text-align:center;"><div style="font-size:36px; margin-bottom:12px;">&#9993;</div><h2 style="margin:0 0 6px; font-size:18px; color:var(--text);">Start a conversation</h2><div class="muted" style="font-size:13px;">Ask EdgeCoder anything about your code, infrastructure, or workflow.</div></div>';
        return;
      }
      var html = "";
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        var role = m.role === "user" ? "user" : "assistant";
        var label = m.role === "user" ? "You" : "EdgeCoder";
        var timeStr = m.createdAt || m.timestamp ? formatMsgTime(m.createdAt || m.timestamp) : "";
        html += "<div class=\\"chat-msg " + role + "\\"><div class=\\"msg-header\\"><div class=\\"msg-role\\">" + label + "</div>" + (timeStr ? "<div class=\\"msg-time\\">" + timeStr + "</div>" : "") + "</div><div class=\\"msg-body\\">" + renderMarkdown(m.content || "") + "</div></div>";
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
        if (selectedModel) chatBody.model = selectedModel;
        var response = await fetch("/portal/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chatBody),
          signal: abortController.signal,
          credentials: "same-origin"
        });

        if (!response.ok) {
          var errBody = await response.text();
          throw new Error("Chat request failed: " + response.status + " " + errBody);
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
            assistantBubble.innerHTML = "<span style=\\"color:var(--danger);\\">Error: " + escapeHtml(String(err.message || err)) + "</span>";
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

    // ── Model picker ──
    function displayModelName(name) {
      if (!name) return "Auto";
      var parts = name.split(":");
      var tag = (parts[1] || "").split("-")[0];
      return tag ? parts[0] + ":" + tag : parts[0];
    }

    function updateModelLabel() {
      document.getElementById("modelLabel").textContent = displayModelName(selectedModel);
    }

    function renderModelDropdown() {
      var html = '<button class="model-option' + (!selectedModel ? ' active' : '') + '" data-model="">';
      html += '<span class="opt-name">Auto</span>';
      html += '<span class="opt-meta">Best available route</span></button>';

      if (portalModels.local && portalModels.local.length > 0) {
        html += '<div class="section-label">Local Models</div>';
        for (var i = 0; i < portalModels.local.length; i++) {
          var m = portalModels.local[i];
          var isActive = selectedModel === m.name;
          html += '<button class="model-option' + (isActive ? ' active' : '') + '" data-model="' + escapeHtml(m.name) + '">';
          html += '<span class="opt-name">' + escapeHtml(displayModelName(m.name));
          if (m.running) html += ' <span class="running-dot" style="width:6px;height:6px;border-radius:50%;background:var(--brand);display:inline-block;"></span>';
          html += '</span>';
          var meta = [];
          if (m.parameterSize) meta.push(m.parameterSize);
          if (m.quantization) meta.push(m.quantization);
          meta.push("Free");
          html += '<span class="opt-meta">' + meta.join(" \\u00B7 ") + '</span></button>';
        }
      }

      if (portalModels.swarm && portalModels.swarm.length > 0) {
        html += '<div class="section-label">Swarm Network</div>';
        for (var j = 0; j < portalModels.swarm.length; j++) {
          var s = portalModels.swarm[j];
          var isSwarmActive = selectedModel === s.model;
          var disabled = s.agentCount === 0;
          html += '<button class="model-option' + (isSwarmActive ? ' active' : '') + '"' + (disabled ? ' disabled style="opacity:0.4;cursor:default;"' : '') + ' data-model="' + escapeHtml(s.model) + '">';
          html += '<span class="opt-name">' + escapeHtml(displayModelName(s.model)) + '</span>';
          html += '<span class="opt-meta">' + s.agentCount + ' agent' + (s.agentCount === 1 ? '' : 's') + '</span></button>';
        }
      }

      if ((!portalModels.local || portalModels.local.length === 0) && (!portalModels.swarm || portalModels.swarm.length === 0)) {
        html += '<div class="opt-meta" style="padding:12px 10px; text-align:center;">No models discovered</div>';
      }

      document.getElementById("modelDropdown").innerHTML = html;
    }

    async function refreshModels() {
      try {
        portalModels = await api("/portal/api/models");
      } catch {
        portalModels = { local: [], swarm: [] };
      }
      renderModelDropdown();
    }

    function toggleModelPicker() {
      modelPickerOpen = !modelPickerOpen;
      var dropdown = document.getElementById("modelDropdown");
      var trigger = document.getElementById("modelTrigger");
      if (modelPickerOpen) {
        dropdown.classList.remove("hidden");
        trigger.classList.add("open");
        refreshModels();
      } else {
        dropdown.classList.add("hidden");
        trigger.classList.remove("open");
      }
    }

    function closeModelPicker() {
      modelPickerOpen = false;
      document.getElementById("modelDropdown").classList.add("hidden");
      document.getElementById("modelTrigger").classList.remove("open");
    }

    document.getElementById("modelTrigger").addEventListener("click", function(e) {
      e.stopPropagation();
      toggleModelPicker();
    });

    document.getElementById("modelDropdown").addEventListener("click", function(e) {
      var opt = e.target.closest(".model-option");
      if (!opt || opt.disabled) return;
      selectedModel = opt.dataset.model || null;
      updateModelLabel();
      closeModelPicker();
    });

    document.addEventListener("click", function(e) {
      if (modelPickerOpen && !document.getElementById("modelPickerWrap").contains(e.target)) {
        closeModelPicker();
      }
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
    subtitle: "AI assistant powered by the EdgeCoder swarm network.",
    content,
    script
  }));
});
}

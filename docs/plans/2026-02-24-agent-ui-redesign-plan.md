# Agent UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the EdgeCoder desktop app from a node-operator dashboard into a Claude Desktop-style chat-first IDE with two tabs (Chat | EdgeCoder), settings overlay, authentication, and Bitcoin wallet management.

**Architecture:** Replace the current 7-item sidebar layout with a clean app shell: top-center pill tabs switch between a chat view (streaming OpenAI-compat responses from the local agent) and a Monaco-based code editor. All existing dashboard pages move into a full-screen Settings overlay triggered by a bottom-left user avatar. Auth gates the app using the existing Portal auth endpoints.

**Tech Stack:** Svelte 5, Tauri 2, Monaco Editor, marked (markdown), existing Fastify backend (Portal auth on cookie sessions, IDE provider-server on :4304 for OpenAI-compat streaming)

---

## Task 1: Install New Dependencies

**Files:**
- Modify: `desktop/package.json`

**Step 1: Install monaco-editor, marked, and idb**

Run:
```bash
cd /Users/codysmith/Cursor/Edgecoder/desktop
npm install monaco-editor marked idb
npm install -D @types/marked
```

**Step 2: Verify installation**

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && node -e "require('monaco-editor'); require('marked'); require('idb'); console.log('OK')"`
Expected: `OK`

**Step 3: Commit**

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/package.json desktop/package-lock.json
git commit -m "chore(desktop): add monaco-editor, marked, and idb dependencies"
```

---

## Task 2: Update CSS Design Tokens & Global Styles

**Files:**
- Modify: `desktop/src/App.svelte` (only the `:root` CSS variables and `:global(body)` styles)

**Step 1: Replace the `:root` CSS variables and `:global(body)` in App.svelte**

Replace the existing `:root` block (lines 57-68) and `:global(body)` block (lines 69-74) with the new design tokens. Keep all other styles in App.svelte untouched for now — they'll be replaced in Task 3.

New `:root` variables:
```css
:root {
  --bg-base: #1a1a1a;
  --bg-surface: #252525;
  --bg-elevated: #2f2f2f;
  --bg-input: #1e1e1e;
  --border: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.15);
  --accent: #3b82f6;
  --accent-hover: #2563eb;
  --text-primary: #e8e6e3;
  --text-secondary: #9a9892;
  --text-muted: #6b6960;
  --green: #4ade80;
  --red: #f87171;
  --yellow: #fbbf24;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --font-mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;
}
```

New `:global(body)`:
```css
:global(body) {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg-base);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}
:global(*, *::before, *::after) {
  box-sizing: border-box;
}
```

**Step 2: Verify the app still builds**

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds (existing pages may have visual changes from new tokens — that's expected)

**Step 3: Commit**

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/App.svelte
git commit -m "style(desktop): update design tokens to warm dark palette"
```

---

## Task 3: Create the New App Shell

This is the core layout transformation. Replace the sidebar+content layout with the new header+tabs+bottom-bar shell.

**Files:**
- Modify: `desktop/src/App.svelte` (full rewrite)
- Create: `desktop/src/components/TabSwitcher.svelte`
- Create: `desktop/src/components/ChatInput.svelte`

### Step 1: Create TabSwitcher.svelte

```svelte
<script lang="ts">
  interface Props {
    activeTab: "chat" | "editor";
    onSwitch: (tab: "chat" | "editor") => void;
  }
  let { activeTab, onSwitch }: Props = $props();
</script>

<div class="tab-switcher">
  <button
    class="tab {activeTab === 'chat' ? 'active' : ''}"
    onclick={() => onSwitch("chat")}
  >Chat</button>
  <button
    class="tab {activeTab === 'editor' ? 'active' : ''}"
    onclick={() => onSwitch("editor")}
  >EdgeCoder</button>
</div>

<style>
  .tab-switcher {
    display: flex;
    background: var(--bg-surface);
    border-radius: 8px;
    padding: 3px;
    gap: 2px;
  }
  .tab {
    padding: 6px 16px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 6px;
    transition: all 0.15s;
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab.active {
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-weight: 600;
  }
</style>
```

### Step 2: Create ChatInput.svelte

```svelte
<script lang="ts">
  interface Props {
    onSend: (message: string) => void;
    placeholder?: string;
    disabled?: boolean;
  }
  let { onSend, placeholder = "Message EdgeCoder...", disabled = false }: Props = $props();

  let text = $state("");
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    text = "";
    if (textareaEl) textareaEl.style.height = "auto";
  }

  function autoResize(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }
</script>

<div class="input-bar">
  <textarea
    bind:this={textareaEl}
    bind:value={text}
    {placeholder}
    {disabled}
    rows="1"
    onkeydown={handleKeydown}
    oninput={autoResize}
  ></textarea>
  <button class="send-btn" onclick={send} disabled={!text.trim() || disabled}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13"/>
    </svg>
  </button>
</div>

<style>
  .input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    flex: 1;
  }
  textarea {
    flex: 1;
    border: none;
    background: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    outline: none;
    max-height: 200px;
  }
  textarea::placeholder {
    color: var(--text-muted);
  }
  .send-btn {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: none;
    background: var(--accent);
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .send-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
```

### Step 3: Rewrite App.svelte with the new shell

Replace the entire `<script>`, template, and `<style>` in `desktop/src/App.svelte`:

```svelte
<script lang="ts">
  import TabSwitcher from "./components/TabSwitcher.svelte";
  import ChatInput from "./components/ChatInput.svelte";

  let activeTab: "chat" | "editor" = $state("chat");
  let settingsOpen = $state(false);

  function handleSend(message: string) {
    // TODO: Task 5 will implement chat message handling
    console.log("send:", message);
  }
</script>

<div class="app-shell">
  <!-- Header / Title Bar -->
  <header class="header" data-tauri-drag-region>
    <button class="header-btn" title="New chat">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14"/>
      </svg>
    </button>

    <TabSwitcher {activeTab} onSwitch={(tab) => activeTab = tab} />

    <button class="header-btn" title="Menu">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
      </svg>
    </button>
  </header>

  <!-- Main Content Area -->
  <main class="content">
    {#if activeTab === "chat"}
      <div class="placeholder-view">
        <h2>What would you like to build?</h2>
        <p>Chat with your local EdgeCoder agent</p>
      </div>
    {:else}
      <div class="placeholder-view">
        <h2>EdgeCoder Editor</h2>
        <p>Monaco editor will be integrated here</p>
      </div>
    {/if}
  </main>

  <!-- Bottom Bar -->
  <footer class="bottom-bar">
    <button class="avatar-btn" onclick={() => settingsOpen = !settingsOpen} title="Settings">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="8" r="4"/><path d="M4 21v-1a4 4 0 014-4h8a4 4 0 014 4v1"/>
      </svg>
    </button>

    <ChatInput onSend={handleSend} />
  </footer>

  <!-- Settings Overlay (placeholder — Task 6 will build this out) -->
  {#if settingsOpen}
    <div class="settings-overlay">
      <div class="settings-header">
        <button class="back-btn" onclick={() => settingsOpen = false}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          Back
        </button>
        <h2>Settings</h2>
      </div>
      <div class="settings-body">
        <p style="color: var(--text-secondary)">Settings sub-sections will be built in Task 6.</p>
      </div>
    </div>
  {/if}
</div>

<style>
  :root {
    --bg-base: #1a1a1a;
    --bg-surface: #252525;
    --bg-elevated: #2f2f2f;
    --bg-input: #1e1e1e;
    --border: rgba(255, 255, 255, 0.08);
    --border-strong: rgba(255, 255, 255, 0.15);
    --accent: #3b82f6;
    --accent-hover: #2563eb;
    --text-primary: #e8e6e3;
    --text-secondary: #9a9892;
    --text-muted: #6b6960;
    --green: #4ade80;
    --red: #f87171;
    --yellow: #fbbf24;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
    --font-mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  }
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    background: var(--bg-base);
    color: var(--text-primary);
    -webkit-font-smoothing: antialiased;
  }
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }

  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    -webkit-app-region: drag;
  }
  .header-btn {
    width: 36px;
    height: 36px;
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    -webkit-app-region: no-drag;
  }
  .header-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  /* Content */
  .content {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .placeholder-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-secondary);
  }
  .placeholder-view h2 {
    margin: 0;
    font-size: 1.3rem;
    color: var(--text-primary);
  }
  .placeholder-view p {
    margin: 0;
    font-size: 0.9rem;
  }

  /* Bottom Bar */
  .bottom-bar {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .avatar-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: var(--bg-surface);
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .avatar-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* Settings Overlay */
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-base);
    z-index: 100;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease;
  }
  .settings-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .settings-header h2 {
    margin: 0;
    font-size: 1rem;
  }
  .back-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
  }
  .back-btn:hover {
    color: var(--text-primary);
  }
  .settings-body {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
  }

  @keyframes slideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
</style>
```

### Step 4: Verify the app builds and renders

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds. The app shows header with Chat|EdgeCoder tabs, placeholder content, and the bottom input bar.

### Step 5: Commit

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/App.svelte desktop/src/components/TabSwitcher.svelte desktop/src/components/ChatInput.svelte
git commit -m "feat(desktop): replace sidebar with chat-first app shell and tab switcher"
```

---

## Task 4: Add Chat API Client & Types

**Files:**
- Modify: `desktop/src/lib/types.ts` (add chat types)
- Modify: `desktop/src/lib/api.ts` (add chat streaming function)
- Create: `desktop/src/lib/chat-store.ts` (conversation state + IndexedDB persistence)

### Step 1: Add chat types to types.ts

Append these interfaces to `desktop/src/lib/types.ts`:

```typescript
// Chat message types (OpenAI-compatible, matching IDE provider-server)
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}
```

### Step 2: Add chat streaming function to api.ts

Append to `desktop/src/lib/api.ts`. The IDE provider-server runs on port 4304 and serves OpenAI-compatible `/v1/chat/completions` with SSE streaming.

```typescript
// ---------------------------------------------------------------------------
// IDE chat provider (:4304)
// ---------------------------------------------------------------------------

const CHAT_BASE = import.meta.env.DEV ? "/chat" : "http://localhost:4304";

export async function streamChat(
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${CHAT_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "edgecoder-local",
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 4096,
    }),
    signal,
  });

  if (!res.ok) throw new Error(`Chat request failed: ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const chunk = JSON.parse(data);
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) onChunk(content);
      } catch {
        // Skip malformed chunks
      }
    }
  }
}
```

### Step 3: Add the Vite proxy for the chat endpoint

Add to the `proxy` section in `desktop/vite.config.ts`:

```typescript
"/chat": {
  target: "http://localhost:4304",
  changeOrigin: true,
  rewrite: (path) => path.replace(/^\/chat/, ""),
},
```

### Step 4: Create chat-store.ts

Create `desktop/src/lib/chat-store.ts` for conversation state management:

```typescript
import { openDB, type IDBPDatabase } from "idb";
import type { ChatMessage, Conversation } from "./types";

// ---------------------------------------------------------------------------
// IndexedDB persistence
// ---------------------------------------------------------------------------

const DB_NAME = "edgecoder-chat";
const DB_VERSION = 1;
const STORE_NAME = "conversations";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function saveConversation(convo: Conversation): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, convo);
}

export async function loadConversation(id: string): Promise<Conversation | undefined> {
  const db = await getDb();
  return db.get(STORE_NAME, id);
}

export async function listConversations(): Promise<Conversation[]> {
  const db = await getDb();
  const all = await db.getAll(STORE_NAME);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function addMessage(
  convo: Conversation,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
  };
  convo.messages.push(msg);
  convo.updatedAt = Date.now();

  // Auto-title from first user message
  if (convo.messages.length === 1 && role === "user") {
    convo.title = content.slice(0, 60) + (content.length > 60 ? "..." : "");
  }

  return msg;
}
```

### Step 5: Verify build

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds

### Step 6: Commit

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/lib/types.ts desktop/src/lib/api.ts desktop/src/lib/chat-store.ts desktop/vite.config.ts
git commit -m "feat(desktop): add chat streaming API, types, and IndexedDB conversation store"
```

---

## Task 5: Build the Chat View

**Files:**
- Create: `desktop/src/components/ChatMessage.svelte`
- Create: `desktop/src/components/MarkdownRenderer.svelte`
- Create: `desktop/src/components/StreamingIndicator.svelte`
- Create: `desktop/src/pages/ChatView.svelte`
- Modify: `desktop/src/App.svelte` (wire up ChatView)

### Step 1: Create MarkdownRenderer.svelte

Uses `marked` to render agent markdown. Sanitizes output minimally since content comes from our own agent.

```svelte
<script lang="ts">
  import { marked } from "marked";

  interface Props {
    source: string;
  }
  let { source }: Props = $props();

  // Configure marked for code blocks
  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  let html = $derived(marked.parse(source, { async: false }) as string);
</script>

<div class="markdown">{@html html}</div>

<style>
  .markdown {
    font-size: 14px;
    line-height: 1.6;
    word-wrap: break-word;
  }
  .markdown :global(p) {
    margin: 0 0 0.75em;
  }
  .markdown :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown :global(pre) {
    background: var(--bg-input, #1e1e1e);
    border-radius: var(--radius-sm, 6px);
    padding: 12px 16px;
    overflow-x: auto;
    margin: 0.75em 0;
    font-size: 13px;
  }
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .markdown :global(:not(pre) > code) {
    background: var(--bg-input, #1e1e1e);
    padding: 2px 6px;
    border-radius: 4px;
  }
  .markdown :global(ul), .markdown :global(ol) {
    padding-left: 1.5em;
    margin: 0.5em 0;
  }
  .markdown :global(a) {
    color: var(--accent);
    text-decoration: none;
  }
  .markdown :global(a:hover) {
    text-decoration: underline;
  }
  .markdown :global(table) {
    border-collapse: collapse;
    margin: 0.75em 0;
    width: 100%;
  }
  .markdown :global(th), .markdown :global(td) {
    border: 1px solid var(--border-strong);
    padding: 6px 10px;
    text-align: left;
    font-size: 13px;
  }
  .markdown :global(th) {
    background: var(--bg-surface);
    font-weight: 600;
  }
  .markdown :global(blockquote) {
    border-left: 3px solid var(--accent);
    margin: 0.75em 0;
    padding: 4px 12px;
    color: var(--text-secondary);
  }
</style>
```

### Step 2: Create StreamingIndicator.svelte

```svelte
<span class="cursor">|</span>

<style>
  .cursor {
    display: inline;
    animation: blink 0.8s step-end infinite;
    color: var(--accent);
    font-weight: 300;
  }
  @keyframes blink {
    50% { opacity: 0; }
  }
</style>
```

### Step 3: Create ChatMessage.svelte

```svelte
<script lang="ts">
  import MarkdownRenderer from "./MarkdownRenderer.svelte";
  import StreamingIndicator from "./StreamingIndicator.svelte";

  interface Props {
    role: "user" | "assistant";
    content: string;
    streaming?: boolean;
  }
  let { role, content, streaming = false }: Props = $props();
</script>

<div class="message {role}">
  {#if role === "user"}
    <div class="bubble user-bubble">{content}</div>
  {:else}
    <div class="bubble assistant-bubble">
      <MarkdownRenderer source={content} />
      {#if streaming}
        <StreamingIndicator />
      {/if}
    </div>
  {/if}
</div>

<style>
  .message {
    display: flex;
    margin-bottom: 16px;
    padding: 0 16px;
  }
  .message.user {
    justify-content: flex-end;
  }
  .message.assistant {
    justify-content: flex-start;
  }
  .bubble {
    max-width: 85%;
    border-radius: var(--radius-md);
    padding: 10px 14px;
  }
  .user-bubble {
    background: #1e3a5f;
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .assistant-bubble {
    color: var(--text-primary);
  }
</style>
```

### Step 4: Create ChatView.svelte

```svelte
<script lang="ts">
  import ChatMessage from "../components/ChatMessage.svelte";
  import { streamChat } from "../lib/api";
  import {
    createConversation,
    addMessage,
    saveConversation,
    type Conversation,
  } from "../lib/chat-store";
  import type { ChatMessage as ChatMessageType } from "../lib/types";

  interface Props {
    onSend?: (message: string) => void;
  }
  let { onSend }: Props = $props();

  let conversation: Conversation = $state(createConversation());
  let streamingContent = $state("");
  let isStreaming = $state(false);
  let abortController: AbortController | null = $state(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);

  const quickActions = [
    { label: "Fix a bug", prompt: "Help me fix a bug in my code" },
    { label: "Write tests", prompt: "Help me write tests" },
    { label: "Explain code", prompt: "Explain how this code works" },
  ];

  // Bind this method for parent to call
  export async function sendMessage(text: string) {
    if (isStreaming) return;

    addMessage(conversation, "user", text);
    conversation = conversation; // trigger reactivity

    isStreaming = true;
    streamingContent = "";
    abortController = new AbortController();

    const apiMessages = conversation.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      await streamChat(
        apiMessages,
        (chunk) => {
          streamingContent += chunk;
          scrollToBottom();
        },
        abortController.signal,
      );
      addMessage(conversation, "assistant", streamingContent);
      conversation = conversation;
      await saveConversation(conversation);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        addMessage(conversation, "assistant", `Error: ${(err as Error).message}`);
        conversation = conversation;
      }
    } finally {
      streamingContent = "";
      isStreaming = false;
      abortController = null;
    }
  }

  function scrollToBottom() {
    if (scrollContainer) {
      requestAnimationFrame(() => {
        scrollContainer!.scrollTop = scrollContainer!.scrollHeight;
      });
    }
  }

  function handleQuickAction(prompt: string) {
    sendMessage(prompt);
  }

  // Expose sendMessage to parent
  onSend = (msg: string) => sendMessage(msg);
</script>

<div class="chat-view" bind:this={scrollContainer}>
  {#if conversation.messages.length === 0 && !isStreaming}
    <!-- Empty state -->
    <div class="empty-state">
      <h2>What would you like to build?</h2>
      <p>Chat with your local EdgeCoder agent. It can write code, run tests, and delegate to the network.</p>
      <div class="quick-actions">
        {#each quickActions as action}
          <button class="chip" onclick={() => handleQuickAction(action.prompt)}>
            {action.label}
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <!-- Messages -->
    <div class="messages">
      {#each conversation.messages as msg (msg.id)}
        <ChatMessage role={msg.role as "user" | "assistant"} content={msg.content} />
      {/each}
      {#if isStreaming && streamingContent}
        <ChatMessage role="assistant" content={streamingContent} streaming={true} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .chat-view {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    text-align: center;
    padding: 24px;
  }
  .empty-state h2 {
    margin: 0;
    font-size: 1.4rem;
    color: var(--text-primary);
  }
  .empty-state p {
    margin: 0;
    color: var(--text-secondary);
    max-width: 400px;
  }
  .quick-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .chip {
    padding: 8px 16px;
    border: 1px solid var(--border-strong);
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: 20px;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  .chip:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .messages {
    flex: 1;
    display: flex;
    flex-direction: column;
    max-width: 768px;
    width: 100%;
    margin: 0 auto;
    padding: 16px 0;
  }
</style>
```

### Step 5: Wire ChatView into App.svelte

In App.svelte, add the import and replace the chat placeholder:

1. Add import: `import ChatView from "./pages/ChatView.svelte";`
2. Add a ref: `let chatView: ChatView | undefined = $state(undefined);`
3. Replace the chat placeholder block:
```svelte
{#if activeTab === "chat"}
  <ChatView bind:this={chatView} onSend={(msg) => chatView?.sendMessage(msg)} />
{:else}
  <div class="placeholder-view">
    <h2>EdgeCoder Editor</h2>
    <p>Monaco editor will be integrated here</p>
  </div>
{/if}
```
4. Update `handleSend` to delegate:
```typescript
function handleSend(message: string) {
  if (activeTab === "chat" && chatView) {
    chatView.sendMessage(message);
  }
}
```

### Step 6: Verify build

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds

### Step 7: Commit

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/components/ChatMessage.svelte desktop/src/components/MarkdownRenderer.svelte desktop/src/components/StreamingIndicator.svelte desktop/src/pages/ChatView.svelte desktop/src/App.svelte
git commit -m "feat(desktop): build chat view with streaming, markdown rendering, and conversation state"
```

---

## Task 6: Build the Settings Overlay

Move all existing dashboard pages into the Settings overlay as sub-sections.

**Files:**
- Create: `desktop/src/components/SettingsOverlay.svelte`
- Modify: `desktop/src/App.svelte` (replace inline settings overlay with component)

### Step 1: Create SettingsOverlay.svelte

This component wraps all existing pages as sub-sections within a settings sidebar navigation.

```svelte
<script lang="ts">
  import Dashboard from "../pages/Dashboard.svelte";
  import MeshTopology from "../pages/MeshTopology.svelte";
  import ModelManager from "../pages/ModelManager.svelte";
  import Credits from "../pages/Credits.svelte";
  import TaskQueue from "../pages/TaskQueue.svelte";
  import Settings from "../pages/Settings.svelte";
  import LogViewer from "../pages/LogViewer.svelte";

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  const sections = [
    { id: "dashboard", label: "Dashboard", component: Dashboard },
    { id: "mesh", label: "Mesh", component: MeshTopology },
    { id: "models", label: "Models", component: ModelManager },
    { id: "tasks", label: "Tasks", component: TaskQueue },
    { id: "wallet", label: "Wallet", component: Credits },
    { id: "logs", label: "Logs", component: LogViewer },
    { id: "preferences", label: "Preferences", component: Settings },
  ] as const;

  let activeSectionId = $state("dashboard");
  let ActiveSection = $derived(
    sections.find((s) => s.id === activeSectionId)?.component ?? Dashboard
  );
</script>

<div class="overlay">
  <div class="overlay-header">
    <button class="back-btn" onclick={onClose}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7"/>
      </svg>
      Back
    </button>
    <h2>Settings</h2>
  </div>
  <div class="overlay-body">
    <nav class="settings-nav">
      {#each sections as section}
        <button
          class="nav-item {activeSectionId === section.id ? 'active' : ''}"
          onclick={() => activeSectionId = section.id}
        >
          {section.label}
        </button>
      {/each}
    </nav>
    <div class="settings-content">
      <ActiveSection />
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-base);
    z-index: 100;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease;
  }
  .overlay-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .overlay-header h2 {
    margin: 0;
    font-size: 1rem;
  }
  .back-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    transition: color 0.15s;
  }
  .back-btn:hover {
    color: var(--text-primary);
  }
  .overlay-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .settings-nav {
    width: 180px;
    border-right: 1px solid var(--border);
    padding: 12px 0;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow-y: auto;
  }
  .nav-item {
    padding: 8px 20px;
    border: none;
    background: none;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  .nav-item:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
  .nav-item.active {
    color: var(--text-primary);
    background: var(--bg-surface);
    font-weight: 600;
    border-left: 2px solid var(--accent);
  }
  .settings-content {
    flex: 1;
    overflow-y: auto;
  }
  @keyframes slideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
</style>
```

### Step 2: Update App.svelte to use SettingsOverlay

1. Add import: `import SettingsOverlay from "./components/SettingsOverlay.svelte";`
2. Replace the inline settings overlay block with:
```svelte
{#if settingsOpen}
  <SettingsOverlay onClose={() => settingsOpen = false} />
{/if}
```
3. Remove the old imports of pages that are no longer directly used (Dashboard, MeshTopology, etc.) from App.svelte, since they're now imported by SettingsOverlay.
4. Remove unused code: the `pages` array, `components` record, `activePageId`, `ActiveComponent`, `ConnectionBar` import — all the old sidebar navigation logic.

### Step 3: Verify build

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds

### Step 4: Commit

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/components/SettingsOverlay.svelte desktop/src/App.svelte
git commit -m "feat(desktop): move all dashboard pages into settings overlay"
```

---

## Task 7: Integrate Monaco Editor

**Files:**
- Create: `desktop/src/pages/EditorView.svelte`
- Create: `desktop/src/components/FileExplorer.svelte`
- Create: `desktop/src/lib/editor-store.ts`
- Modify: `desktop/src/App.svelte` (wire EditorView)
- Modify: `desktop/vite.config.ts` (Monaco worker config)

### Step 1: Configure Vite for Monaco workers

Monaco needs web workers. Add to `desktop/vite.config.ts` — import and configure the Monaco Vite plugin. Since there isn't a dedicated plugin for Svelte+Monaco, use a manual worker entry. Add to the `build` section of the Vite config:

```typescript
// At the top of vite.config.ts, add:
import { resolve } from "path";

// Inside defineConfig, update the build section:
build: {
  target: "esnext",
  minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
  sourcemap: !!process.env.TAURI_DEBUG,
  rollupOptions: {
    output: {
      manualChunks: {
        "monaco-editor": ["monaco-editor"],
      },
    },
  },
},
```

### Step 2: Create editor-store.ts

```typescript
// Virtual file system for the editor
export interface EditorFile {
  path: string;
  content: string;
  language: string;
  dirty: boolean;
}

const languageMap: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  rs: "rust",
  go: "go",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  svelte: "html",
};

export function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return languageMap[ext] ?? "plaintext";
}

export function createFile(path: string, content: string): EditorFile {
  return {
    path,
    content,
    language: detectLanguage(path),
    dirty: false,
  };
}
```

### Step 3: Create FileExplorer.svelte

```svelte
<script lang="ts">
  import type { EditorFile } from "../lib/editor-store";

  interface Props {
    files: EditorFile[];
    activeFile: string | null;
    onSelect: (path: string) => void;
  }
  let { files, activeFile, onSelect }: Props = $props();
</script>

<div class="explorer">
  <div class="explorer-header">FILES</div>
  {#if files.length === 0}
    <div class="empty">No files open</div>
  {:else}
    {#each files as file}
      <button
        class="file-item {activeFile === file.path ? 'active' : ''}"
        onclick={() => onSelect(file.path)}
      >
        <span class="filename">{file.path.split("/").pop()}</span>
        {#if file.dirty}
          <span class="dot">*</span>
        {/if}
      </button>
    {/each}
  {/if}
</div>

<style>
  .explorer {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    padding: 8px 0;
  }
  .explorer-header {
    padding: 4px 16px 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }
  .empty {
    padding: 16px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .file-item {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 4px 16px;
    border: none;
    background: none;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.1s;
  }
  .file-item:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .file-item.active {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .filename {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    color: var(--accent);
    font-weight: bold;
  }
</style>
```

### Step 4: Create EditorView.svelte

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import FileExplorer from "../components/FileExplorer.svelte";
  import { createFile, type EditorFile } from "../lib/editor-store";

  let editorContainer: HTMLDivElement | undefined = $state(undefined);
  let editor: any = $state(null);
  let monaco: any = $state(null);

  let files: EditorFile[] = $state([
    createFile("main.py", '# Welcome to EdgeCoder\nprint("Hello, world!")'),
  ]);
  let activeFilePath: string | null = $state("main.py");
  let explorerWidth = $state(200);

  let activeFile = $derived(files.find((f) => f.path === activeFilePath) ?? null);

  onMount(async () => {
    // Dynamic import to avoid SSR issues
    const mon = await import("monaco-editor");
    monaco = mon;

    // Configure dark theme
    mon.editor.defineTheme("edgecoder-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#1a1a1a",
        "editor.foreground": "#e8e6e3",
        "editorLineNumber.foreground": "#6b6960",
        "editorLineNumber.activeForeground": "#9a9892",
        "editor.selectionBackground": "#264f78",
        "editor.lineHighlightBackground": "#252525",
        "editorCursor.foreground": "#3b82f6",
      },
    });

    if (editorContainer) {
      editor = mon.editor.create(editorContainer, {
        value: activeFile?.content ?? "",
        language: activeFile?.language ?? "plaintext",
        theme: "edgecoder-dark",
        minimap: { enabled: false },
        fontSize: 14,
        fontFamily: "SF Mono, Fira Code, Cascadia Code, monospace",
        lineNumbers: "on",
        renderLineHighlight: "line",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12 },
      });

      editor.onDidChangeModelContent(() => {
        if (activeFile) {
          activeFile.content = editor.getValue();
          activeFile.dirty = true;
          files = files; // trigger reactivity
        }
      });
    }
  });

  onDestroy(() => {
    editor?.dispose();
  });

  function selectFile(path: string) {
    activeFilePath = path;
    const file = files.find((f) => f.path === path);
    if (file && editor && monaco) {
      const model = monaco.editor.createModel(file.content, file.language);
      editor.setModel(model);
    }
  }

  // Public method: open a file from the chat tab
  export function openFile(path: string, content: string) {
    const existing = files.find((f) => f.path === path);
    if (existing) {
      existing.content = content;
      files = files;
      selectFile(path);
    } else {
      const newFile = createFile(path, content);
      files = [...files, newFile];
      selectFile(path);
    }
  }
</script>

<div class="editor-layout">
  <div class="explorer-panel" style="width: {explorerWidth}px">
    <FileExplorer {files} activeFile={activeFilePath} onSelect={selectFile} />
  </div>
  <div class="editor-panel">
    {#if activeFile}
      <div class="tab-bar">
        {#each files as file}
          <button
            class="file-tab {activeFilePath === file.path ? 'active' : ''}"
            onclick={() => selectFile(file.path)}
          >
            {file.path.split("/").pop()}{file.dirty ? " *" : ""}
          </button>
        {/each}
      </div>
    {/if}
    <div class="monaco-container" bind:this={editorContainer}></div>
  </div>
</div>

<style>
  .editor-layout {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .explorer-panel {
    border-right: 1px solid var(--border);
    flex-shrink: 0;
    overflow: hidden;
  }
  .editor-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tab-bar {
    display: flex;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .file-tab {
    padding: 8px 16px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    white-space: nowrap;
    transition: all 0.1s;
  }
  .file-tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
    background: var(--bg-base);
  }
  .file-tab:hover:not(.active) {
    color: var(--text-primary);
  }
  .monaco-container {
    flex: 1;
  }
</style>
```

### Step 5: Wire EditorView into App.svelte

1. Add import: `import EditorView from "./pages/EditorView.svelte";`
2. Add ref: `let editorView: EditorView | undefined = $state(undefined);`
3. Replace the editor placeholder in the content area:
```svelte
{:else}
  <EditorView bind:this={editorView} />
{/if}
```

### Step 6: Verify build

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds. Monaco chunk is separate in the output.

### Step 7: Commit

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/pages/EditorView.svelte desktop/src/components/FileExplorer.svelte desktop/src/lib/editor-store.ts desktop/src/App.svelte desktop/vite.config.ts
git commit -m "feat(desktop): integrate Monaco editor with file explorer and tab bar"
```

---

## Task 8: Build the Login Screen

**Files:**
- Create: `desktop/src/pages/LoginScreen.svelte`
- Create: `desktop/src/lib/auth-store.ts`
- Modify: `desktop/src/lib/api.ts` (add auth API functions)
- Modify: `desktop/src/App.svelte` (gate app behind auth)
- Modify: `desktop/vite.config.ts` (add portal proxy)

### Step 1: Add portal proxy to vite.config.ts

The portal server runs on a configurable port. For dev, proxy through Vite. Add to the proxy config:

```typescript
"/portal": {
  target: "http://localhost:4305",
  changeOrigin: true,
  rewrite: (path) => path.replace(/^\/portal/, ""),
},
```

Note: The actual portal port may differ. Check `.env` or environment. Default to 4305 for dev proxy.

### Step 2: Add auth API functions to api.ts

Append to `desktop/src/lib/api.ts`:

```typescript
// ---------------------------------------------------------------------------
// Portal auth
// ---------------------------------------------------------------------------

const PORTAL_BASE = import.meta.env.DEV ? "/portal" : "http://localhost:4305";

export interface AuthCapabilities {
  password: boolean;
  passkey: { enabled: boolean; rpId: string; allowedOrigins: string[] };
  oauth: { google: boolean; microsoft: boolean; apple: boolean };
}

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}

export async function getAuthCapabilities(): Promise<AuthCapabilities> {
  return get<AuthCapabilities>(PORTAL_BASE, "/auth/capabilities");
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${PORTAL_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Login failed: ${res.status}`);
  }
  return res.json();
}

export async function signup(email: string, password: string): Promise<{ userId: string }> {
  return post<{ userId: string }>(PORTAL_BASE, "/auth/signup", { email, password });
}

export async function getMe(): Promise<AuthUser> {
  const res = await fetch(`${PORTAL_BASE}/me`, { credentials: "include" });
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}

export async function logout(): Promise<void> {
  await fetch(`${PORTAL_BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export function getOAuthStartUrl(provider: "google" | "microsoft"): string {
  return `${PORTAL_BASE}/auth/oauth/${provider}/start`;
}
```

### Step 3: Create auth-store.ts

```typescript
import { getMe, logout as apiLogout } from "./api";
import type { AuthUser } from "./api";

let currentUser: AuthUser | null = $state(null);
let loading = $state(true);
let error = $state("");

export function getAuthState() {
  return {
    get user() { return currentUser; },
    get loading() { return loading; },
    get error() { return error; },
  };
}

export async function checkSession(): Promise<boolean> {
  loading = true;
  error = "";
  try {
    currentUser = await getMe();
    return true;
  } catch {
    currentUser = null;
    return false;
  } finally {
    loading = false;
  }
}

export function setUser(user: AuthUser) {
  currentUser = user;
  loading = false;
  error = "";
}

export async function logout() {
  try {
    await apiLogout();
  } finally {
    currentUser = null;
  }
}
```

Note: Svelte 5 module-level `$state` requires the file to be a `.svelte.ts` file. Rename to `auth-store.svelte.ts`.

### Step 4: Create LoginScreen.svelte

```svelte
<script lang="ts">
  import { login, getOAuthStartUrl } from "../lib/api";
  import type { AuthUser } from "../lib/api";

  interface Props {
    onLogin: (user: AuthUser) => void;
  }
  let { onLogin }: Props = $props();

  let email = $state("");
  let password = $state("");
  let error = $state("");
  let submitting = $state(false);
  let mode: "login" | "signup" = $state("login");

  async function handleSubmit() {
    if (!email.trim() || !password.trim()) return;
    submitting = true;
    error = "";

    try {
      const user = await login(email, password);
      onLogin(user);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      submitting = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") handleSubmit();
  }

  function handleOAuth(provider: "google" | "microsoft") {
    // Open OAuth in system browser via Tauri shell API
    const url = getOAuthStartUrl(provider);
    window.open(url, "_blank");
  }
</script>

<div class="login-screen">
  <div class="login-card">
    <div class="logo">
      <h1>EdgeCoder</h1>
    </div>

    {#if error}
      <div class="error-msg">{error}</div>
    {/if}

    <div class="form">
      <input
        type="email"
        bind:value={email}
        placeholder="Email"
        onkeydown={handleKeydown}
        disabled={submitting}
      />
      <input
        type="password"
        bind:value={password}
        placeholder="Password"
        onkeydown={handleKeydown}
        disabled={submitting}
      />
      <button class="btn-primary" onclick={handleSubmit} disabled={submitting}>
        {submitting ? "Signing in..." : "Sign In"}
      </button>
    </div>

    <div class="divider">
      <span>or continue with</span>
    </div>

    <div class="oauth-buttons">
      <button class="btn-oauth" onclick={() => handleOAuth("microsoft")}>
        Microsoft 365
      </button>
      <button class="btn-oauth" onclick={() => handleOAuth("google")}>
        Google
      </button>
    </div>

    <p class="signup-link">
      Don't have an account? <button class="link-btn">Sign up</button>
    </p>
  </div>
</div>

<style>
  .login-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-base);
  }
  .login-card {
    width: 380px;
    padding: 40px 32px;
    text-align: center;
  }
  .logo h1 {
    font-size: 1.6rem;
    margin: 0 0 32px;
    color: var(--text-primary);
  }
  .error-msg {
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    margin-bottom: 16px;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form input {
    padding: 12px 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .form input:focus {
    border-color: var(--accent);
  }
  .form input::placeholder {
    color: var(--text-muted);
  }
  .btn-primary {
    padding: 12px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .divider {
    margin: 24px 0;
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .divider::before, .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-strong);
  }
  .oauth-buttons {
    display: flex;
    gap: 8px;
  }
  .btn-oauth {
    flex: 1;
    padding: 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-oauth:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .signup-link {
    margin-top: 24px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .link-btn {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 13px;
    padding: 0;
  }
  .link-btn:hover {
    text-decoration: underline;
  }
</style>
```

### Step 5: Gate App.svelte behind auth

In App.svelte:

1. Add imports:
```typescript
import LoginScreen from "./pages/LoginScreen.svelte";
import type { AuthUser } from "./lib/api";
import { getMe } from "./lib/api";
```

2. Add auth state:
```typescript
let user: AuthUser | null = $state(null);
let authChecked = $state(false);

$effect(() => {
  getMe()
    .then((u) => { user = u; })
    .catch(() => { user = null; })
    .finally(() => { authChecked = true; });
});

function handleLogin(u: AuthUser) {
  user = u;
}
```

3. Wrap the app-shell template:
```svelte
{#if !authChecked}
  <div class="loading-screen">
    <p>Loading...</p>
  </div>
{:else if !user}
  <LoginScreen onLogin={handleLogin} />
{:else}
  <div class="app-shell">
    <!-- existing app shell content -->
  </div>
{/if}
```

Add `.loading-screen` style:
```css
.loading-screen {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}
```

### Step 6: Verify build

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds

### Step 7: Commit

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/pages/LoginScreen.svelte desktop/src/lib/auth-store.svelte.ts desktop/src/lib/api.ts desktop/src/App.svelte desktop/vite.config.ts
git commit -m "feat(desktop): add login screen with email/password and OAuth, gate app behind auth"
```

---

## Task 9: Update Tauri Configuration

**Files:**
- Modify: `desktop/src-tauri/tauri.conf.json`

### Step 1: Update window title and CSP

```json
{
  "app": {
    "windows": [
      {
        "title": "EdgeCoder",
        "width": 1200,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600
      }
    ],
    "security": {
      "csp": "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:1420 blob:; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* https://accounts.google.com https://login.microsoftonline.com https://graph.microsoft.com https://oauth2.googleapis.com; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:"
    }
  }
}
```

Key changes:
- Title: `"EdgeCoder"` (removed "Node Operator" since it's now a chat-first IDE)
- CSP: Added `blob:` for script-src and worker-src (Monaco workers), and OAuth provider URLs in connect-src

### Step 2: Verify Tauri build

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds

### Step 3: Commit

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src-tauri/tauri.conf.json
git commit -m "chore(desktop): update Tauri window title and CSP for Monaco and OAuth"
```

---

## Task 10: Add Account Section to Settings with Logout

**Files:**
- Create: `desktop/src/pages/Account.svelte`
- Modify: `desktop/src/components/SettingsOverlay.svelte` (add Account section)
- Modify: `desktop/src/App.svelte` (pass user + logout handler to SettingsOverlay)

### Step 1: Create Account.svelte

```svelte
<script lang="ts">
  import { logout } from "../lib/api";
  import type { AuthUser } from "../lib/api";

  interface Props {
    user: AuthUser;
    onLogout: () => void;
  }
  let { user, onLogout }: Props = $props();

  let loggingOut = $state(false);

  async function handleLogout() {
    loggingOut = true;
    try {
      await logout();
      onLogout();
    } finally {
      loggingOut = false;
    }
  }
</script>

<div class="account">
  <h1>Account</h1>

  <div class="section">
    <h2>Profile</h2>
    <div class="field-grid">
      <span class="field-label">Email</span>
      <span class="field-value">{user.email}</span>

      <span class="field-label">Display Name</span>
      <span class="field-value">{user.displayName ?? "—"}</span>

      <span class="field-label">Email Verified</span>
      <span class="field-value">
        {#if user.emailVerified}
          <span class="badge verified">Verified</span>
        {:else}
          <span class="badge unverified">Not verified</span>
        {/if}
      </span>
    </div>
  </div>

  <div class="section">
    <button class="btn-danger" onclick={handleLogout} disabled={loggingOut}>
      {loggingOut ? "Signing out..." : "Sign Out"}
    </button>
  </div>
</div>

<style>
  .account {
    padding: 1.5rem;
    max-width: 640px;
  }
  h1 { margin: 0 0 1.5rem; font-size: 1.4rem; }
  .section {
    background: var(--bg-card, var(--bg-surface));
    border: 1px solid var(--border);
    padding: 1.2rem 1.4rem;
    border-radius: var(--radius-md);
    margin-bottom: 1.2rem;
  }
  .section h2 {
    font-size: 0.92rem;
    margin: 0 0 1rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .field-grid {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0.5rem 1rem;
    font-size: 0.85rem;
  }
  .field-label { color: var(--text-muted); }
  .field-value { color: var(--text-primary); }
  .badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .badge.verified {
    color: var(--green);
    background: rgba(74, 222, 128, 0.12);
  }
  .badge.unverified {
    color: var(--yellow);
    background: rgba(251, 191, 36, 0.12);
  }
  .btn-danger {
    padding: 8px 20px;
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    border: 1px solid rgba(248, 113, 113, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    transition: all 0.15s;
  }
  .btn-danger:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.2);
  }
  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
```

### Step 2: Update SettingsOverlay to include Account section

Add Account import and section. Pass `user` and `onLogout` as props:

1. Add to SettingsOverlay props: `user: AuthUser` and `onLogout: () => void`
2. Add Account import and put it first in the sections array
3. For Account, render with user/onLogout props instead of generic `<ActiveSection />`

### Step 3: Update App.svelte

Pass the user and a logout handler to SettingsOverlay:
```svelte
<SettingsOverlay
  onClose={() => settingsOpen = false}
  {user}
  onLogout={() => { user = null; settingsOpen = false; }}
/>
```

### Step 4: Verify build

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds

### Step 5: Commit

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/pages/Account.svelte desktop/src/components/SettingsOverlay.svelte desktop/src/App.svelte
git commit -m "feat(desktop): add account section to settings with profile display and sign out"
```

---

## Task 11: Clean Up Unused Imports and ConnectionBar

**Files:**
- Modify: `desktop/src/App.svelte` (ensure no old imports remain)

### Step 1: Verify App.svelte is clean

Ensure these old imports are fully removed from App.svelte (they should have been removed in Task 6, but verify):
- `ConnectionBar`
- `Dashboard`, `MeshTopology`, `ModelManager`, `Credits`, `TaskQueue`, `Settings`, `LogViewer` (these are now imported only by SettingsOverlay)
- The old `pages` array, `components` record, `activePageId`, `ActiveComponent` variables

### Step 2: Verify the full app builds cleanly

Run: `cd /Users/codysmith/Cursor/Edgecoder/desktop && npm run build`
Expected: Build succeeds with no warnings about unused imports

### Step 3: Commit (only if changes were needed)

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/App.svelte
git commit -m "chore(desktop): remove unused imports from old sidebar layout"
```

---

## Summary

| Task | Description | Key Output |
|------|-------------|------------|
| 1 | Install dependencies | monaco-editor, marked, idb in package.json |
| 2 | Update design tokens | New warm dark palette, typography |
| 3 | Create app shell | TabSwitcher, ChatInput, new App.svelte layout |
| 4 | Chat API + store | Streaming client, IndexedDB persistence, chat types |
| 5 | Chat view | ChatView, ChatMessage, MarkdownRenderer, StreamingIndicator |
| 6 | Settings overlay | SettingsOverlay wrapping all old pages |
| 7 | Monaco editor | EditorView, FileExplorer, editor-store |
| 8 | Login screen | LoginScreen, auth-store, auth API, app gating |
| 9 | Tauri config | Updated title, CSP for Monaco+OAuth |
| 10 | Account settings | Account page with profile and sign out |
| 11 | Cleanup | Remove unused old imports |

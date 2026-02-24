<script lang="ts">
  import TabSwitcher from "./components/TabSwitcher.svelte";
  import ChatInput from "./components/ChatInput.svelte";
  import ChatView from "./pages/ChatView.svelte";
  import EditorView from "./pages/EditorView.svelte";
  import SettingsOverlay from "./components/SettingsOverlay.svelte";
  import LoginScreen from "./pages/LoginScreen.svelte";
  import type { AuthUser } from "./lib/api";
  import { getMe } from "./lib/api";

  let activeTab: "chat" | "editor" = $state("chat");
  let settingsOpen = $state(false);
  let chatView: ChatView | undefined = $state(undefined);

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

  function handleSend(message: string) {
    if (activeTab === "chat" && chatView) {
      chatView.sendMessage(message);
    }
  }
</script>

{#if !authChecked}
  <div class="loading-screen">
    <p>Loading...</p>
  </div>
{:else if !user}
  <LoginScreen onLogin={handleLogin} />
{:else}
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
        <ChatView bind:this={chatView} />
      {:else}
        <EditorView />
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

    {#if settingsOpen}
      <SettingsOverlay onClose={() => settingsOpen = false} />
    {/if}
  </div>
{/if}

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

  .loading-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
  }
</style>

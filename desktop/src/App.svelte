<script lang="ts">
  import TabSwitcher from "./components/TabSwitcher.svelte";
  import ChatInput from "./components/ChatInput.svelte";
  import ChatView from "./pages/ChatView.svelte";
  import EditorView from "./pages/EditorView.svelte";
  import SettingsOverlay from "./components/SettingsOverlay.svelte";
  import ConversationSidebar from "./components/ConversationSidebar.svelte";
  import LoginScreen from "./pages/LoginScreen.svelte";
  import OllamaSetup from "./components/OllamaSetup.svelte";
  import type { AuthUser } from "./lib/api";
  import { getMe, checkOllamaAvailable, clearSessionToken, ideSetProject, ideGetProject, backendReady, completeOAuthWithToken } from "./lib/api";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import EndpointBanner from "./components/EndpointBanner.svelte";
  import { Toaster } from "svelte-sonner";
  import AuthExpiredBanner from "./components/AuthExpiredBanner.svelte";
  import CommandPalette from "./components/CommandPalette.svelte";
  import { isMac, type PaletteCommand } from "./lib/palette";
  import { setTheme } from "./lib/theme";
  import { startPeriodicCheck, stopPeriodicCheck } from "./lib/updater";

  let activeTab: "chat" | "editor" = $state("chat");
  let settingsOpen = $state(false);
  let historyOpen = $state(true);
  let chatView: ChatView | undefined = $state(undefined);
  let editorView: EditorView | undefined = $state(undefined);

  let user: AuthUser | null = $state(null);
  let authChecked = $state(false);
  let showOllamaSetup = $state(false);

  /** IDE agent project state — shared across tabs */
  let projectRoot: string | null = $state(null);
  let gitBranch: string | null = $state(null);

  $effect(() => {
    getMe()
      .then((u) => { user = u; startPeriodicCheck(); })
      .catch(() => { user = null; })
      .finally(() => { authChecked = true; });
    return () => stopPeriodicCheck();
  });

  // Restore existing IDE project on startup
  $effect(() => {
    if (user) {
      backendReady.then(() => {
        ideGetProject().then(p => { if (p) projectRoot = p; });
      });
    }
  });

  $effect(() => {
    if (user) {
      checkOllamaAvailable().then((ok) => {
        if (!ok) showOllamaSetup = true;
      });
    }
  });

  // Handle deep-link callback when user is already logged in (e.g. GitHub OAuth)
  $effect(() => {
    if (!user) return;
    (window as any).__handleDeepLink = async (urlStr: string) => {
      try {
        const raw = typeof urlStr === "string" ? urlStr : String(urlStr);
        const cleaned = raw.startsWith('"') ? JSON.parse(raw) : raw;
        const url = new URL(cleaned);
        const provider = url.searchParams.get("provider");
        const token = url.searchParams.get("mobile_token");
        const status = url.searchParams.get("status");

        if (status !== "ok" || !token) return;

        if (provider === "github") {
          // GitHub OAuth completed — the portal already saved the token during callback.
          // Exchange mobile token so session stays valid, then notify Integrations page.
          await completeOAuthWithToken(token);
          window.dispatchEvent(new CustomEvent("edgecoder:github-connected"));
        } else {
          // Other providers — complete login flow
          const u = await completeOAuthWithToken(token);
          handleLogin(u);
        }
      } catch {
        // Silently ignore — LoginScreen handler is fallback
      }
    };
  });

  async function handleLogin(u: AuthUser) {
    // Always fetch full profile from /me — login/OAuth responses have limited fields
    try {
      const full = await getMe();
      user = full;
    } catch {
      // Fall back to the login response if /me fails
      user = u;
    }
  }

  function handleOpenInEditor(code: string, language: string) {
    const extMap: Record<string, string> = {
      python: 'py', javascript: 'js', typescript: 'ts',
      rust: 'rs', go: 'go', html: 'html', css: 'css', json: 'json',
      java: 'java', cpp: 'cpp', c: 'c', ruby: 'rb', php: 'php',
      swift: 'swift', kotlin: 'kt', shell: 'sh', bash: 'sh',
      yaml: 'yml', toml: 'toml', sql: 'sql', xml: 'xml',
    };
    const ext = extMap[language] || 'txt';
    const filename = `snippet.${ext}`;
    activeTab = "editor";
    // Need a tick for EditorView to mount if switching tabs
    setTimeout(() => {
      editorView?.openFile(filename, code);
    }, 50);
  }

  async function handleSelectConversation(id: string) {
    activeTab = "chat";
    if (chatView) {
      await chatView.loadConversation(id);
    }
  }

  function handleNewChatFromSidebar() {
    activeTab = "chat";
    chatView?.newChat();
  }

  async function openProject() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, title: "Open Project" });
      if (selected && typeof selected === "string") {
        projectRoot = selected;
        await ideSetProject(selected);
      }
    } catch (err) {
      console.warn("Failed to open project dialog:", err);
    }
  }

  // #24: Cmd/Ctrl+K command palette.
  let paletteOpen = $state(false);
  const paletteKey = isMac() ? "⌘K" : "Ctrl+K";
  let paletteCommands: PaletteCommand[] = $derived([
    { id: "go-chat", label: "Go to Chat", group: "Navigate", run: () => (activeTab = "chat") },
    { id: "go-editor", label: "Go to Editor", group: "Navigate", keywords: ["EdgeCoder", "IDE", "code"], run: () => (activeTab = "editor") },
    { id: "settings", label: "Open Settings", group: "Navigate", keywords: ["preferences"], run: () => (settingsOpen = true) },
    { id: "new-chat", label: "New chat", group: "Chat", run: () => { activeTab = "chat"; chatView?.newChat(); } },
    { id: "toggle-sidebar", label: historyOpen ? "Hide chat history" : "Show chat history", group: "Chat", keywords: ["sidebar"], when: activeTab === "chat", run: () => (historyOpen = !historyOpen) },
    { id: "open-project", label: "Open project folder…", group: "Project", keywords: ["folder", "workspace"], run: () => { activeTab = "editor"; openProject(); } },
    { id: "theme-system", label: "Theme: System", group: "Appearance", run: () => setTheme("system") },
    { id: "theme-light", label: "Theme: Light", group: "Appearance", run: () => setTheme("light") },
    { id: "theme-dark", label: "Theme: Dark", group: "Appearance", run: () => setTheme("dark") },
    { id: "sign-out", label: "Sign out", group: "Account", keywords: ["log out", "logout"], run: () => { clearSessionToken(); user = null; settingsOpen = false; } },
  ]);

  function handleSend(message: string) {
    if (activeTab === "chat" && chatView) {
      chatView.sendMessage(message);
    }
  }
</script>

<EndpointBanner />
<!-- #24: one accessible toast region (aria-live) for the whole app, login screen included. -->
<Toaster position="bottom-right" theme="system" richColors closeButton />

{#if !authChecked}
  <div class="loading-screen">
    <p>Loading...</p>
  </div>
{:else if !user}
  <LoginScreen onLogin={handleLogin} />
{:else}
  <div class="app-shell">
    <UpdateBanner />
    <AuthExpiredBanner onSignIn={() => { clearSessionToken(); user = null; settingsOpen = false; }} />
    <CommandPalette commands={paletteCommands} bind:open={paletteOpen} />
    <!-- Header / Title Bar -->
    <header class="header" data-tauri-drag-region>
      <button class="header-btn" title="New chat" onclick={() => {
        activeTab = "chat";
        chatView?.newChat();
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12h14"/>
        </svg>
      </button>

      <TabSwitcher {activeTab} onSwitch={(tab) => activeTab = tab} />
      <button class="header-btn" title="Command palette ({paletteKey})" aria-label="Open command palette" aria-keyshortcuts={isMac() ? "Meta+K" : "Control+K"} onclick={() => (paletteOpen = true)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </button>

      <button class="header-btn" title={activeTab === "chat" ? (historyOpen ? "Hide sidebar" : "Show sidebar") : "Toggle chat"} onclick={() => {
        if (activeTab === "chat") {
          historyOpen = !historyOpen;
        } else {
          editorView?.toggleChatPanel?.();
        }
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M9 3v18"/>
        </svg>
      </button>
    </header>

    <!-- Main Content Area — both views stay mounted, hidden via CSS -->
    <main class="content">
      <div class="tab-panel chat-layout" class:hidden={activeTab !== "chat"}>
        <div class="chat-sidebar" class:collapsed={!historyOpen}>
          <ConversationSidebar
            open={true}
            onClose={() => historyOpen = false}
            onSelectConversation={handleSelectConversation}
            onNewChat={handleNewChatFromSidebar}
            activeConversationId={chatView?.getConversationId() ?? null}
            inline={true}
          />
        </div>
        <div class="chat-main">
          <ChatView bind:this={chatView} onOpenInEditor={handleOpenInEditor} {projectRoot} />
        </div>
      </div>
      <div class="tab-panel" class:hidden={activeTab !== "editor"}>
        <EditorView bind:this={editorView} {projectRoot} {gitBranch} onOpenProject={openProject} />
      </div>
    </main>

    <!-- Bottom Bar -->
    {#if activeTab === "chat"}
      <footer class="bottom-bar">
        <button class="avatar-btn" onclick={() => settingsOpen = !settingsOpen} title="Settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="8" r="4"/><path d="M4 21v-1a4 4 0 014-4h8a4 4 0 014 4v1"/>
          </svg>
        </button>
        <ChatInput onSend={handleSend} />
      </footer>
    {:else}
      <footer class="bottom-bar minimal">
        <button class="avatar-btn" onclick={() => settingsOpen = !settingsOpen} title="Settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="8" r="4"/><path d="M4 21v-1a4 4 0 014-4h8a4 4 0 014 4v1"/>
          </svg>
        </button>
      </footer>
    {/if}

    {#if settingsOpen}
      <SettingsOverlay
        onClose={() => settingsOpen = false}
        user={user!}
        onLogout={() => { clearSessionToken(); user = null; settingsOpen = false; }}
      />
    {/if}

    {#if showOllamaSetup}
      <OllamaSetup onDismiss={() => showOllamaSetup = false} />
    {/if}

  </div>
{/if}

<style>
  /* #23: palette, radius, fonts and portal aliases now come from
     @edgecoder/tokens (packages/tokens) via src/app.css; names are unchanged. */
  :global(body) {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    background: var(--bg-deep);
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
    border-bottom: 0.5px solid var(--border);
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
    transform: scale(1.05);
  }
  .header-btn:active {
    transform: scale(0.95);
  }

  /* Content */
  .content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .tab-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tab-panel.hidden {
    display: none;
  }
  .chat-layout {
    flex-direction: row !important;
  }
  .chat-sidebar {
    width: 260px;
    flex-shrink: 0;
    border-right: 0.5px solid var(--border);
    overflow: hidden;
    transition: width 0.2s ease, opacity 0.2s ease;
  }
  .chat-sidebar.collapsed {
    width: 0;
    opacity: 0;
    pointer-events: none;
  }
  .chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }
  /* Bottom Bar */
  .bottom-bar {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    padding: 12px 16px;
    border-top: 0.5px solid var(--border);
    flex-shrink: 0;
  }
  .bottom-bar.minimal {
    padding: 8px 16px;
  }
  .avatar-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 0.5px solid var(--border-strong);
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

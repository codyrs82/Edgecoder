<script lang="ts">
  import { ensureNetworkEnrollment } from "./lib/network-enrollment";
  import TabSwitcher from "./components/TabSwitcher.svelte";
  import ChatInput from "./components/ChatInput.svelte";
  import ChatView from "./pages/ChatView.svelte";
  import EditorView from "./pages/EditorView.svelte";
  import { mentionSuggestions } from "./lib/mentions";
  import { isBuildRequest, setAutoApplyEdits } from "./lib/project-mode";
  import { tick } from "svelte";
  import SettingsOverlay from "./components/SettingsOverlay.svelte";
  import ConversationSidebar from "./components/ConversationSidebar.svelte";
  import LoginScreen from "./pages/LoginScreen.svelte";
  import OllamaSetup from "./components/OllamaSetup.svelte";
  import type { AuthUser } from "./lib/api";
  import { getMe, checkOllamaAvailable, clearSessionToken, ideSetProject, ideGetProject, backendReady, completeOAuthWithToken, fsFind, ideNewProject } from "./lib/api";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import EndpointBanner from "./components/EndpointBanner.svelte";
  import { startPeriodicCheck, stopPeriodicCheck } from "./lib/updater";
  import ComputePicker from "./components/ComputePicker.svelte";
  import { computeChoice } from "./lib/compute-choice";
  import { Settings as SettingsIcon } from "@lucide/svelte";

  let activeTab: "chat" | "editor" = $state("chat");
  let settingsOpen = $state(false);
  let settingsSection: string | undefined = $state(undefined);
  function openSettings(section?: string) {
    settingsSection = section;
    settingsOpen = true;
  }
  function logout() {
    clearSessionToken();
    user = null;
    settingsOpen = false;
  }
  let historyOpen = $state(true);
  let chatView: ChatView | undefined = $state(undefined);
  let editorView: EditorView | undefined = $state(undefined);

  let user: AuthUser | null = $state(null);
  let authChecked = $state(false);
  let showOllamaSetup = $state(false);

  /** IDE agent project state — shared across tabs */
  let projectRoot: string | null = $state(null);
  let chatStreaming = $state(false);

  $effect(() => {
    // Updates run whether or not anyone is signed in, so a broken sign-in can be fixed by an update.
    startPeriodicCheck();
    getMe()
      .then((u) => { user = u; })
      .catch(() => { user = null; })
      .finally(() => { authChecked = true; });
    return () => stopPeriodicCheck();
  });

  // Join this machine to the network once someone is signed in (no-op when already enrolled).
  $effect(() => {
    if (user) {
      ensureNetworkEnrollment(user).then((status) => {
        if (status.state === "error") console.warn("[network] enrollment failed:", status.message);
      });
    }
  });

  // Restore existing IDE project on startup
  $effect(() => {
    if (user) {
      backendReady.then(() => {
        ideGetProject().then(async (p) => {
          if (p) {
            projectRoot = p;
            return;
          }
          // The IDE server forgets the folder when the agent restarts; reopen the last one.
          let saved: string | null = null;
          try { saved = localStorage.getItem("edgecoder-project-root"); } catch { /* storage unavailable */ }
          if (saved) {
            try {
              await ideSetProject(saved);
              projectRoot = saved;
            } catch {
              // moved or deleted: forget it
              try { localStorage.removeItem("edgecoder-project-root"); } catch { /* ignore */ }
            }
          }
        });
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

  /** Show a project web page in the editor tab's preview. */
  function previewInEditor(path: string) {
    activeTab = "editor";
    setTimeout(() => void editorView?.openPreview(path), 50);
  }

  /** Show a project file in the editor tab. */
  function openInEditor(path: string) {
    activeTab = "editor";
    setTimeout(() => void editorView?.openPath(path), 50);
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
        await ideSetProject(selected);
        projectRoot = selected;
        try { localStorage.setItem("edgecoder-project-root", selected); } catch { /* storage unavailable */ }
      }
    } catch (err) {
      console.warn("Failed to open project dialog:", err);
    }
  }

  async function handleSend(message: string) {
    if (activeTab !== "chat" || !chatView) return;
    // Asked to build something with no folder open: start a project for it, like other coding
    // assistants do, and let the agent write the files there.
    if (!projectRoot && isBuildRequest(message)) {
      try {
        const root = await ideNewProject(message);
        projectRoot = root;
        try { localStorage.setItem("edgecoder-project-root", root); } catch { /* storage unavailable */ }
        // A fresh folder: apply the agent's edits as it goes (each reply stays undoable).
        setAutoApplyEdits(root, true);
        await tick();
        chatView.addNote(`Started a new project in \`${root.replace(/^\/Users\/[^/]+/, "~")}\`. The agent writes its files there; open the EdgeCoder tab to see and edit them.`);
      } catch (err) {
        console.warn("Couldn't create a project:", err);
      }
    }
    chatView.sendMessage(message);
  }
</script>

<EndpointBanner />

{#if !authChecked}
  <div class="loading-screen">
    <p>Loading...</p>
  </div>
{:else if !user}
  <LoginScreen onLogin={handleLogin} />
{:else}
  <div class="app-shell">
    {#if activeTab !== "chat"}<UpdateBanner />{/if}
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
      <button class="header-btn" title="Settings" aria-label="Settings" onclick={() => openSettings()}>
        <SettingsIcon size={17} strokeWidth={2} />
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
            user={user!}
            onOpenSettings={openSettings}
            onLogout={logout}
          />
        </div>
        <div class="chat-main">
          <ChatView bind:this={chatView} onOpenInEditor={handleOpenInEditor} {projectRoot} onStreamingChange={(v) => (chatStreaming = v)} onOpenPath={openInEditor} onPreview={previewInEditor} />
          <div class="composer">
            <ChatInput onSend={handleSend} streaming={chatStreaming} onStop={() => chatView?.stop()} mentions={projectRoot ? (q) => mentionSuggestions(q, (x) => fsFind(x, 8)) : undefined}>
              {#snippet toolbar()}
                <ComputePicker selected={$computeChoice} onSelect={(id) => computeChoice.set(id)} onOpenSettings={openSettings} />
              {/snippet}
            </ChatInput>
          </div>
        </div>
      </div>
      <div class="tab-panel" class:hidden={activeTab !== "editor"}>
        <EditorView bind:this={editorView} {projectRoot} onOpenProject={openProject} />
      </div>
    </main>

    {#if settingsOpen}
      <SettingsOverlay
        onClose={() => settingsOpen = false}
        user={user!}
        initialSection={settingsSection}
        onUserChange={(u) => (user = u)}
        onLogout={logout}
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
  /* Composer: the chat box under the conversation, centered like the messages */
  .composer {
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    padding: 8px 20px 16px;
  }
  .composer > :global(*) {
    width: 100%;
    max-width: 820px;
  }

  .loading-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
  }
</style>

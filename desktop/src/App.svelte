<script lang="ts">
  import { ensureNetworkEnrollment } from "./lib/network-enrollment";
  import TabSwitcher from "./components/TabSwitcher.svelte";
  import { menu } from "./lib/menu";
  import Toaster from "./components/ui/Toaster.svelte";
  import ChatInput from "./components/ChatInput.svelte";
  import ChatView from "./pages/ChatView.svelte";
  import EditorView from "./pages/EditorView.svelte";
  import { mentionSuggestions } from "./lib/mentions";
  import { isBuildRequest, setAutoApplyEdits } from "./lib/project-mode";
  import { tick } from "svelte";
  import SettingsOverlay from "./components/SettingsOverlay.svelte";
  import ConversationSidebar from "./components/ConversationSidebar.svelte";
  import LoginScreen from "./pages/LoginScreen.svelte";
  import LocalComputeSetup from "./components/LocalComputeSetup.svelte";
  import StarterModel from "./components/StarterModel.svelte";
  import { getLocalComputeStatus, needsSetupScreen, ollamaBaseFor, startLocalComputeSetup, type ComputeStatus } from "./lib/local-compute";
  import type { AuthUser } from "./lib/api";
  import { getMe, setOllamaBase, clearSessionToken, ideSetProject, ideGetProject, backendReady, completeOAuthWithToken, pendingOAuthVerifier, fsFind, ideNewProject } from "./lib/api";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import EndpointBanner from "./components/EndpointBanner.svelte";
  import { startPeriodicCheck, stopPeriodicCheck } from "./lib/updater";
  import ComputePicker from "./components/ComputePicker.svelte";
  import { computeChoice } from "./lib/compute-choice";
  import { Settings as SettingsIcon, Plus, SquarePen, FolderPlus, FolderOpen, FolderGit2, Bot, PanelLeft } from "@lucide/svelte";
  import type { RepoConnection } from "./lib/api";
  import BotView from "./pages/BotView.svelte";
  import BotForm from "./components/BotForm.svelte";
  import { bots, activeBotId, pollBots, refreshBots } from "./lib/bots-store";
  import type { Bot as BotRecord } from "./lib/bots";

  let activeTab = $state<"chat" | "editor">("chat");
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
  /** First-run local compute (Ollama + Docker sandbox) set up by the shell. */
  let computeStatus = $state<ComputeStatus | null>(null);
  /** State the user hid the screen in; it comes back if setup then fails. */
  let computeDismissedOn = $state<string | null>(null);
  /** Don't flash the setup screen when everything is already there (checks take < 1 s). */
  let computeGraceOver = $state(false);
  let computePolling = false;
  const showComputeSetup = $derived(
    computeDismissedOn !== computeStatus?.state && needsSetupScreen(computeStatus) && (computeGraceOver || computeStatus?.state === "error"),
  );

  function applyComputeStatus(s: ComputeStatus) {
    computeStatus = s;
    setOllamaBase(ollamaBaseFor(s));
    if (s.state !== "ready") void pollCompute();
  }

  async function pollCompute() {
    if (computePolling) return;
    computePolling = true;
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const s = await getLocalComputeStatus();
        if (!s) return;
        computeStatus = s;
        setOllamaBase(ollamaBaseFor(s));
        if (s.state === "ready" || s.state === "error") return;
      }
    } finally {
      computePolling = false;
    }
  }

  /** IDE agent project state — shared across tabs */
  let projectRoot = $state<string | null>(null);
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

  // The shell starts setup at launch; this (re)starts it if needed and follows its progress.
  // Outside the desktop shell (browser dev) there is nothing to set up.
  $effect(() => {
    if (!user) return;
    const t = setTimeout(() => { computeGraceOver = true; }, 800);
    startLocalComputeSetup().then((s) => { if (s) applyComputeStatus(s); });
    return () => clearTimeout(t);
  });

  // Handle deep-link callback when user is already logged in (e.g. GitHub OAuth)
  $effect(() => {
    if (!user) return;
    (window as any).__handleDeepLink = async (urlStr: string) => {
      // Only a callback for a sign-in or GitHub connect this app started.
      if (!pendingOAuthVerifier()) return;
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

  // Persistent bots: the sidebar lists them; one can be open in place of the chat.
  const activeBot = $derived($bots.find((b) => b.id === $activeBotId) ?? null);
  /** What the title bar names: the open chat (or bot) in Chat, the project in Code. */
  let chatHeader = $state<{ title: string; detail: string | null }>({ title: "New chat", detail: null });
  let editorBare = $state(true);
  let explorerOpen = $state(true);
  const projectName = $derived(projectRoot ? projectRoot.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? null : null);
  const titleText = $derived(
    activeTab === "editor" ? (projectName ?? "No folder open") : activeBot ? activeBot.name : chatHeader.title || "New chat",
  );
  const titleDetail = $derived(activeTab === "editor" ? null : activeBot ? activeBot.role || null : chatHeader.detail);
  $effect(() => {
    document.title = titleText ? `${titleText} · EdgeCoder` : "EdgeCoder";
  });
  /** The bot form: null closed, "new", or the bot being edited. */
  let botForm = $state<null | "new" | BotRecord>(null);
  $effect(() => {
    if (!user) return;
    let stop: (() => void) | undefined;
    backendReady.then(() => { stop = pollBots(); });
    return () => stop?.();
  });
  function openBot(id: string) {
    activeTab = "chat";
    activeBotId.set(id);
  }
  async function botSaved(b: BotRecord) {
    botForm = null;
    await refreshBots();
    openBot(b.id);
  }

  async function handleSelectConversation(id: string) {
    activeBotId.set(null);
    activeTab = "chat";
    if (chatView) {
      await chatView.loadConversation(id);
      // The chat remembers its project: reopen it (a connected repo or a folder).
      const root = chatView.getProjectRoot();
      if (root && root !== projectRoot) {
        try {
          await ideSetProject(root);
          adoptProject(root);
        } catch {
          // moved or deleted: keep the current project
        }
      }
    }
  }

  function handleNewChatFromSidebar() {
    activeBotId.set(null);
    activeTab = "chat";
    chatView?.newChat();
  }

  // The header's + : what you can create.
  let newMenuOpen = $state(false);
  let sidebarToggleLabel = $derived(
    activeTab === "chat" ? (historyOpen ? "Hide sidebar" : "Show sidebar") : explorerOpen ? "Hide files" : "Show files",
  );
  let newMenuTrigger: HTMLButtonElement | undefined = $state();
  function newChatHere() {
    newMenuOpen = false;
    activeBotId.set(null);
    activeTab = "chat";
    chatView?.newChat();
    queueMicrotask(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }
  async function newProjectHere() {
    newMenuOpen = false;
    try {
      const root = await ideNewProject("");
      projectRoot = root;
      try { localStorage.setItem("edgecoder-project-root", root); } catch { /* storage unavailable */ }
      setAutoApplyEdits(root, true);
      activeTab = "chat";
      chatView?.newChat();
      await tick();
      chatView?.addNote(`New project in \`${root.replace(/^\/Users\/[^/]+/, "~")}\`. Describe what to build; the agent writes the files there.`);
    } catch (err) {
      console.warn("Couldn't create a project:", err);
    }
  }

  // The + menu's "Connect repository…": a new chat with the cursor in its Connect field.
  async function connectRepoHere() {
    newChatHere();
    await tick();
    chatView?.focusConnect();
  }

  /** A repository connected from a new chat or the EdgeCoder tab: open it and say what happened. */
  async function repoConnected(r: RepoConnection) {
    adoptProject(r.path);
    await tick();
    const where = r.path.replace(/^\/Users\/[^/]+/, "~");
    const state = r.dirty ? " It has local changes, so nothing was pulled." : r.behind > 0 ? ` It is ${r.behind} commit${r.behind === 1 ? "" : "s"} behind.` : "";
    chatView?.addNote(`${r.action === "cloned" ? "Cloned" : "Opened"} **${r.name}**${r.branch ? ` on \`${r.branch}\`` : ""} in \`${where}\`.${r.action === "updated" && r.fastForwarded ? " Pulled the latest commits." : ""}${state} Ask about the code or what to change.`);
  }

  /** A folder the IDE server already made the open project (a clone from Source Control). */
  function adoptProject(root: string) {
    projectRoot = root;
    try { localStorage.setItem("edgecoder-project-root", root); } catch { /* storage unavailable */ }
  }

  /** Open a folder (a bot's home folder) as the editor's project. */
  async function openFolderInEditor(root: string) {
    try {
      await ideSetProject(root);
      adoptProject(root);
      activeTab = "editor";
    } catch (err) {
      console.warn("Failed to open folder:", err);
    }
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
        chatView.addNote(`Started a new project in \`${root.replace(/^\/Users\/[^/]+/, "~")}\`. The agent writes its files there; open the Code view to see and edit them.`);
      } catch (err) {
        console.warn("Couldn't create a project:", err);
      }
    }
    chatView.sendMessage(message);
  }
</script>

<EndpointBanner />
<Toaster />

{#if !authChecked}
  <div class="loading-screen">
    <p>Loading...</p>
  </div>
{:else if !user}
  <LoginScreen onLogin={handleLogin} />
{:else}
  <div class="app-shell">
    {#if activeTab !== "chat"}<UpdateBanner />{/if}
    <!-- Title bar: drawn by the page (macOS overlay title bar leaves room for the traffic lights). -->
    <header class="titlebar" data-tauri-drag-region>
      <div class="tb-side" data-tauri-drag-region>
        <button class="icon-btn" title={sidebarToggleLabel} aria-label={sidebarToggleLabel} aria-pressed={activeTab === "chat" ? historyOpen : explorerOpen}
          disabled={activeTab === "editor" && editorBare}
          onclick={() => {
            if (activeTab === "chat") historyOpen = !historyOpen;
            else explorerOpen = !explorerOpen;
          }}>
          <PanelLeft size={16} />
        </button>
        <div class="new-menu-wrap">
          <button bind:this={newMenuTrigger} class="icon-btn" title="New" aria-label="New" aria-haspopup="menu" aria-expanded={newMenuOpen} onclick={() => (newMenuOpen = !newMenuOpen)}>
            <Plus size={16} />
          </button>
          {#if newMenuOpen}
            <!-- The same keyboard menu as the conversation list (#161): arrows, Home/End, Escape, click away. -->
            <div class="new-menu" role="menu" aria-label="New" tabindex="-1"
              use:menu={{ trigger: newMenuTrigger, onClose: (returnFocus) => { newMenuOpen = false; if (returnFocus) newMenuTrigger?.focus(); } }}>
              <button role="menuitem" onclick={newChatHere}><SquarePen size={15} /> New chat</button>
              <button role="menuitem" onclick={newProjectHere}><FolderPlus size={15} /> New project</button>
              <button role="menuitem" onclick={connectRepoHere} title="Clone or update a repository in your projects folder"><FolderGit2 size={15} /> Connect repository…</button>
              <button role="menuitem" onclick={() => { newMenuOpen = false; void openProject(); activeTab = "editor"; }}><FolderOpen size={15} /> Open folder…</button>
              <button role="menuitem" onclick={() => { newMenuOpen = false; botForm = "new"; }} title="A named bot that owns a job in a project, on Auto compute"><Bot size={15} /> New bot</button>
            </div>
          {/if}
        </div>
        <TabSwitcher {activeTab} onSwitch={(tab) => activeTab = tab} />
      </div>

      <div class="tb-title" data-tauri-drag-region title={activeTab === "editor" && projectRoot ? projectRoot : titleText}>
        <span class="tb-name" data-tauri-drag-region>{titleText}</span>
        {#if titleDetail}<span class="tb-detail" data-tauri-drag-region>{titleDetail}</span>{/if}
      </div>

      <div class="tb-side tb-right" data-tauri-drag-region>
        <button class="icon-btn" title="Settings" aria-label="Settings" onclick={() => openSettings()}>
          <SettingsIcon size={16} />
        </button>
      </div>
    </header>

    <!-- Main Content Area — both views stay mounted, hidden via CSS -->
    <main class="content">
      <div class="tab-panel chat-layout" class:hidden={activeTab !== "chat"} role="tabpanel" id="view-chat" aria-labelledby="view-tab-chat">
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
            onSelectBot={openBot}
            onNewBot={() => (botForm = "new")}
            activeBotId={$activeBotId}
          />
        </div>
        {#if activeBot}
          <div class="chat-main">
            <BotView bot={activeBot} onEdit={(b) => (botForm = b)} onDeleted={() => { activeBotId.set(null); void refreshBots(); }} onOpenPath={openInEditor} onPreview={previewInEditor} onOpenSettings={openSettings} onOpenFolder={openFolderInEditor} />
          </div>
        {/if}
        <div class="chat-main" class:hidden={!!activeBot}>
          <ChatView bind:this={chatView} onHeaderChange={(h) => (chatHeader = h)} onOpenInEditor={handleOpenInEditor} {projectRoot} onRepoConnected={(r) => void repoConnected(r)} onStreamingChange={(v) => (chatStreaming = v)} onOpenPath={openInEditor} onPreview={previewInEditor} />
          <div class="composer">
            <ChatInput onSend={handleSend} streaming={chatStreaming} onStop={() => chatView?.stop()} mentions={projectRoot ? (q) => mentionSuggestions(q, (x) => fsFind(x, 8)) : undefined}>
              {#snippet toolbar()}
                <ComputePicker selected={$computeChoice} onSelect={(id) => computeChoice.set(id)} onOpenSettings={openSettings} />
              {/snippet}
            </ChatInput>
          </div>
        </div>
      </div>
      <div class="tab-panel" class:hidden={activeTab !== "editor"} role="tabpanel" id="view-editor" aria-labelledby="view-tab-editor">
        <EditorView bind:this={editorView} {projectRoot} {explorerOpen} onBareChange={(b) => (editorBare = b)} onOpenProject={openProject} onProjectOpened={adoptProject} onRepoConnected={(r) => void repoConnected(r)} />
      </div>
    </main>

    {#if botForm}
      <BotForm bot={botForm === "new" ? null : botForm} defaultProject={projectRoot} onClose={() => (botForm = null)} onSaved={botSaved} />
    {/if}

    {#if settingsOpen}
      <SettingsOverlay
        onClose={() => settingsOpen = false}
        user={user!}
        initialSection={settingsSection}
        onUserChange={(u) => (user = u)}
        onLogout={logout}
      />
    {/if}

    <!-- First run: one small model downloads by itself once Ollama answers (skippable). -->
    <StarterModel ollamaBase={import.meta.env.DEV ? "/ollama" : ollamaBaseFor(computeStatus)} onOpenModels={() => openSettings("models")} />

    {#if showComputeSetup && computeStatus}
      <LocalComputeSetup
        status={computeStatus}
        onStatus={applyComputeStatus}
        onDismiss={() => computeDismissedOn = computeStatus?.state ?? null}
      />
    {/if}

  </div>
{/if}

<style>
  /* #23: palette, radius, fonts and portal aliases now come from
     @edgecoder/tokens (packages/tokens) via src/app.css; names are unchanged. */
  :global(body) {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--fs-base);
    line-height: var(--lh-ui);
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

  /* Title bar: 44 px, icon buttons on the sides, the open chat or project in the middle. */
  .titlebar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, auto) minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    height: 44px;
    padding: 0 8px 0 10px;
    border-bottom: 0.5px solid var(--border);
    background: var(--bg-deep);
    flex-shrink: 0;
    -webkit-app-region: drag;
    user-select: none;
  }
  /* The macOS traffic lights sit at the left of the bar (tauri.conf.json trafficLightPosition). */
  :global(html[data-titlebar="overlay"]) .titlebar {
    padding-left: 80px;
  }
  .tb-side {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .tb-right {
    justify-content: flex-end;
  }
  .tb-side :global(button), .tb-side :global([role="tablist"]) {
    -webkit-app-region: no-drag;
  }
  .tb-side > :global(.view-switch) {
    margin-left: 6px;
  }
  .tb-title {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 8px;
    min-width: 0;
    font-size: var(--fs-sm);
    line-height: 1;
  }
  .tb-name {
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tb-detail {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    width: 264px;
    background: var(--bg-deep);
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
  .chat-main.hidden {
    display: none;
  }
  /* Composer: the chat box under the conversation, centered like the messages */
  .composer {
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    padding: 4px 24px 16px;
  }
  .composer > :global(*) {
    width: 100%;
    max-width: 760px;
  }

  .loading-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
  }
  .new-menu-wrap {
    position: relative;
  }
  .new-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 61;
    min-width: 200px;
    padding: 6px;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .new-menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: 8px;
    background: none;
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .new-menu button:hover:not(:disabled) {
    background: var(--bg-surface);
  }
  .new-menu button:disabled {
    color: var(--text-secondary);
    cursor: default;
  }
</style>

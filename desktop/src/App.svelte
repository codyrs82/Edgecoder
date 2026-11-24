<script lang="ts">
  import { NO_VISION, visionFor, type AttachmentPayload } from "./lib/attachments";
  import { ensureNetworkEnrollment } from "./lib/network-enrollment";
  import { openWalletRequest } from "./lib/buy-csats";
  import TabSwitcher from "./components/TabSwitcher.svelte";
  import { viewSwitchSpot, type View } from "./lib/view-switch";
  import { menu } from "./lib/menu";
  import Toaster from "./components/ui/Toaster.svelte";
  import ChatInput from "./components/ChatInput.svelte";
  import ChatView from "./pages/ChatView.svelte";
  import EditorView from "./pages/EditorView.svelte";
  import { mentionSuggestions } from "./lib/mentions";
  import { isBuildRequest, setAutoApplyEdits } from "./lib/project-mode";
  import PermissionModePicker from "./components/PermissionModePicker.svelte";
  import { defaultMode as defaultPermissionMode, type EngineMode } from "./lib/permission-modes";
  import { tick } from "svelte";
  import SettingsOverlay from "./components/SettingsOverlay.svelte";
  import ConversationSidebar from "./components/ConversationSidebar.svelte";
  import LoginScreen from "./pages/LoginScreen.svelte";
  import LocalComputeSetup from "./components/LocalComputeSetup.svelte";
  import StarterModel from "./components/StarterModel.svelte";
  import { getLocalComputeStatus, needsSetupScreen, ollamaBaseFor, startLocalComputeSetup, type ComputeStatus } from "./lib/local-compute";
  import type { AuthUser } from "./lib/api";
  import { getMe, setOllamaBase, clearSessionToken, ideSetProject, ideGetProject, backendReady, completeOAuthWithToken, pendingOAuthVerifier, fsFind, ideNewProject, isRemoteMode } from "./lib/api";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import EndpointBanner from "./components/EndpointBanner.svelte";
  import { startPeriodicCheck, stopPeriodicCheck } from "./lib/updater";
  import UpdateCountdown from "./components/UpdateCountdown.svelte";
  import { autoRestart, startAutoRestart } from "./lib/auto-restart-app";
  import { setBusy, takeUpdatedTo } from "./lib/auto-restart";
  import ComputePicker from "./components/ComputePicker.svelte";
  import ContextMeter from "./components/ContextMeter.svelte";
  import WebIndicator from "./components/WebIndicator.svelte";
  import { getWebStatus } from "./lib/api";
  import { chatWebMode, webAutoStore, type WebStatus } from "./lib/web-tool";
  import { computeChoice } from "./lib/compute-choice";
  import { Settings as SettingsIcon, Plus, SquarePen, FolderPlus, FolderOpen, FolderGit2, Folder, Bot, PanelLeft } from "@lucide/svelte";
  import ProjectSidebar from "./components/ProjectSidebar.svelte";
  import LiveSessionPanel from "./components/LiveSessionPanel.svelte";
  import { listPublishedSessions, type SessionSummary } from "./lib/api";
  import NewProjectDialog from "./components/NewProjectDialog.svelte";
  import { forgetProject, loadRecentProjects, projectName as folderName, rememberProject, tildePath, type CreatedProject, type RecentProject } from "./lib/projects";
  import { notify } from "./lib/toast";
  import type { Conversation } from "./lib/types";
  import type { RepoConnection } from "./lib/api";
  import BotView from "./pages/BotView.svelte";
  import CloudBotView from "./pages/CloudBotView.svelte";
  import BotForm from "./components/BotForm.svelte";
  import { bots, activeBotId, pollBots, refreshBots, cloudBots, activeCloudBotId } from "./lib/bots-store";
  import type { Bot as BotRecord } from "./lib/bots";
  import OnboardingWizard from "./components/OnboardingWizard.svelte";
  import { stepFromRoute, type StepId } from "./lib/onboarding";
  import { guideToOpen } from "./lib/onboarding-launch";
  import { getOnboarding, saveOnboarding } from "./lib/api";
  import { probeLocalService, restartLocalService, serviceCameBack } from "./lib/api";
  import { inDesktopShell, startServiceMonitor, stopServiceMonitor } from "./lib/service-status";
  import { startConnectivity } from "./lib/connectivity-app";
  import { connectivity } from "./lib/connectivity";
  import OfflineBar from "./components/OfflineBar.svelte";

  let activeTab = $state<"chat" | "editor">("chat");
  let settingsOpen = $state(false);
  let settingsSection: string | undefined = $state(undefined);
  // A Buy cSats button anywhere (a failure banner, a chat notice, the balance): the Wallet page.
  $effect(() => openWalletRequest.subscribe((n) => { if (n) openSettings("plan"); }));
  function openSettings(section?: string) {
    if (section === "guide") return openGuide();
    settingsSection = section;
    settingsOpen = true;
  }
  function logout() {
    clearSessionToken();
    user = null;
    settingsOpen = false;
  }
  // Getting started (components/OnboardingWizard.svelte): opens by itself on first sign-in (the
  // portal says when), from #/welcome/<step>, from Settings → Getting started and the profile menu.
  let guideOpen = $state(false);
  let guideStep = $state<StepId | null>(null);
  /** Asked to open by itself; waits until the first-run local setup screen is gone. */
  let guidePending = $state<StepId | "saved" | null>(null);
  function openGuide(step: StepId | null = null) {
    settingsOpen = false;
    guideStep = step;
    guideOpen = true;
  }
  $effect(() => {
    if (!user) return;
    let ended = false;
    backendReady.then(async () => {
      const open = await guideToOpen(location.hash, getOnboarding);
      if (!ended && open) guidePending = open;
    });
    const onHash = () => {
      const id = stepFromRoute(location.hash);
      if (id && !guideOpen) openGuide(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      ended = true;
      window.removeEventListener("hashchange", onHash);
    };
  });
  $effect(() => {
    if (guidePending && !showComputeSetup && !guideOpen) {
      const step = guidePending === "saved" ? null : guidePending;
      guidePending = null;
      openGuide(step);
    }
  });
  // The guide's "first task": the first chat reply that finishes after sign-in is reported once.
  let sawStreaming = false;
  let firstTaskSent = false;
  $effect(() => {
    if (chatStreaming) sawStreaming = true;
    else if (sawStreaming && user && !firstTaskSent) {
      firstTaskSent = true;
      void saveOnboarding({ firstTask: true }).catch(() => (firstTaskSent = false));
    }
  });
  const TRY_PROMPT = "In three short bullet points, what can EdgeCoder do for me?";
  async function runGuideAction(action: string) {
    if (action === "try-chat") {
      closeBots();
      activeTab = "chat";
      chatView?.newChat();
      await tick();
      void handleSend(TRY_PROMPT);
    } else if (action === "open-code") {
      activeTab = "editor";
    } else if (action === "new-bot") {
      activeTab = "chat";
      botForm = "new";
    }
  }

  let historyOpen = $state(true);
  let chatView: ChatView | undefined = $state(undefined);
  /** The Chat view's context meter (compaction.ts); null for a portal chat. */
  let chatContext = $state<{ tokens: number; compacting: boolean; note: string | null } | null>(null);
  /** The Chat view's permission mode (its picker sits in this page's composer). */
  let chatPermissionMode = $state<EngineMode>(defaultPermissionMode());
  let chatInput: ChatInput | undefined = $state(undefined);
  /**
   * The Chat view's web (docs/web-tool.md): the chat's own choice (true Auto, false Off, unset the
   * Settings default) and whether it can be used for the chosen model.
   */
  let chatWeb = $state<boolean | undefined>(undefined);
  const chatWebModeNow = $derived(chatWebMode(chatWeb, $webAutoStore));
  let webStatus = $state<WebStatus | null>(null);
  /** Bumped after a reply used the web or was turned down for it (the balance changed): look again. */
  let webRecheck = $state(0);
  $effect(() => {
    const model = $computeChoice;
    void webRecheck;
    let gone = false;
    const check = () => backendReady.then(() => getWebStatus(model)).then((s) => { if (!gone) webStatus = s; });
    void check();
    // Balance and set-up change while the app is open: look again now and then.
    const timer = setInterval(() => void check(), 5 * 60_000);
    return () => { gone = true; clearInterval(timer); };
  });
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
    const stopAutoRestart = startAutoRestart();
    // The desktop app owns its local service: watch it, so pages say "Starting…" and wait for it
    // instead of asking whether it runs (lib/service-status.ts; the shell restarts it by itself).
    if (inDesktopShell()) startServiceMonitor({ probe: probeLocalService, restart: restartLocalService, onReady: serviceCameBack });
    // Offline mode: a calm bar, network-only bots pause, "Back online" on reconnect (lib/connectivity.ts).
    const stopConnectivity = startConnectivity();
    void import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then((v) => {
      const updated = takeUpdatedTo(v);
      if (updated) notify(`Updated to EdgeCoder ${updated}`, "success", "updated-to");
    }).catch(() => {});
    getMe()
      .then((u) => { user = u; })
      .catch(() => { user = null; })
      .finally(() => { authChecked = true; });
    return () => { stopPeriodicCheck(); stopAutoRestart(); stopServiceMonitor(); stopConnectivity(); };
  });

  // Auto-restart waits for these (lib/auto-restart.ts).
  $effect(() => setBusy("app:chat-stream", chatStreaming && "streaming"));
  $effect(() => setBusy("app:local-compute-install", needsSetupScreen(computeStatus) && computeStatus?.state !== "error" && "install"));

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
            adoptProject(p);
            return;
          }
          // The IDE server forgets the folder when the agent restarts; reopen the last one.
          let saved: string | null = null;
          try { saved = localStorage.getItem("edgecoder-project-root"); } catch { /* storage unavailable */ }
          if (saved) {
            try {
              await ideSetProject(saved);
              adoptProject(saved);
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
  /** A cloud bot open in place of the chat (read and message only here). */
  const activeCloudBot = $derived($cloudBots.find((b) => b.id === $activeCloudBotId) ?? null);
  function closeBots() {
    activeBotId.set(null);
    activeCloudBotId.set(null);
  }
  function openCloudBot(id: string) {
    activeTab = "chat";
    activeBotId.set(null);
    activeCloudBotId.set(id);
  }
  /** What the title bar names: the open chat (or bot) in Chat, the project in Code. */
  let chatHeader = $state<{ title: string; detail: string | null }>({ title: "New chat", detail: null });
  /** The Code view's projects sidebar. */
  let codeSidebarOpen = $state(readFlag("edgecoder-code-sidebar", true));
  function readFlag(key: string, fallback: boolean): boolean {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === "true";
    } catch {
      return fallback;
    }
  }
  /** The coding chat showing (the projects sidebar highlights it). */
  let editorChatId = $state<string | null>(null);
  /** The New project sheet: closed, new, or on "Clone from GitHub". */
  let newProjectSheet = $state<null | "new" | "clone">(null);
  const projectName = $derived(projectRoot ? projectRoot.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? null : null);
  const titleText = $derived(
    activeTab === "editor" ? (projectName ?? "No project open") : activeBot ? activeBot.name : activeCloudBot ? activeCloudBot.name : chatHeader.title || "New chat",
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
    let ended = false;
    // A sign-in change before the backend was ready must not leave a poller running (they stacked).
    backendReady.then(() => { if (!ended) stop = pollBots(); });
    return () => {
      ended = true;
      stop?.();
    };
  });
  function openBot(id: string) {
    activeTab = "chat";
    activeCloudBotId.set(null);
    activeBotId.set(id);
  }
  async function botSaved(b: BotRecord) {
    botForm = null;
    await refreshBots();
    openBot(b.id);
  }

  async function handleSelectConversation(id: string) {
    closeBots();
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
    closeBots();
    activeTab = "chat";
    chatView?.newChat();
  }

  // The header's + : what you can create.
  let newMenuOpen = $state(false);
  // The Chat / Code switch sits above New chat in the open sidebar, in the title bar while it's hidden.
  let switchSpot = $derived(viewSwitchSpot(activeTab, historyOpen, codeSidebarOpen));
  function switchView(tab: View) {
    // The switch moves to the other view's sidebar; keep keyboard focus on it.
    const hadFocus = !!(document.activeElement as HTMLElement | null)?.closest?.(".view-switch");
    activeTab = tab;
    if (hadFocus) void tick().then(() => document.getElementById(`view-tab-${tab}`)?.focus());
  }
  let sidebarToggleLabel = $derived((activeTab === "chat" ? historyOpen : codeSidebarOpen) ? "Hide sidebar" : "Show sidebar");
  /** Recent projects for the + menu, read when it opens. */
  let recentForMenu = $state<RecentProject[]>([]);
  let newMenuTrigger: HTMLButtonElement | undefined = $state();
  function newChatHere() {
    newMenuOpen = false;
    if (activeTab === "editor") {
      void newCodingChat(null);
      return;
    }
    closeBots();
    activeTab = "chat";
    chatView?.newChat();
    queueMicrotask(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }

  // --- Projects (the Code view) -----------------------------------------------------------------

  /** Open a project folder: the IDE server works in it and the coding chat follows it. */
  async function openProjectRoot(root: string): Promise<boolean> {
    if (root === projectRoot) return true;
    try {
      await ideSetProject(root);
      adoptProject(root);
      return true;
    } catch (err) {
      notify(`Couldn't open ${tildePath(root)}: ${(err as Error).message}. It may have been moved or deleted.`, "error");
      forgetProject(root);
      return false;
    }
  }

  /** A new coding chat in `root` (null: the open project). */
  // Sessions published from a terminal (`edgecoder code`, /remote): listed live in the Code view.
  let liveSessions = $state<SessionSummary[]>([]);
  let liveSessionId = $state<string | null>(null);
  $effect(() => {
    if (!user) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        liveSessions = await listPublishedSessions();
      } catch {
        // an older provider without sessions, or not running yet
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    backendReady.then(() => { if (!stopped) void poll(); });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  async function openLiveSession(x: SessionSummary) {
    activeTab = "editor";
    if (x.projectRoot !== projectRoot) await openProjectRoot(x.projectRoot);
    liveSessionId = x.id;
  }

  async function newCodingChat(root: string | null) {
    liveSessionId = null;
    activeTab = "editor";
    if (root && !(await openProjectRoot(root))) return;
    await tick();
    await editorView?.newChat();
    queueMicrotask(() => document.querySelector<HTMLTextAreaElement>("#view-editor .panel-input textarea")?.focus());
  }

  async function openCodingChat(c: Conversation) {
    liveSessionId = null;
    activeTab = "editor";
    if (c.projectRoot) {
      if (!(await openProjectRoot(c.projectRoot))) return;
    } else {
      // A chat from before chats had projects: shown on its own, with the prompt to link it.
      projectRoot = null;
    }
    await tick();
    await editorView?.openChat(c.id);
  }

  function startNewProject(mode: "new" | "clone") {
    newMenuOpen = false;
    newProjectSheet = mode;
  }

  /** The New project sheet finished: the project is open; start a chat in it and say what happened. */
  async function projectCreated(p: CreatedProject) {
    newProjectSheet = null;
    adoptProject(p.root);
    activeTab = "editor";
    await tick();
    await editorView?.newChat();
    await editorView?.addNote(`${p.summary} Describe what to build or change; the agent works in this folder.`);
    if (p.warning) notify(p.warning, "error");
  }

  async function openRecent(root: string) {
    newMenuOpen = false;
    activeTab = "editor";
    await openProjectRoot(root);
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
    rememberProject(root);
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
        adoptProject(selected);
        activeTab = "editor";
      }
    } catch (err) {
      console.warn("Failed to open project dialog:", err);
    }
  }

  async function handleSend(message: string, attachments?: AttachmentPayload[]) {
    if (activeTab !== "chat" || !chatView) return;
    // Asked to build something with no folder open: start a project for it, like other coding
    // assistants do, and let the agent write the files there.
    if (!projectRoot && isBuildRequest(message)) {
      try {
        const root = await ideNewProject(message);
        adoptProject(root);
        // A fresh folder: apply the agent's edits as it goes (each reply stays undoable).
        setAutoApplyEdits(root, true);
        await tick();
        chatView.addNote(`Started a new project in \`${root.replace(/^\/Users\/[^/]+/, "~")}\`. The agent writes its files there; open the Code view to see and edit them.`);
      } catch (err) {
        console.warn("Couldn't create a project:", err);
      }
    }
    chatView.sendMessage(message, attachments);
  }
</script>

<!-- Offline is a mode, not an error: the calm bar replaces the red "unreachable" banner. -->
{#if $connectivity.state === "offline"}<OfflineBar />{:else}<EndpointBanner />{/if}
<Toaster />
<UpdateCountdown controller={autoRestart} />

{#if !authChecked}
  <div class="loading-screen">
    <p>Loading...</p>
  </div>
{:else if !user}
  <LoginScreen onLogin={handleLogin} />
{:else}
  <div class="app-shell">
    {#if activeTab !== "chat"}<UpdateBanner />{/if}
    {#snippet viewSwitch()}
      <div class="sidebar-switch"><TabSwitcher {activeTab} onSwitch={switchView} /></div>
    {/snippet}
    <!-- Title bar: drawn by the page (macOS overlay title bar leaves room for the traffic lights). -->
    <header class="titlebar" data-tauri-drag-region>
      <div class="tb-side" data-tauri-drag-region>
        <button class="icon-btn" title={sidebarToggleLabel} aria-label={sidebarToggleLabel} aria-pressed={activeTab === "chat" ? historyOpen : codeSidebarOpen}
          onclick={() => {
            if (activeTab === "chat") historyOpen = !historyOpen;
            else {
              codeSidebarOpen = !codeSidebarOpen;
              try { localStorage.setItem("edgecoder-code-sidebar", String(codeSidebarOpen)); } catch { /* storage unavailable */ }
            }
          }}>
          <PanelLeft size={16} />
        </button>
        <div class="new-menu-wrap">
          <button bind:this={newMenuTrigger} class="icon-btn" title="New" aria-label="New" aria-haspopup="menu" aria-expanded={newMenuOpen} onclick={() => { recentForMenu = loadRecentProjects().slice(0, 5); newMenuOpen = !newMenuOpen; }}>
            <Plus size={16} />
          </button>
          {#if newMenuOpen}
            <!-- The same keyboard menu as the conversation list (#161): arrows, Home/End, Escape, click away. -->
            <div class="new-menu" role="menu" aria-label="New" tabindex="-1"
              use:menu={{ trigger: newMenuTrigger, onClose: (returnFocus) => { newMenuOpen = false; if (returnFocus) newMenuTrigger?.focus(); } }}>
              <button role="menuitem" onclick={newChatHere} title={activeTab === "editor" ? (projectName ? `A new chat in ${projectName}` : "Pick a project first") : "A new chat"}><SquarePen size={15} /> New chat{#if activeTab === "editor" && projectName}<span class="menu-hint">in {projectName}</span>{/if}</button>
              <button role="menuitem" onclick={() => startNewProject("new")}><FolderPlus size={15} /> New project…</button>
              <button role="menuitem" onclick={() => startNewProject("clone")} title="Clone a repository into your projects folder, or update the copy there"><FolderGit2 size={15} /> Clone from GitHub…</button>
              <button role="menuitem" onclick={() => { newMenuOpen = false; void openProject(); }}><FolderOpen size={15} /> Open folder…</button>
              {#if recentForMenu.length > 0}
                <div class="menu-label" role="presentation">Open recent</div>
                {#each recentForMenu as r (r.root)}
                  <button role="menuitem" title={tildePath(r.root)} onclick={() => void openRecent(r.root)}><Folder size={15} /> <span class="menu-text">{folderName(r.root)}</span></button>
                {/each}
                <div class="menu-sep" role="separator"></div>
              {/if}
              <button role="menuitem" onclick={() => { newMenuOpen = false; botForm = "new"; }} title="A named bot that owns a job in a project, on Auto compute"><Bot size={15} /> New bot</button>
            </div>
          {/if}
        </div>
        {#if switchSpot === "titlebar"}<TabSwitcher {activeTab} onSwitch={switchView} />{/if}
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
            onSelectCloudBot={openCloudBot}
            activeCloudBotId={$activeCloudBotId}
            top={switchSpot === "chat-sidebar" ? viewSwitch : undefined}
          />
        </div>
        {#if activeBot}
          <div class="chat-main">
            <BotView bot={activeBot} onEdit={(b) => (botForm = b)} onDeleted={() => { closeBots(); void refreshBots(); }} onOpenPath={openInEditor} onPreview={previewInEditor} onOpenSettings={openSettings} onOpenFolder={openFolderInEditor} />
          </div>
        {:else if activeCloudBot}
          <div class="chat-main">
            <CloudBotView bot={activeCloudBot} />
          </div>
        {/if}
        <div class="chat-main" class:hidden={!!activeBot || !!activeCloudBot}>
          <ChatView bind:this={chatView} {webStatus} onWebChange={(choice) => (chatWeb = choice)} onWebStale={() => webRecheck++} onModeChange={(m) => (chatPermissionMode = m)} onFocusComposer={() => chatInput?.focus()} onHeaderChange={(h) => (chatHeader = h)} onOpenInEditor={handleOpenInEditor} {projectRoot} onRepoConnected={(r) => void repoConnected(r)} onStreamingChange={(v) => (chatStreaming = v)} onOpenPath={openInEditor} onPreview={previewInEditor} onQuote={(b) => void chatInput?.insertQuote(b)} onContextChange={(c) => (chatContext = c)} />
          <div class="composer">
            <ChatInput bind:this={chatInput} onSend={handleSend} streaming={chatStreaming} onStop={() => chatView?.stop()} attach={{ vision: projectRoot ? visionFor($computeChoice) : NO_VISION, who: "This model" }} mentions={projectRoot ? (q) => mentionSuggestions(q, (x) => fsFind(x, 8)) : undefined}>
              {#snippet controls()}
                <ComputePicker selected={$computeChoice} onSelect={(id) => computeChoice.set(id)} onOpenSettings={openSettings} />
                {#if chatContext}<ContextMeter tokens={chatContext.tokens} busy={chatContext.compacting} note={chatContext.note} disabled={chatStreaming} onCompact={() => chatView?.compactConversation()} />{/if}
                <WebIndicator status={webStatus} mode={chatWebModeNow} onChange={(m) => { chatWeb = m === "auto"; chatView?.setWeb(m === "auto"); }} />
                {#if projectRoot && !isRemoteMode()}
                  <PermissionModePicker mode={chatPermissionMode} onChange={(m) => { chatPermissionMode = m; chatView?.setMode(m); }} allowFull project={projectRoot} />
                {/if}
              {/snippet}
            </ChatInput>
          </div>
        </div>
      </div>
      <div class="tab-panel chat-layout" class:hidden={activeTab !== "editor"} role="tabpanel" id="view-editor" aria-labelledby="view-tab-editor">
        <div class="chat-sidebar" class:collapsed={!codeSidebarOpen}>
          <ProjectSidebar
            currentProject={projectRoot}
            activeChatId={editorChatId}
            onOpenProject={(root) => void openProjectRoot(root)}
            onSelectChat={(c) => void openCodingChat(c)}
            onNewChat={(root) => void newCodingChat(root)}
            onNewProject={() => startNewProject("new")}
            onClone={() => startNewProject("clone")}
            onOpenFolder={() => void openProject()}
            user={user!}
            onOpenSettings={openSettings}
            onLogout={logout}
            {liveSessions}
            activeSessionId={liveSessionId}
            onSelectSession={(x) => void openLiveSession(x)}
            top={switchSpot === "code-sidebar" ? viewSwitch : undefined}
          />
        </div>
        {#if liveSessionId}
          <div class="chat-main">
            {#key liveSessionId}
              <LiveSessionPanel sessionId={liveSessionId} onFilesChanged={() => editorView?.onAgentChangedFiles()} onOpenPath={(p) => { liveSessionId = null; openInEditor(p); }} />
            {/key}
          </div>
        {/if}
        <div class="chat-main" class:hidden={!!liveSessionId}>
          <EditorView
            bind:this={editorView}
            {projectRoot}
            onOpenProject={openProject}
            onProjectOpened={adoptProject}
            onPickProject={(root) => void openProjectRoot(root)}
            onNewProject={() => startNewProject("new")}
            onClone={() => startNewProject("clone")}
            onConnectGitHub={() => openSettings("integrations")}
            onConversationChange={(id) => (editorChatId = id)}
          />
        </div>
      </div>
    </main>

    {#if newProjectSheet}
      <NewProjectDialog mode={newProjectSheet} onClose={() => (newProjectSheet = null)} onCreated={(p) => void projectCreated(p)} onConnectGitHub={() => { newProjectSheet = null; openSettings("integrations"); }} />
    {/if}

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
        onOpenGuide={() => openGuide()}
      />
    {/if}

    {#if guideOpen}
      <OnboardingWizard
        initialStep={guideStep}
        onClose={() => (guideOpen = false)}
        onOpenSettings={(s) => openSettings(s)}
        onRun={(a) => void runGuideAction(a)}
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
  /* The switch at the top of the open sidebar, above New chat: two equal halves. */
  .sidebar-switch {
    padding: 8px 8px 0;
  }
  .sidebar-switch :global(.view-switch) {
    width: 100%;
  }
  .sidebar-switch :global(.view-switch .tab) {
    flex: 1 1 0;
    justify-content: center;
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
  .new-menu .menu-hint {
    margin-left: auto;
    padding-left: 12px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new-menu .menu-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-label {
    padding: 8px 10px 4px;
    font-size: var(--fs-2xs);
    color: var(--text-muted);
  }
  .menu-sep {
    height: 0.5px;
    margin: 4px 6px;
    background: var(--border);
  }
</style>

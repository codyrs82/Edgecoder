<script lang="ts">
  import { NO_VISION, attachmentLabel, attachmentsText, visionFor, type AttachmentPayload } from "../lib/attachments";
  import { ChevronDown, Plus, PanelRight } from "@lucide/svelte";
  import { setBusy as setRestartBusy, clearBusy as clearRestartBusy } from "../lib/auto-restart";
  import { menu } from "../lib/menu";
  import { onMount, onDestroy, untrack } from "svelte";
  import ChatProjectHeader from "./ChatProjectHeader.svelte";
  import NoProjectPrompt from "./NoProjectPrompt.svelte";
  import { chatsChanged, lastChatFor, projectName, setLastChatFor } from "../lib/projects";
  import ChatMessage from "./ChatMessage.svelte";
  import ChatInput from "./ChatInput.svelte";
  import QuoteSelection from "./QuoteSelection.svelte";
  import ComputePicker from "./ComputePicker.svelte";
  import { computeChoice, freeReplyUsage } from "../lib/compute-choice";
  import { get } from "svelte/store";
  import { streamPortalChat, streamIdeChat, ideSendToolApproval, agentGitHubToken, portalCreateConversation, getModelPullProgress, isRemoteMode, backendReady } from "../lib/api";
  import type { StreamProgress, ModelPullProgress, IdeStreamEvent } from "../lib/api";
  import { applyAgentEvent, markApproval } from "../lib/agent-events";
  import { expandMentions, mentionSuggestions } from "../lib/mentions";
  import { autoApplySetting } from "../lib/project-mode";
  import PermissionModePicker from "./PermissionModePicker.svelte";
  import HelpersPicker from "./HelpersPicker.svelte";
  import TentacleTree from "./TentacleTree.svelte";
  import { effectiveHelpers, type ChatHelpers } from "../lib/helpers";
  import { applyTentacleEvent, emptyTentacles, type TentacleState } from "../lib/tentacles";
  import { tentacleCancel, tentacleMerge, type SessionEvent } from "../lib/api";
  import PlanApproval from "./PlanApproval.svelte";
  import { chatMode, modeOption, PLAN_APPROVED_MESSAGE, type EngineMode } from "../lib/permission-modes";
  import { fsFind } from "../lib/api";
  import {
    createConversation,
    addMessage,
    saveConversation,
    loadConversation as loadConversationFromDb,
    listConversationsBySource,
  } from "../lib/chat-store";
  import type { Conversation, ReplyUsage, ToolEvent } from "../lib/types";

  interface FileContext {
    path: string;
    content: string;
    language: string;
    selection?: { text: string; startLine: number; endLine: number };
  }
  interface Props {
    /** The open project: the panel runs the agent (with file and shell tools) against it. */
    projectRoot?: string | null;
    onApplyCode?: (code: string, language: string) => void;
    getFileContext?: () => FileContext | null;
    /** The agent wrote files (or ran a command that may have): reload open buffers and the tree. */
    onFilesChanged?: () => void;
    onOpenPath?: (path: string) => void;
    onPreview?: (path: string) => void;
    /** The panel is the whole view (no editor showing): the conversation is centred at reading width. */
    wide?: boolean;
    /** Bump to reload the project header's git state. */
    gitRefreshKey?: number;
    /** No project: open this recent one (the chat is linked to it). */
    onPickProject?: (root: string) => void;
    onNewProject?: () => void;
    onOpenFolder?: () => void;
    onClone?: () => void;
    /** Settings → Integrations (GitHub). */
    onConnectGitHub?: () => void;
    /** Show uncommitted changes (Source Control). */
    onReviewChanges?: () => void;
    /** The files and editor beside the chat: shown or not, and the toggle. */
    workspaceOpen?: boolean;
    onToggleWorkspace?: () => void;
    /** The chat showing changed (the sidebar highlights it). */
    onConversationChange?: (id: string) => void;
  }
  let {
    projectRoot = null, onApplyCode, getFileContext, onFilesChanged, onOpenPath, onPreview, wide = false, gitRefreshKey = 0,
    onPickProject, onNewProject, onOpenFolder, onClone, onConnectGitHub, onReviewChanges, workspaceOpen = false, onToggleWorkspace, onConversationChange,
  }: Props = $props();

  let streamingToolEvents: ToolEvent[] = $state([]);
  /** Where a message goes: the local agent, or a background job on the network. */
  let streamingTurnId: string | undefined = $state(undefined);
  let streamingUsage: ReplyUsage | undefined = $state(undefined);
  let streamingChanged: string[] = $state([]);

  /** A new coding chat in `root` (none: it waits for a project). */
  function freshConversation(root: string | null): Conversation {
    const c = createConversation("editor");
    if (root) c.projectRoot = root;
    return c;
  }
  let conversation: Conversation = $state(freshConversation(untrack(() => projectRoot)));
  /** Each load that replaces the conversation takes a number; a slower, older one is dropped. */
  let loadSeq = 0;
  $effect(() => {
    onConversationChange?.(conversation.id);
  });
  /** This chat's permission mode (kept with the chat; new chats start in Settings' default). */
  const mode = $derived<EngineMode>(chatMode(conversation.permissionMode, autoApplySetting(conversation.projectRoot ?? projectRoot)));
  function setMode(m: EngineMode) {
    conversation.permissionMode = m;
    conversation = conversation;
    if (conversation.messages.length > 0) void persist();
  }

  /**
   * This chat's helpers (docs/tentacles.md): its own choice, else Settings' default (on when the
   * lead is your frontier key). The tree shows the helpers this chat's lead started.
   */
  const helpers = $derived(effectiveHelpers(conversation.helpers, $computeChoice));
  function setHelpers(patch: ChatHelpers) {
    conversation.helpers = { ...(conversation.helpers ?? {}), ...patch };
    conversation = conversation;
    if (conversation.messages.length > 0) void persist();
  }
  let helperTree = $state<TentacleState>(emptyTentacles());
  let helperTreeFor = "";
  $effect(() => {
    if (conversation.id !== helperTreeFor) {
      helperTreeFor = conversation.id;
      helperTree = emptyTentacles();
    }
  });
  function onHelperEvent(event: IdeStreamEvent) {
    const e = event as unknown as SessionEvent;
    if (typeof e.type !== "string" || !e.type.startsWith("tentacle_")) return;
    helperTree = applyTentacleEvent(helperTree, e);
    const merge = (e.tentacle as { merge?: { state?: string } } | undefined)?.merge?.state;
    if (merge === "applied") onFilesChanged?.();
  }
  async function helperAct(fn: () => Promise<unknown>) {
    try {
      await fn();
      onFilesChanged?.();
    } catch {
      // the tree keeps its state; the next event corrects it
    }
  }

  /** Save the chat and remember it as its project's last one. */
  async function persist() {
    await saveConversation(conversation);
    localStorage.setItem("edgecoder-last-editor-id", conversation.id);
    if (conversation.projectRoot) setLastChatFor(conversation.projectRoot, conversation.id);
    chatsChanged();
  }

  // The open project changed: the chat follows it. An empty chat moves to the new project; one
  // with messages stays with its own and the project's last chat (or a new one) opens instead.
  let seenRoot: string | null | undefined = undefined;
  $effect(() => {
    const root = projectRoot;
    if (root === seenRoot) return;
    seenRoot = root;
    untrack(() => void followProject(root));
  });

  async function followProject(root: string | null) {
    if ((conversation.projectRoot ?? null) === root) return;
    if (conversation.messages.length === 0 && !isStreaming) {
      if (root) conversation.projectRoot = root;
      else delete conversation.projectRoot;
      conversation = conversation;
      return;
    }
    // A chat with no project yet is linked to the one just opened (the user picked it for it).
    if (!conversation.projectRoot && root) {
      conversation.projectRoot = root;
      conversation = conversation;
      await persist();
      return;
    }
    const seq = ++loadSeq;
    const id = root ? lastChatFor(root) : null;
    const loaded = id ? await loadConversationFromDb(id) : undefined;
    if (seq !== loadSeq) return;
    if (isStreaming && abortController) abortController.abort();
    conversation = loaded && (loaded.projectRoot ?? null) === root ? loaded : freshConversation(root);
    streamingContent = "";
  }
  let streamingContent = $state("");
  let isStreaming = $state(false);
  /** The last reply is a plan waiting for approval (the chat is still in Plan mode). */
  const pendingPlan = $derived(!isStreaming && mode === "plan" && conversation.messages.at(-1)?.role === "assistant" && conversation.messages.at(-1)?.plan === true);
  function approvePlan(next: EngineMode) {
    setMode(next);
    void sendMessage(PLAN_APPROVED_MESSAGE);
  }
  const restartKey = `editor-chat:${Math.random().toString(36).slice(2)}`;
  $effect(() => {
    setRestartBusy(restartKey, isStreaming && "streaming");
    return () => clearRestartBusy(restartKey);
  });
  let streamProgress: StreamProgress | undefined = $state(undefined);
  let abortController: AbortController | null = $state(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);
  let chatInput: ChatInput | undefined = $state(undefined);

  let recentConversations: Conversation[] = $state([]);
  let showPicker = $state(false);
  let pickerTrigger: HTMLButtonElement | undefined = $state();

  /** Whether to stream via the portal API when no local agent is available */
  let usePortalChat = $state(false);

  /** Active model download progress */
  let pullProgress: ModelPullProgress | null = $state(null);
  let pullPollTimer: ReturnType<typeof setInterval> | undefined;

  onMount(async () => {
    // Detect if we need to use portal chat (no local agent)
    await backendReady;
    if (isRemoteMode()) {
      usePortalChat = true;
    }

    // Reopen the last coding chat: the open project's, else the last one at all.
    const seq = ++loadSeq;
    const lastId = (projectRoot ? lastChatFor(projectRoot) : null) ?? localStorage.getItem("edgecoder-last-editor-id");
    const loaded = lastId ? await loadConversationFromDb(lastId) : undefined;
    if (seq === loadSeq && loaded && conversation.messages.length === 0) {
      // With a project open, only one of its own chats reopens (not another project's, nor one without a project).
      if (!projectRoot || loaded.projectRoot === projectRoot) conversation = loaded;
    }
    await refreshConversationList();

    // Hand the agent's GitHub connection to the IDE server early (sessions and bots use it too).
    void agentGitHubToken().catch(() => {});

    // Poll for model download progress
    pullPollTimer = setInterval(async () => {
      pullProgress = await getModelPullProgress();
    }, 3000);
  });

  // Save current conversation when component unmounts (tab switch)
  onDestroy(() => {
    if (pullPollTimer) clearInterval(pullPollTimer);
    if (conversation.messages.length > 0) void persist();
  });

  /** The picker lists this project's chats (or, with none open, the ones without a project). */
  async function refreshConversationList() {
    const all = await listConversationsBySource("editor");
    recentConversations = all.filter((c) => (c.projectRoot ?? null) === (projectRoot ?? null));
  }

  function scrollToBottom() {
    if (scrollContainer) {
      requestAnimationFrame(() => {
        if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
      });
    }
  }

  /**
   * Ensure the conversation has a portal-side conversation ID.
   * Creates one on the portal server if needed.
   */
  async function ensurePortalConversation(): Promise<string> {
    if (conversation.portalConversationId) {
      return conversation.portalConversationId;
    }
    const portalId = await portalCreateConversation(conversation.title || "Editor chat");
    conversation.portalConversationId = portalId;
    conversation = conversation;
    await saveConversation(conversation);
    return portalId;
  }

  export async function sendMessage(typed: string, attachments: AttachmentPayload[] = []) {
    // The conversation keeps the typed text and the attached names; the files go with this request only.
    const text = [typed, attachmentLabel(attachments)].filter(Boolean).join("\n\n");
    // Without the agent (portal / plain chat) text files go inline and images/PDFs as a note.
    const inlineText = attachments.length ? [text, attachmentsText(attachments, NO_VISION)].filter(Boolean).join("\n\n") : text;
    if (isStreaming) return;
    // Coding chats belong to a project; with none open the prompt to pick one shows instead.
    if (!projectRoot) return;
    if (!conversation.projectRoot) conversation.projectRoot = projectRoot;

    const titled = conversation.title !== "New chat";
    addMessage(conversation, "user", text);
    if (!titled) conversation.title = text.slice(0, 60) + (text.length > 60 ? "..." : "");
    conversation = conversation;

    isStreaming = true;
    streamingContent = "";
    streamProgress = undefined;
    abortController = new AbortController();
    const sentMode: EngineMode = mode;
    if (!conversation.permissionMode) conversation.permissionMode = sentMode;

    try {
      if (usePortalChat) {
        // Stream through portal API (no local agent available)
        const portalConvId = await ensurePortalConversation();
        await streamPortalChat(
          portalConvId,
          inlineText,
          (chunk) => {
            streamingContent += chunk;
            scrollToBottom();
          },
          abortController.signal,
          (progress) => {
            streamProgress = progress;
          },
        );
      } else {
        // Agent mode: tools for reading, editing and searching the project and running commands.
        const ctx = getFileContext?.();
        const attached = await expandMentions(text);
        const apiMessages = conversation.messages.map((m) => ({ role: m.role, content: m.content }));
        const preface = [ctx ? editorContextNote(ctx) : "", attached].filter(Boolean).join("\n\n");
        if (preface) apiMessages[apiMessages.length - 1] = { role: "user", content: `${preface}\n\n${text}` };
        streamingToolEvents = [];
        streamingTurnId = undefined;
        streamingUsage = undefined;
        streamingChanged = [];
        await streamIdeChat(
          apiMessages,
          projectRoot,
          (event: IdeStreamEvent) => {
            onHelperEvent(event);
            const { turn, filesChanged } = applyAgentEvent(
              { text: streamingContent, toolEvents: streamingToolEvents, turnId: streamingTurnId, changedFiles: streamingChanged, usage: streamingUsage },
              event,
            );
            if (turn.text !== streamingContent) streamingContent = turn.text;
            if (turn.toolEvents !== streamingToolEvents) streamingToolEvents = turn.toolEvents;
            streamingTurnId = turn.turnId;
            streamingUsage = turn.usage;
            if (turn.changedFiles && turn.changedFiles !== streamingChanged) streamingChanged = turn.changedFiles;
            if (filesChanged) onFilesChanged?.();
            if (event.type !== "status" && event.type !== "done") scrollToBottom();
          },
          abortController.signal,
          get(computeChoice),
          // Read at send time: connecting GitHub after this panel opened must count.
          await agentGitHubToken().catch(() => null),
          sentMode,
          "code",
          attachments,
          false,
          { sessionId: conversation.id, ...helpers },
        );
      }
      finishTurn(streamingContent, !usePortalChat && sentMode === "plan");
      await persist();
      await refreshConversationList();
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Stopped: keep what arrived so far.
        if (streamingContent || streamingToolEvents.length > 0) {
          finishTurn(`${streamingContent}\n\n_(stopped)_`);
          await persist();
        }
      } else {
        addMessage(conversation, "assistant", `Error: ${(err as Error).message}`);
        conversation = conversation;
      }
    } finally {
      streamingContent = "";
      streamingToolEvents = [];
      isStreaming = false;
      streamProgress = undefined;
      abortController = null;
    }
  }

  function finishTurn(content: string, plan = false) {
    addMessage(conversation, "assistant", content);
    const last = conversation.messages[conversation.messages.length - 1];
    if (last && plan && content.trim()) last.plan = true;
    if (last && streamingToolEvents.length > 0) last.toolEvents = [...streamingToolEvents];
    const usage = streamingUsage ?? freeReplyUsage(get(computeChoice));
    if (last && usage) last.usage = usage;
    if (last && streamingTurnId && streamingChanged.length > 0) {
      last.turnId = streamingTurnId;
      last.changedFiles = [...streamingChanged];
    }
    conversation = conversation;
  }

  /** What the user is looking at, sent with their message: the open file and any selection. */
  function editorContextNote(ctx: FileContext): string {
    if (ctx.selection) {
      return `[Editor: ${ctx.path}, lines ${ctx.selection.startLine}-${ctx.selection.endLine} selected]\n\`\`\`${ctx.language}\n${ctx.selection.text}\n\`\`\``;
    }
    return `[Editor: the user has ${ctx.path} open. Read it with read_file if you need its contents.]`;
  }

  export function stop() {
    abortController?.abort();
  }

  function handleToolApproval(id: string, approved: boolean, always = false) {
    void ideSendToolApproval(id, approved, always);
    streamingToolEvents = markApproval(streamingToolEvents, id, approved);
  }

  /** A new chat in the open project. */
  export async function newChat() {
    ++loadSeq;
    if (isStreaming && abortController) abortController.abort();
    if (conversation.messages.length > 0) await persist();
    conversation = freshConversation(projectRoot);
    streamingContent = "";
    isStreaming = false;
    abortController = null;
    showPicker = false;
  }

  /** Open a saved coding chat (the caller has opened its project first). */
  export async function openChat(id: string) {
    const seq = ++loadSeq;
    if (isStreaming && abortController) abortController.abort();
    if (conversation.messages.length > 0) await persist();
    const loaded = await loadConversationFromDb(id);
    if (seq !== loadSeq || !loaded) return;
    conversation = loaded;
    streamingContent = "";
    isStreaming = false;
    abortController = null;
    showPicker = false;
    if (loaded.projectRoot) setLastChatFor(loaded.projectRoot, loaded.id);
  }

  async function switchConversation(id: string) {
    await openChat(id);
  }

  /** Add a note from the app (what a new project or clone did) as an assistant message. */
  export async function addNote(text: string) {
    addMessage(conversation, "assistant", text);
    conversation = conversation;
    await persist();
  }

  export function getConversationId(): string {
    return conversation.id;
  }

  function handleSend(text: string, attachments?: AttachmentPayload[]) {
    sendMessage(text, attachments);
  }

  function formatTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }
</script>

<div class="editor-chat-panel" class:wide>
  <div class="panel-header">
    <button
      bind:this={pickerTrigger}
      class="conversation-selector"
      aria-haspopup="menu"
      aria-expanded={showPicker}
      title="Chats in this project"
      onclick={() => { showPicker = !showPicker; if (showPicker) void refreshConversationList(); }}
    >
      <span class="convo-title-text">{conversation.title}</span>
      <ChevronDown size={12} />
    </button>
    {#if projectRoot && onToggleWorkspace}
      <button class="icon-btn" class:on={workspaceOpen} aria-pressed={workspaceOpen} onclick={onToggleWorkspace} title={workspaceOpen ? "Hide files and editor" : "Show files and editor"} aria-label="Files and editor">
        <PanelRight size={16} />
      </button>
    {/if}
    <button class="icon-btn" onclick={newChat} disabled={!projectRoot} title={projectRoot ? "New chat in this project" : "Pick a project first"} aria-label="New coding chat">
      <Plus size={16} />
    </button>
  </div>
  {#if projectRoot}
    <ChatProjectHeader {projectRoot} refreshKey={gitRefreshKey} onChanged={onFilesChanged} {onReviewChanges} {onConnectGitHub} />
  {/if}

  {#if showPicker}
    <!-- The same keyboard menu as the conversation list (#161): arrows, Home/End, Escape, click away. -->
    <div
      class="conversation-picker"
      role="menu"
      aria-label="Chats in this project"
      tabindex="-1"
      use:menu={{ trigger: pickerTrigger, onClose: (returnFocus) => { showPicker = false; if (returnFocus) pickerTrigger?.focus(); } }}
    >
      {#each recentConversations.slice(0, 10) as convo (convo.id)}
        <button
          class="picker-item"
          class:active={convo.id === conversation.id}
          role="menuitem"
          aria-current={convo.id === conversation.id ? "true" : undefined}
          onclick={() => switchConversation(convo.id)}
        >
          <span class="picker-title">{convo.title}</span>
          <span class="picker-time">{formatTime(convo.updatedAt)}</span>
        </button>
      {:else}
        <div class="picker-empty" role="menuitem" aria-disabled="true">{projectRoot ? "No other chats in this project" : "No chats without a project"}</div>
      {/each}
    </div>
  {/if}

  {#if pullProgress}
    <div class="pull-banner">
      <span class="pull-label">Downloading {pullProgress.model}</span>
      <div class="pull-bar-track">
        <div class="pull-bar-fill" style="width: {pullProgress.progressPct}%"></div>
      </div>
      <span class="pull-pct">{pullProgress.progressPct}%</span>
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="messages-scroll" bind:this={scrollContainer} tabindex="0" role="region" aria-label="Conversation">
    {#if conversation.messages.length === 0 && !isStreaming}
      <div class="empty-state">
        {#if !projectRoot}
          <NoProjectPrompt onPick={(r) => onPickProject?.(r)} onNewProject={() => onNewProject?.()} onOpenFolder={() => onOpenFolder?.()} onClone={() => onClone?.()} />
        {:else}
          <p>The agent can read, search and edit files in this project and run commands. Mode: <strong>{modeOption(mode).title}</strong>, {modeOption(mode).desc.charAt(0).toLowerCase() + modeOption(mode).desc.slice(1)}</p>
          <p class="hint">It sees the open file and your selection. Type @ to add a file.</p>
        {/if}
      </div>
    {:else}
      <div class="messages">
        {#each conversation.messages as msg (msg.id)}
          <ChatMessage
            role={msg.role as "user" | "assistant"}
            content={msg.content}
            toolEvents={msg.toolEvents}
            networkTaskId={msg.networkTaskId}
            turnId={msg.turnId}
            changedFiles={msg.changedFiles}
            usage={msg.usage}
            onFilesReverted={onFilesChanged}
            {onOpenPath}
            {onPreview}
            onOpenInEditor={onApplyCode}
          />
        {/each}
        {#if isStreaming && (streamingContent || streamingToolEvents.length > 0)}
          <ChatMessage
            role="assistant"
            content={streamingContent}
            streaming={true}
            {streamProgress}
            toolEvents={streamingToolEvents}
            onOpenInEditor={onApplyCode}
            onToolApproval={handleToolApproval}
            onToolAlways={(id) => handleToolApproval(id, true, true)}
          />
        {/if}
        {#if pendingPlan}
          <PlanApproval onApprove={approvePlan} onRevise={() => chatInput?.focus()} />
        {/if}
      </div>
    {/if}
    {#if projectRoot}<QuoteSelection scope={scrollContainer} onQuote={(b) => void chatInput?.insertQuote(b)} />{/if}
  </div>

  {#if projectRoot && helperTree.items.length}
    <div class="helper-tree">
      <TentacleTree
        tree={helperTree}
        canAct={true}
        onCancel={(tid) => void helperAct(() => tentacleCancel(conversation.id, tid))}
        onMerge={(tid, ok) => void helperAct(async () => {
          const r = (await tentacleMerge(conversation.id, tid, ok)) as { tentacle?: unknown } | undefined;
          if (r?.tentacle) helperTree = applyTentacleEvent(helperTree, { type: "tentacle_merge", seq: 0, at: Date.now(), tentacle: r.tentacle } as SessionEvent);
        })}
      />
    </div>
  {/if}

  <div class="panel-input">
    {#if !projectRoot}
      {#if conversation.messages.length > 0}
        <NoProjectPrompt compact onPick={(r) => onPickProject?.(r)} onNewProject={() => onNewProject?.()} onOpenFolder={() => onOpenFolder?.()} onClone={() => onClone?.()} />
      {/if}
    {:else}
      <ChatInput
        bind:this={chatInput}
        onSend={handleSend}
        placeholder="Ask the agent to change {projectName(projectRoot)}… (@ to add a file)"
        streaming={isStreaming}
        onStop={stop}
        attach={{ vision: usePortalChat ? NO_VISION : visionFor($computeChoice), who: "This model" }}
        mentions={(q) => mentionSuggestions(q, (x) => fsFind(x, 8))}
      >
        {#snippet controls()}
          <ComputePicker selected={$computeChoice} onSelect={(id) => computeChoice.set(id)} />
          {#if !usePortalChat}
            <HelpersPicker {helpers} onChange={setHelpers} />
            <PermissionModePicker {mode} onChange={setMode} />
          {/if}
        {/snippet}
      </ChatInput>
    {/if}
  </div>
</div>

<style>
  .helper-tree { padding: 0 12px; max-height: 40vh; overflow-y: auto; }
  .editor-chat-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .editor-chat-panel {
    position: relative;
  }
  .panel-header {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 36px;
    padding: 0 6px 0 4px;
    border-bottom: 0.5px solid var(--border);
    flex-shrink: 0;
  }

  .conversation-selector {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--control-md);
    padding: 0 8px;
    border: none;
    background: none;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: 500;
    cursor: pointer;
    border-radius: var(--radius-sm);
    text-align: left;
    min-width: 0;
    transition: background 0.15s;
  }
  .conversation-selector:hover {
    background: var(--bg-elevated);
  }
  .convo-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }


  .conversation-picker {
    position: absolute;
    top: 44px;
    left: 8px;
    right: 8px;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    z-index: 10;
    max-height: 320px;
    overflow-y: auto;
    padding: 4px;
  }

  .picker-empty {
    padding: 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .picker-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    background: none;
    color: var(--text-primary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    text-align: left;
    transition: background 0.1s;
  }
  .picker-item:hover {
    background: var(--bg-surface);
  }
  .picker-item.active {
    border-left: 2px solid var(--accent);
    padding-left: 8px;
  }
  .picker-title {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker-time {
    font-size: 11px;
    color: var(--text-muted);
  }

  .messages-scroll {
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
    gap: 4px;
    padding: 24px;
  }
  .empty-state p {
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    text-align: center;
    max-width: 320px;
    margin: 0;
  }
  .empty-state p.hint {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 16px;
    /* The panel is narrow: 14 px prose. Full width when the panel is the whole view. */
    --prose-size: var(--fs-base);
  }

  .panel-input {
    padding: 4px 12px 12px;
    flex-shrink: 0;
  }
  /* The whole view: reading width, like the Chat view. */
  .wide .messages, .wide .panel-input {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    box-sizing: border-box;
  }
  .wide .messages {
    padding: 24px;
    gap: 24px;
    --prose-size: var(--fs-md);
  }
  .wide .panel-input {
    padding: 4px 24px 16px;
    --prose-size: var(--fs-md);
  }
  .pull-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
    font-size: 11px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .pull-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }
  .pull-bar-track {
    flex: 1;
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .pull-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .pull-pct {
    min-width: 28px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import ChatInput from "./ChatInput.svelte";
  import ComputePicker from "./ComputePicker.svelte";
  import { computeChoice, freeReplyUsage } from "../lib/compute-choice";
  import { get } from "svelte/store";
  import { streamChat, streamPortalChat, streamIdeChat, ideSendToolApproval, getGitHubToken, portalCreateConversation, getModelPullProgress, isRemoteMode, backendReady } from "../lib/api";
  import type { StreamProgress, ModelPullProgress, IdeStreamEvent } from "../lib/api";
  import { applyAgentEvent, markApproval } from "../lib/agent-events";
  import { expandMentions, mentionSuggestions } from "../lib/mentions";
  import { autoApplyEdits, setAutoApplyEdits } from "../lib/project-mode";
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
  }
  let { projectRoot = null, onApplyCode, getFileContext, onFilesChanged, onOpenPath, onPreview }: Props = $props();

  let streamingToolEvents: ToolEvent[] = $state([]);
  /** Where a message goes: the local agent, or a background job on the network. */
  /** Apply the agent's file edits without asking, in this project (commands still ask). */
  let autoApply = $state(false);
  $effect(() => {
    autoApply = autoApplyEdits(projectRoot);
  });
  let streamingTurnId: string | undefined = $state(undefined);
  let streamingUsage: ReplyUsage | undefined = $state(undefined);
  let streamingChanged: string[] = $state([]);
  let githubToken: string | null = null;

  let conversation: Conversation = $state(createConversation("editor"));
  let streamingContent = $state("");
  let isStreaming = $state(false);
  let streamProgress: StreamProgress | undefined = $state(undefined);
  let abortController: AbortController | null = $state(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);

  let recentConversations: Conversation[] = $state([]);
  let showPicker = $state(false);

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

    // Restore last editor conversation
    const lastId = localStorage.getItem("edgecoder-last-editor-id");
    if (lastId) {
      const loaded = await loadConversationFromDb(lastId);
      if (loaded) {
        conversation = loaded;
      }
    } else {
      // Fallback: load most recent editor conversation
      const recent = await listConversationsBySource("editor");
      if (recent.length > 0) {
        const loaded = await loadConversationFromDb(recent[0].id);
        if (loaded) conversation = loaded;
      }
    }
    recentConversations = await listConversationsBySource("editor");

    getGitHubToken().then((t) => { githubToken = t; }).catch(() => {});

    // Poll for model download progress
    pullPollTimer = setInterval(async () => {
      pullProgress = await getModelPullProgress();
    }, 3000);
  });

  // Save current conversation when component unmounts (tab switch)
  onDestroy(() => {
    if (pullPollTimer) clearInterval(pullPollTimer);
    if (conversation.messages.length > 0) {
      localStorage.setItem("edgecoder-last-editor-id", conversation.id);
      saveConversation(conversation);
    }
  });

  async function refreshConversationList() {
    recentConversations = await listConversationsBySource("editor");
  }

  function scrollToBottom() {
    if (scrollContainer) {
      requestAnimationFrame(() => {
        scrollContainer!.scrollTop = scrollContainer!.scrollHeight;
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

  export async function sendMessage(text: string) {
    if (isStreaming) return;

    addMessage(conversation, "user", text);
    conversation = conversation;

    isStreaming = true;
    streamingContent = "";
    streamProgress = undefined;
    abortController = new AbortController();

    try {
      if (usePortalChat) {
        // Stream through portal API (no local agent available)
        const portalConvId = await ensurePortalConversation();
        await streamPortalChat(
          portalConvId,
          text,
          (chunk) => {
            streamingContent += chunk;
            scrollToBottom();
          },
          abortController.signal,
          (progress) => {
            streamProgress = progress;
          },
        );
      } else if (projectRoot) {
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
          githubToken,
          autoApply ? "edits" : "none",
        );
      } else {
        // Stream through local IDE provider (OpenAI-compatible format)
        const fileContext = getFileContext?.();
        const systemMessages = fileContext
          ? [{ role: "system", content: `The user is editing ${fileContext.path} (${fileContext.language}). Current file content:\n\`\`\`${fileContext.language}\n${fileContext.content}\n\`\`\`` }]
          : [];

        const apiMessages = [
          ...systemMessages,
          ...conversation.messages.map((m) => ({ role: m.role, content: m.content })),
        ];

        await streamChat(
          apiMessages,
          (chunk) => {
            streamingContent += chunk;
            scrollToBottom();
          },
          abortController.signal,
          (progress) => {
            streamProgress = progress;
          },
          get(computeChoice),
        );
      }
      finishTurn(streamingContent);
      await saveConversation(conversation);
      localStorage.setItem("edgecoder-last-editor-id", conversation.id);
      await refreshConversationList();
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Stopped: keep what arrived so far.
        if (streamingContent || streamingToolEvents.length > 0) {
          finishTurn(`${streamingContent}\n\n_(stopped)_`);
          await saveConversation(conversation);
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

  function finishTurn(content: string) {
    addMessage(conversation, "assistant", content);
    const last = conversation.messages[conversation.messages.length - 1];
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

  function handleToolApproval(id: string, approved: boolean) {
    void ideSendToolApproval(id, approved);
    streamingToolEvents = markApproval(streamingToolEvents, id, approved);
  }

  export async function newChat() {
    if (isStreaming && abortController) abortController.abort();
    if (conversation.messages.length > 0) await saveConversation(conversation);
    conversation = createConversation("editor");
    streamingContent = "";
    isStreaming = false;
    abortController = null;
    showPicker = false;
  }

  async function switchConversation(id: string) {
    if (isStreaming && abortController) abortController.abort();
    if (conversation.messages.length > 0) await saveConversation(conversation);
    const loaded = await loadConversationFromDb(id);
    if (loaded) {
      conversation = loaded;
      streamingContent = "";
      isStreaming = false;
      abortController = null;
    }
    showPicker = false;
  }

  export function getConversationId(): string {
    return conversation.id;
  }

  function handleSend(text: string) {
    sendMessage(text);
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

<div class="editor-chat-panel">
  <div class="panel-header">
    <button class="conversation-selector" onclick={() => { showPicker = !showPicker; }}>
      <span class="convo-title-text">{conversation.title}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
    <ComputePicker selected={$computeChoice} up={false} onSelect={(id) => computeChoice.set(id)} />
    <button class="new-chat-btn" onclick={newChat} title="New coding chat">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14"/>
      </svg>
    </button>
  </div>

  {#if showPicker}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="picker-backdrop" onclick={() => { showPicker = false; }}></div>
    <div class="conversation-picker">
      {#if recentConversations.length === 0}
        <div class="picker-empty">No previous coding chats</div>
      {:else}
        {#each recentConversations.slice(0, 10) as convo (convo.id)}
          <button
            class="picker-item"
            class:active={convo.id === conversation.id}
            onclick={() => switchConversation(convo.id)}
          >
            <span class="picker-title">{convo.title}</span>
            <span class="picker-time">{formatTime(convo.updatedAt)}</span>
          </button>
        {/each}
      {/if}
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

  <div class="messages-scroll" bind:this={scrollContainer}>
    {#if conversation.messages.length === 0 && !isStreaming}
      <div class="empty-state">
        {#if projectRoot}
          <p>The agent can read, search and edit files in this project and run commands. Edits and commands ask for your approval first.</p>
          <p class="hint">It sees the open file and your selection.</p>
        {:else}
          <p>Ask about your code, request changes, or get explanations. Open a folder to let the agent edit files.</p>
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
          />
        {/if}
      </div>
    {/if}
  </div>

  <div class="panel-input">
    {#if projectRoot && !usePortalChat}
      <!-- Where the model runs (this computer, your machines, the network) is the compute picker above. -->
      <div class="run-on">
        <label class="auto-apply" title="Apply the agent's file edits without asking. Each reply's changes stay reviewable and undoable; commands still ask.">
          <input type="checkbox" checked={autoApply} onchange={(e) => { autoApply = (e.target as HTMLInputElement).checked; if (projectRoot) setAutoApplyEdits(projectRoot, autoApply); }} />
          Auto-apply edits
        </label>
      </div>
    {/if}
    <ChatInput
      onSend={handleSend}
      placeholder={!projectRoot ? "Ask about your code…" : "Ask the agent… (@ to mention a file)"}
      streaming={isStreaming}
      onStop={stop}
      mentions={projectRoot ? (q) => mentionSuggestions(q, (x) => fsFind(x, 8)) : undefined}
    />
  </div>
</div>

<style>
  .editor-chat-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
    border-bottom: 0.5px solid var(--border);
    flex-shrink: 0;
  }

  .conversation-selector {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: none;
    background: none;
    color: var(--text-primary);
    font-size: 13px;
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

  .new-chat-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .new-chat-btn:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9;
  }

  .conversation-picker {
    position: absolute;
    top: 44px;
    left: 8px;
    right: 8px;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
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
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .empty-state p {
    color: var(--text-muted);
    font-size: 13px;
    text-align: center;
    margin: 0;
  }

  .messages {
    display: flex;
    flex-direction: column;
    padding: 12px 0;
  }

  .run-on {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .auto-apply {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .panel-input {
    border-top: 0.5px solid var(--border);
    padding: 8px;
    flex-shrink: 0;
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

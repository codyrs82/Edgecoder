<script lang="ts">
  import { applyAgentEvent, markApproval } from "../lib/agent-events";
  import { expandMentions } from "../lib/mentions";
  import { autoApplyEdits } from "../lib/project-mode";
  import { onMount, onDestroy } from "svelte";
  import ChatMessage from "../components/ChatMessage.svelte";
  import { computeChoice, freeReplyUsage } from "../lib/compute-choice";
  import { get } from "svelte/store";
  import {
    streamChat,
    streamPortalChat,
    streamIdeChat,
    ideSendToolApproval,
    portalCreateConversation,
    portalRenameConversation,
    getModelPullProgress,
    isRemoteMode,
    backendReady,
    getGitHubToken,
    fsGitStatus,
  } from "../lib/api";
  import type { StreamProgress, ModelPullProgress, IdeStreamEvent, RepoConnection } from "../lib/api";
  import ConnectRepo from "../components/ConnectRepo.svelte";
  import { GitBranch } from "@lucide/svelte";
  import {
    createConversation,
    addMessage,
    saveConversation,
    loadConversation as loadConversationFromDb,
    listConversationsBySource,
  } from "../lib/chat-store";
  import type { Conversation, ReplyUsage, ToolEvent } from "../lib/types";

  interface Props {
    onOpenInEditor?: (code: string, language: string) => void;
    projectRoot?: string | null;
    /** Told when a reply starts and stops streaming (the page's input shows Stop meanwhile). */
    onStreamingChange?: (streaming: boolean) => void;
    /** Open a project file in the editor tab (from an agent reply's changes card). */
    onOpenPath?: (path: string) => void;
    onPreview?: (path: string) => void;
    /** A repository was connected from this chat's empty state; it is now the open project. */
    onRepoConnected?: (r: RepoConnection) => void;
  }
  let { onOpenInEditor, projectRoot = null, onStreamingChange, onOpenPath, onPreview, onRepoConnected }: Props = $props();

  let connectRepoBox: ConnectRepo | undefined = $state(undefined);
  /** The open project's folder name and branch, for the header. */
  let projectBranch = $state<string | null>(null);
  const projectName = $derived(projectRoot ? projectRoot.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? null : null);
  $effect(() => {
    const root = projectRoot;
    void isStreaming; // a reply may have switched branches
    if (!root || usePortalChat) {
      projectBranch = null;
      return;
    }
    fsGitStatus().then((s) => { if (root === projectRoot) projectBranch = s.branch; }).catch(() => { projectBranch = null; });
  });

  /** Put the cursor in the "Connect a repository" field (new chat). */
  export function focusConnect() {
    connectRepoBox?.focus();
  }

  /** The project folder this chat was working in, if any (reopened when the chat is). */
  export function getProjectRoot(): string | null {
    return conversation.projectRoot ?? null;
  }

  function repoConnected(r: RepoConnection) {
    conversation.projectRoot = r.path;
    onRepoConnected?.(r);
  }

  let conversation: Conversation = $state(createConversation("chat"));
  let streamingContent = $state("");
  let isStreaming = $state(false);
  let streamProgress: StreamProgress | undefined = $state(undefined);
  let meshWarning: string | null = $state(null);
  let abortController: AbortController | null = $state(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);

  /** Whether we should stream via the portal API (server-side conversations) */
  let usePortalChat = $state(false);

  /** IDE agent streaming tool events */
  let streamingToolEvents: ToolEvent[] = $state([]);
  let streamingTurnId: string | undefined = $state(undefined);
  let streamingUsage: ReplyUsage | undefined = $state(undefined);
  let streamingChanged: string[] = $state([]);

  /** Cached GitHub token for IDE agent remote operations */
  let cachedGitHubToken: string | null = $state(null);

  $effect(() => {
    getGitHubToken().then((t) => { cachedGitHubToken = t; }).catch(() => {});
    // Re-fetch when GitHub is connected via settings
    const handler = () => { getGitHubToken().then((t) => { cachedGitHubToken = t; }).catch(() => {}); };
    window.addEventListener("edgecoder:github-connected", handler);
    return () => window.removeEventListener("edgecoder:github-connected", handler);
  });

  /** Active model download progress */
  let pullProgress: ModelPullProgress | null = $state(null);
  let pullPollTimer: ReturnType<typeof setInterval> | undefined;

  const quickActions = [
    { label: "Fix a bug", prompt: "Help me fix a bug in my code" },
    { label: "Write tests", prompt: "Help me write tests" },
    { label: "Explain code", prompt: "Explain how this code works" },
    { label: "Review code", prompt: "Review this code for issues" },
  ];

  // Restore last chat conversation on mount
  onMount(async () => {
    // Use portal chat when no local agent is running
    await backendReady;
    if (isRemoteMode()) {
      usePortalChat = true;
    }

    const lastId = localStorage.getItem("edgecoder-last-chat-id");
    if (lastId) {
      const loaded = await loadConversationFromDb(lastId);
      if (loaded) {
        conversation = loaded;
      }
    }
    if (!conversation.messages.length) {
      // Fallback: load most recent chat conversation
      const recent = await listConversationsBySource("chat");
      if (recent.length > 0) {
        const loaded = await loadConversationFromDb(recent[0].id);
        if (loaded) conversation = loaded;
      }
    }

    // Poll for model download progress
    pullPollTimer = setInterval(async () => {
      pullProgress = await getModelPullProgress();
    }, 3000);
  });

  // Save current conversation when component unmounts (tab switch)
  onDestroy(() => {
    if (pullPollTimer) clearInterval(pullPollTimer);
    if (conversation.messages.length > 0) {
      localStorage.setItem("edgecoder-last-chat-id", conversation.id);
      saveConversation(conversation);
    }
  });

  /**
   * Ensure the conversation has a portal-side conversation ID.
   * Creates one on the portal server if needed.
   */
  async function ensurePortalConversation(): Promise<string> {
    if (conversation.portalConversationId) {
      return conversation.portalConversationId;
    }
    const portalId = await portalCreateConversation(conversation.title);
    conversation.portalConversationId = portalId;
    conversation = conversation;
    await saveConversation(conversation);
    return portalId;
  }

  function handleToolApproval(id: string, approved: boolean) {
    ideSendToolApproval(id, approved);
    streamingToolEvents = markApproval(streamingToolEvents, id, approved);
  }

  export async function sendMessage(text: string) {
    if (isStreaming) return;

    addMessage(conversation, "user", text);
    // Where this chat ran last (the sidebar's laptop / server / cloud icon).
    conversation.selectedModel = get(computeChoice);
    if (projectRoot) conversation.projectRoot = projectRoot;
    conversation = conversation; // trigger reactivity

    isStreaming = true;
    streamingContent = "";
    streamProgress = undefined;
    meshWarning = null;
    abortController = new AbortController();

    try {
      if (projectRoot && !usePortalChat) {
        // IDE agent mode — stream with tool events
        const apiMessages = conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const attached = await expandMentions(text);
        if (attached) apiMessages[apiMessages.length - 1] = { role: "user", content: `${attached}\n\n${text}` };
        streamingToolEvents = [];
        streamingTurnId = undefined;
        streamingUsage = undefined;
        streamingChanged = [];

        await streamIdeChat(
          apiMessages,
          projectRoot,
          (event: IdeStreamEvent) => {
            const next = applyAgentEvent(
              { text: streamingContent, toolEvents: streamingToolEvents, turnId: streamingTurnId, changedFiles: streamingChanged, usage: streamingUsage },
              event,
            ).turn;
            if (next.text !== streamingContent) streamingContent = next.text;
            if (next.toolEvents !== streamingToolEvents) streamingToolEvents = next.toolEvents;
            streamingTurnId = next.turnId;
            streamingUsage = next.usage;
            if (next.changedFiles && next.changedFiles !== streamingChanged) streamingChanged = next.changedFiles;
            if (event.type !== "status" && event.type !== "done") scrollToBottom();
          },
          abortController.signal,
          get(computeChoice),
          cachedGitHubToken,
          autoApplyEdits(projectRoot) ? "edits" : "none",
        );
      } else if (usePortalChat) {
        // Stream through the portal API (server persists messages)
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
            if (progress.warning) meshWarning = progress.warning;
          },
        );
      } else {
        // Stream through local IDE provider (OpenAI-compatible format)
        const apiMessages = conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

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

      addMessage(conversation, "assistant", streamingContent);
      attachTurn();
      conversation = conversation;
      await saveConversation(conversation);
      localStorage.setItem("edgecoder-last-chat-id", conversation.id);

      // Auto-rename on portal if title is still default
      if (
        usePortalChat &&
        conversation.portalConversationId &&
        conversation.title.startsWith("New chat")
      ) {
        const newTitle =
          text.length > 40 ? text.substring(0, 40) + "..." : text;
        portalRenameConversation(
          conversation.portalConversationId,
          newTitle,
        ).catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Stopped: keep what arrived so far.
        if (streamingContent || streamingToolEvents.length > 0) {
          addMessage(conversation, "assistant", `${streamingContent}\n\n_(stopped)_`);
          attachTurn();
          conversation = conversation;
          await saveConversation(conversation);
        }
      } else {
        addMessage(conversation, "assistant", `Error: ${(err as Error).message}`);
        conversation = conversation;
      }
    } finally {
      streamingContent = "";
      isStreaming = false;
      streamProgress = undefined;
      streamingToolEvents = [];
      abortController = null;
    }
  }

  /** Attach the streamed tool events and the turn's file changes to the last assistant message. */
  function attachTurn() {
    const lastMsg = conversation.messages[conversation.messages.length - 1];
    if (!lastMsg) return;
    if (streamingToolEvents.length > 0) lastMsg.toolEvents = [...streamingToolEvents];
    const usage = streamingUsage ?? freeReplyUsage(get(computeChoice));
    if (usage) lastMsg.usage = usage;
    if (streamingTurnId && streamingChanged.length > 0) {
      lastMsg.turnId = streamingTurnId;
      lastMsg.changedFiles = [...streamingChanged];
    }
  }

  /** A note in the conversation from the app itself (e.g. that a project was created). */
  export function addNote(text: string) {
    addMessage(conversation, "assistant", text);
    conversation = conversation;
  }

  /** Stop the reply that is streaming (the partial reply is kept). */
  export function stop() {
    abortController?.abort();
  }

  $effect(() => {
    onStreamingChange?.(isStreaming);
  });

  function scrollToBottom() {
    if (scrollContainer) {
      requestAnimationFrame(() => {
        scrollContainer!.scrollTop = scrollContainer!.scrollHeight;
      });
    }
  }

  export async function newChat() {
    if (isStreaming && abortController) {
      abortController.abort();
    }
    // Save current conversation if it has messages
    if (conversation.messages.length > 0) {
      await saveConversation(conversation);
    }
    conversation = createConversation("chat");
    streamingContent = "";
    isStreaming = false;
    abortController = null;
    localStorage.setItem("edgecoder-last-chat-id", conversation.id);
  }

  export async function loadConversation(id: string) {
    if (isStreaming && abortController) {
      abortController.abort();
    }
    // Save current conversation if it has messages
    if (conversation.messages.length > 0) {
      await saveConversation(conversation);
    }
    const loaded = await loadConversationFromDb(id);
    if (loaded) {
      conversation = loaded;
      streamingContent = "";
      isStreaming = false;
      abortController = null;
    }
  }

  export function getConversationId(): string {
    return conversation.id;
  }

  function handleQuickAction(prompt: string) {
    sendMessage(prompt);
  }
</script>

<div class="chat-view" bind:this={scrollContainer}>
  <div class="chat-header">
    {#if projectName && !usePortalChat}
      <span class="repo-badge" title={projectRoot}>
        <span class="repo-name">{projectName}</span>
        {#if projectBranch}<span class="repo-branch"><GitBranch size={11} /> {projectBranch}</span>{/if}
      </span>
    {/if}
    {#if usePortalChat}
      <span class="portal-badge" title="Chat synced with portal server">
        <span class="portal-dot"></span>
        Portal
      </span>
    {/if}
  </div>

  {#if meshWarning}
    <div class="mesh-warning">
      <span class="mesh-warning-icon">&#9888;</span>
      <span>{meshWarning}</span>
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

  {#if conversation.messages.length === 0 && !isStreaming}
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
      {#if onRepoConnected && !usePortalChat}
        <div class="connect-slot">
          <ConnectRepo bind:this={connectRepoBox} onConnected={repoConnected} />
        </div>
      {/if}
    </div>
  {:else}
    <div class="messages">
      {#each conversation.messages as msg (msg.id)}
        <ChatMessage role={msg.role as "user" | "assistant"} content={msg.content} toolEvents={msg.toolEvents} turnId={msg.turnId} changedFiles={msg.changedFiles} usage={msg.usage} {onOpenPath} {onPreview} {onOpenInEditor} onToolApproval={handleToolApproval} />
      {/each}
      {#if isStreaming && (streamingContent || streamingToolEvents.length > 0)}
        <ChatMessage role="assistant" content={streamingContent} streaming={true} {streamProgress} toolEvents={streamingToolEvents} {onOpenInEditor} onToolApproval={handleToolApproval} />
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
  .chat-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    flex-shrink: 0;
  }
  .repo-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
    padding: 2px 10px;
    border: 0.5px solid var(--border);
    border-radius: 999px;
    background: var(--bg-surface);
    max-width: 60%;
    overflow: hidden;
  }
  .repo-name {
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .repo-branch {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-muted, var(--text-secondary));
    white-space: nowrap;
  }
  .connect-slot {
    width: 100%;
    display: flex;
    justify-content: center;
    margin-top: 20px;
  }
  .portal-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 8px;
    border: 0.5px solid var(--border);
    border-radius: 999px;
    background: var(--bg-surface);
  }
  .portal-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
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
    border: 0.5px solid var(--border-strong);
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
  .mesh-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: color-mix(in srgb, var(--yellow) 8%, transparent);
    border-bottom: 0.5px solid color-mix(in srgb, var(--yellow) 20%, transparent);
    font-size: 12px;
    color: var(--yellow);
    flex-shrink: 0;
  }
  .mesh-warning-icon {
    flex-shrink: 0;
  }
  .pull-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
    font-size: 12px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .pull-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }
  .pull-bar-track {
    flex: 1;
    height: 4px;
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
    min-width: 32px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>

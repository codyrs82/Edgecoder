<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ChatMessage from "../components/ChatMessage.svelte";
  import ModelPicker from "../components/ModelPicker.svelte";
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
  } from "../lib/api";
  import type { StreamProgress, ModelPullProgress, IdeStreamEvent } from "../lib/api";
  import {
    createConversation,
    addMessage,
    saveConversation,
    loadConversation as loadConversationFromDb,
    listConversationsBySource,
  } from "../lib/chat-store";
  import type { Conversation, ToolEvent } from "../lib/types";

  interface Props {
    onOpenInEditor?: (code: string, language: string) => void;
    projectRoot?: string | null;
  }
  let { onOpenInEditor, projectRoot = null }: Props = $props();

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
    const evt = streamingToolEvents.find(e => e.id === id);
    if (evt) {
      evt.approval_status = approved ? "approved" : "rejected";
      streamingToolEvents = [...streamingToolEvents];
    }
  }

  export async function sendMessage(text: string) {
    if (isStreaming) return;

    addMessage(conversation, "user", text);
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
        streamingToolEvents = [];

        await streamIdeChat(
          apiMessages,
          projectRoot,
          (event: IdeStreamEvent) => {
            switch (event.type) {
              case "text":
                streamingContent += event.content as string;
                scrollToBottom();
                break;
              case "status":
                break;
              case "tool_call":
                streamingToolEvents = [...streamingToolEvents, {
                  type: "tool_call",
                  id: event.id as string,
                  tool: event.tool as string,
                  args: event.args as Record<string, unknown>,
                  requires_approval: event.requires_approval as boolean,
                  approval_status: (event.requires_approval ? "pending" : "approved") as "pending" | "approved",
                }];
                scrollToBottom();
                break;
              case "tool_result": {
                const idx = streamingToolEvents.findIndex(e => e.id === event.id);
                if (idx >= 0) {
                  streamingToolEvents[idx] = {
                    ...streamingToolEvents[idx],
                    result: event.result as string | undefined,
                    error: event.error as string | undefined,
                  };
                  streamingToolEvents = [...streamingToolEvents];
                }
                break;
              }
              case "shell_output":
                streamingToolEvents = [...streamingToolEvents, {
                  type: "shell_output",
                  id: event.id as string,
                  stdout: event.stdout as string,
                  stderr: event.stderr as string,
                  exit_code: event.exit_code as number,
                }];
                scrollToBottom();
                break;
              case "plan":
                streamingToolEvents = [...streamingToolEvents, {
                  type: "plan",
                  steps: event.steps as ToolEvent["steps"],
                  plan_status: event.status as string,
                }];
                scrollToBottom();
                break;
              case "done":
                break;
            }
          },
          abortController.signal,
          conversation.selectedModel,
          cachedGitHubToken,
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
          conversation.selectedModel,
        );
      }

      addMessage(conversation, "assistant", streamingContent);
      // Attach tool events to the last assistant message if any
      if (streamingToolEvents.length > 0) {
        const lastMsg = conversation.messages[conversation.messages.length - 1];
        if (lastMsg) {
          lastMsg.toolEvents = [...streamingToolEvents];
        }
      }
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
      if ((err as Error).name !== "AbortError") {
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
    <ModelPicker
      selectedModel={conversation.selectedModel}
      onSelect={(model) => { conversation.selectedModel = model; conversation = conversation; }}
    />
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
    </div>
  {:else}
    <div class="messages">
      {#each conversation.messages as msg (msg.id)}
        <ChatMessage role={msg.role as "user" | "assistant"} content={msg.content} toolEvents={msg.toolEvents} {onOpenInEditor} onToolApproval={handleToolApproval} />
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
    background: rgba(251, 191, 36, 0.08);
    border-bottom: 0.5px solid rgba(251, 191, 36, 0.2);
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

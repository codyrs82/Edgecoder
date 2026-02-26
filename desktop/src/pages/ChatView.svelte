<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ChatMessage from "../components/ChatMessage.svelte";
  import ModelPicker from "../components/ModelPicker.svelte";
  import {
    streamChat,
    streamPortalChat,
    portalCreateConversation,
    portalRenameConversation,
  } from "../lib/api";
  import type { StreamProgress } from "../lib/api";
  import {
    createConversation,
    addMessage,
    saveConversation,
    loadConversation as loadConversationFromDb,
    listConversationsBySource,
  } from "../lib/chat-store";
  import type { Conversation } from "../lib/types";

  interface Props {
    onOpenInEditor?: (code: string, language: string) => void;
  }
  let { onOpenInEditor }: Props = $props();

  let conversation: Conversation = $state(createConversation("chat"));
  let streamingContent = $state("");
  let isStreaming = $state(false);
  let streamProgress: StreamProgress | undefined = $state(undefined);
  let abortController: AbortController | null = $state(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);

  /** Whether we should stream via the portal API (server-side conversations) */
  let usePortalChat = $state(false);

  const quickActions = [
    { label: "Fix a bug", prompt: "Help me fix a bug in my code" },
    { label: "Write tests", prompt: "Help me write tests" },
    { label: "Explain code", prompt: "Explain how this code works" },
    { label: "Review code", prompt: "Review this code for issues" },
  ];

  // Restore last chat conversation on mount
  onMount(async () => {
    // Detect if portal chat is available (server-side conversations)
    try {
      const res = await fetch(
        (import.meta.env.DEV ? "/portal" : "http://localhost:4305") +
          "/portal/api/conversations",
        { credentials: "include" },
      );
      if (res.ok) {
        usePortalChat = true;
      }
    } catch {
      // Portal not available — use local IDE provider
    }

    const lastId = localStorage.getItem("edgecoder-last-chat-id");
    if (lastId) {
      const loaded = await loadConversationFromDb(lastId);
      if (loaded) {
        conversation = loaded;
        return;
      }
    }
    // Fallback: load most recent chat conversation
    const recent = await listConversationsBySource("chat");
    if (recent.length > 0) {
      const loaded = await loadConversationFromDb(recent[0].id);
      if (loaded) conversation = loaded;
    }
  });

  // Save current conversation when component unmounts (tab switch)
  onDestroy(() => {
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

  export async function sendMessage(text: string) {
    if (isStreaming) return;

    addMessage(conversation, "user", text);
    conversation = conversation; // trigger reactivity

    isStreaming = true;
    streamingContent = "";
    streamProgress = undefined;
    abortController = new AbortController();

    try {
      if (usePortalChat) {
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
        <ChatMessage role={msg.role as "user" | "assistant"} content={msg.content} {onOpenInEditor} />
      {/each}
      {#if isStreaming && streamingContent}
        <ChatMessage role="assistant" content={streamingContent} streaming={true} {streamProgress} {onOpenInEditor} />
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
</style>

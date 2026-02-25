<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import ChatInput from "./ChatInput.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import { streamChat } from "../lib/api";
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
    onApplyCode?: (code: string, language: string) => void;
    getFileContext?: () => { path: string; content: string; language: string } | null;
  }
  let { onApplyCode, getFileContext }: Props = $props();

  let conversation: Conversation = $state(createConversation("editor"));
  let streamingContent = $state("");
  let isStreaming = $state(false);
  let streamProgress: StreamProgress | undefined = $state(undefined);
  let abortController: AbortController | null = $state(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);

  let recentConversations: Conversation[] = $state([]);
  let showPicker = $state(false);

  onMount(async () => {
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
  });

  // Save current conversation when component unmounts (tab switch)
  onDestroy(() => {
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

  export async function sendMessage(text: string) {
    if (isStreaming) return;

    addMessage(conversation, "user", text);
    conversation = conversation;

    isStreaming = true;
    streamingContent = "";
    streamProgress = undefined;
    abortController = new AbortController();

    const fileContext = getFileContext?.();
    const systemMessages = fileContext
      ? [{ role: "system", content: `The user is editing ${fileContext.path} (${fileContext.language}). Current file content:\n\`\`\`${fileContext.language}\n${fileContext.content}\n\`\`\`` }]
      : [];

    const apiMessages = [
      ...systemMessages,
      ...conversation.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
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
      addMessage(conversation, "assistant", streamingContent);
      conversation = conversation;
      await saveConversation(conversation);
      localStorage.setItem("edgecoder-last-editor-id", conversation.id);
      await refreshConversationList();
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
    <ModelPicker
      selectedModel={conversation.selectedModel}
      onSelect={(model) => { conversation.selectedModel = model; conversation = conversation; }}
    />
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

  <div class="messages-scroll" bind:this={scrollContainer}>
    {#if conversation.messages.length === 0 && !isStreaming}
      <div class="empty-state">
        <p>Ask about your code, request changes, or get explanations.</p>
      </div>
    {:else}
      <div class="messages">
        {#each conversation.messages as msg (msg.id)}
          <ChatMessage
            role={msg.role as "user" | "assistant"}
            content={msg.content}
            onOpenInEditor={onApplyCode}
          />
        {/each}
        {#if isStreaming && streamingContent}
          <ChatMessage
            role="assistant"
            content={streamingContent}
            streaming={true}
            {streamProgress}
            onOpenInEditor={onApplyCode}
          />
        {/if}
      </div>
    {/if}
  </div>

  <div class="panel-input">
    <ChatInput onSend={handleSend} placeholder="Ask about your code..." disabled={isStreaming} />
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

  .panel-input {
    border-top: 0.5px solid var(--border);
    padding: 8px;
    flex-shrink: 0;
  }
</style>

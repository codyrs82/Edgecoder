<script lang="ts">
  import ChatMessage from "../components/ChatMessage.svelte";
  import { streamChat } from "../lib/api";
  import {
    createConversation,
    addMessage,
    saveConversation,
  } from "../lib/chat-store";
  import type { Conversation } from "../lib/types";

  let conversation: Conversation = $state(createConversation());
  let streamingContent = $state("");
  let isStreaming = $state(false);
  let abortController: AbortController | null = $state(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);

  const quickActions = [
    { label: "Fix a bug", prompt: "Help me fix a bug in my code" },
    { label: "Write tests", prompt: "Help me write tests" },
    { label: "Explain code", prompt: "Explain how this code works" },
  ];

  export async function sendMessage(text: string) {
    if (isStreaming) return;

    addMessage(conversation, "user", text);
    conversation = conversation; // trigger reactivity

    isStreaming = true;
    streamingContent = "";
    abortController = new AbortController();

    const apiMessages = conversation.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      await streamChat(
        apiMessages,
        (chunk) => {
          streamingContent += chunk;
          scrollToBottom();
        },
        abortController.signal,
      );
      addMessage(conversation, "assistant", streamingContent);
      conversation = conversation;
      await saveConversation(conversation);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        addMessage(conversation, "assistant", `Error: ${(err as Error).message}`);
        conversation = conversation;
      }
    } finally {
      streamingContent = "";
      isStreaming = false;
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
    conversation = createConversation();
    streamingContent = "";
    isStreaming = false;
    abortController = null;
  }

  function handleQuickAction(prompt: string) {
    sendMessage(prompt);
  }
</script>

<div class="chat-view" bind:this={scrollContainer}>
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
        <ChatMessage role={msg.role as "user" | "assistant"} content={msg.content} />
      {/each}
      {#if isStreaming && streamingContent}
        <ChatMessage role="assistant" content={streamingContent} streaming={true} />
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

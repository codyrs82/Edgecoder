<script lang="ts">
  import MarkdownRenderer from "./MarkdownRenderer.svelte";
  import StreamingIndicator from "./StreamingIndicator.svelte";
  import type { StreamProgress } from "../lib/api";

  interface Props {
    role: "user" | "assistant";
    content: string;
    streaming?: boolean;
    streamProgress?: StreamProgress;
    onOpenInEditor?: (code: string, language: string) => void;
  }
  let { role, content, streaming = false, streamProgress, onOpenInEditor }: Props = $props();
</script>

<div class="message {role}">
  {#if role === "user"}
    <div class="bubble user-bubble">{content}</div>
  {:else}
    <div class="bubble assistant-bubble">
      <MarkdownRenderer source={content} {onOpenInEditor} />
      {#if streaming}
        <StreamingIndicator progress={streamProgress} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .message {
    display: flex;
    margin-bottom: 16px;
    padding: 0 16px;
  }
  .message.user {
    justify-content: flex-end;
  }
  .message.assistant {
    justify-content: flex-start;
  }
  .bubble {
    max-width: 85%;
    border-radius: var(--radius-md);
    padding: 10px 14px;
  }
  .user-bubble {
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .assistant-bubble {
    color: var(--text-primary);
  }
  .message:hover {
    opacity: 1;
  }
</style>

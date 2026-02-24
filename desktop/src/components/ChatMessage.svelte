<script lang="ts">
  import MarkdownRenderer from "./MarkdownRenderer.svelte";
  import StreamingIndicator from "./StreamingIndicator.svelte";

  interface Props {
    role: "user" | "assistant";
    content: string;
    streaming?: boolean;
  }
  let { role, content, streaming = false }: Props = $props();
</script>

<div class="message {role}">
  {#if role === "user"}
    <div class="bubble user-bubble">{content}</div>
  {:else}
    <div class="bubble assistant-bubble">
      <MarkdownRenderer source={content} />
      {#if streaming}
        <StreamingIndicator />
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
    background: #1e3a5f;
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .assistant-bubble {
    color: var(--text-primary);
  }
</style>

<script lang="ts">
  // A conversation pane with real messages, the composer and "Add to chat", wired like the views.
  import ChatMessage from "../../src/components/ChatMessage.svelte";
  import ChatInput from "../../src/components/ChatInput.svelte";
  import QuoteSelection from "../../src/components/QuoteSelection.svelte";

  let { onSend = () => {}, long }: { onSend?: (m: string) => void; long?: string } = $props();
  let scope: HTMLDivElement | undefined = $state();
  let input: ChatInput | undefined = $state();
</script>

<div class="pane" data-testid="pane" bind:this={scope}>
  <ChatMessage role="user" content={"Why does the build fail?\nIt worked yesterday."} />
  <ChatMessage role="assistant" content={"The lockfile is stale.\nRun the install again.\n\n```ts\nconst x = 1;\n```"} />
  {#if long}<ChatMessage role="user" content={long} />{/if}
  <QuoteSelection {scope} onQuote={(b) => void input?.insertQuote(b)} />
</div>
<p data-testid="outside">Not part of the conversation.</p>
<ChatInput bind:this={input} {onSend} />

<script lang="ts">
  // #35: shown when the coordinator or portal can't be reached, instead of a silent spinner.
  import { onEndpointUnreachable, type EndpointUnreachableError } from "../lib/endpoints";

  let error: EndpointUnreachableError | null = $state(null);

  $effect(() => onEndpointUnreachable((e) => { error = e; }));
</script>

{#if error}
  <div class="endpoint-banner" role="alert">
    <span>
      {error.kind === "coordinator" ? "Coordinator" : "Portal"} unreachable at <code>{error.url}</code>. You can change it in Settings.
    </span>
    <button onclick={() => (error = null)} aria-label="Dismiss">×</button>
  </div>
{/if}

<style>
  .endpoint-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    background: var(--red, #b42318);
    color: #fff;
    font-size: 13px;
  }
  .endpoint-banner code {
    font-family: var(--font-mono, monospace);
  }
  .endpoint-banner button {
    background: none;
    border: none;
    color: inherit;
    font-size: 16px;
    cursor: pointer;
  }
</style>

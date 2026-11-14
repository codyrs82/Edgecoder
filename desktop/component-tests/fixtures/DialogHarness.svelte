<script lang="ts">
  import Dialog from "../../src/components/ui/Dialog.svelte";
  let { dismissible = true }: { dismissible?: boolean } = $props();
  let open = $state(false);
  let second: HTMLButtonElement | undefined = $state();
</script>

<button onclick={() => (open = true)}>Open</button>
{#if open}
  <Dialog label="Example" {dismissible} onClose={() => (open = false)} initialFocus={() => second}>
    <button>First</button>
    <button bind:this={second}>Second</button>
    <input aria-label="Name" />
  </Dialog>
{/if}

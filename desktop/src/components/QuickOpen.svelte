<script lang="ts">
  // #24: the "Go to file" palette, on the bits-ui Dialog and Command primitives. The search runs
  // on the IDE server, so Command's own filtering is off; it supplies the combobox/listbox
  // semantics and the arrow-key, Home/End and Enter handling.
  import { tick } from "svelte";
  import { Command } from "bits-ui";
  import { fsFind } from "../lib/api";
  import Dialog from "./ui/Dialog.svelte";

  interface Props {
    onOpen: (path: string) => void;
    onClose: () => void;
  }
  let { onOpen, onClose }: Props = $props();

  let query = $state("");
  let results = $state<string[]>([]);
  let command: { updateSelectedToIndex(index: number): void } | undefined = $state();
  const uid = $props.id();
  const listId = `${uid}-list`;
  let input: HTMLInputElement | null = $state(null);
  let seq = 0;

  async function search() {
    const s = ++seq;
    try {
      const found = (await fsFind(query, 30)).filter((m) => m.kind === "file").map((m) => m.path);
      if (s !== seq) return;
      results = found;
      // Results arrive after Command has settled on a highlight, so point it at the new first row.
      await tick();
      if (s === seq) command?.updateSelectedToIndex(0);
    } catch {
      results = [];
    }
  }

  $effect(() => {
    void query;
    void search();
  });

  function pick(path: string) {
    onClose();
    onOpen(path);
  }

  function parts(path: string): { dir: string; name: string } {
    const i = path.lastIndexOf("/");
    return { dir: i < 0 ? "" : path.slice(0, i), name: path.slice(i + 1) };
  }
</script>

<!-- restoreFocus off: the caller puts focus in the editor (or the file it just opened). -->
<Dialog variant="top" label="Go to file" escapeInFields restoreFocus={false} initialFocus={() => input} {onClose}>
  <Command.Root class="palette" label="File name" shouldFilter={false} loop bind:this={command}>
    <Command.Input class="palette-input" bind:ref={input} bind:value={query} placeholder="Go to file…">
      {#snippet child({ props })}
        <!-- bits-ui points aria-controls at its inner viewport; the listbox is what the field controls. -->
        <input {...props} aria-controls={listId} bind:value={query} />
      {/snippet}
    </Command.Input>
    <Command.List id={listId} class="palette-results" aria-label="Files">
      <Command.Viewport>
        {#each results as path (path)}
          {@const p = parts(path)}
          <Command.Item class="ui-command-item palette-item" value={path} onSelect={() => pick(path)}>
            <span class="name">{p.name}</span>
            <span class="dir">{p.dir}</span>
          </Command.Item>
        {/each}
      </Command.Viewport>
    </Command.List>
    {#if results.length === 0}
      <div class="empty" role="status">{query ? "No matching files" : "Type to search the project"}</div>
    {/if}
  </Command.Root>
</Dialog>

<style>
  /* The bits-ui parts are child components, so their classes are matched globally. */
  :global(.palette) {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  :global(.palette-input) {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 14px;
    border: none;
    border-bottom: 0.5px solid var(--border);
    background: transparent;
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
  }
  :global(.palette-results) {
    max-height: 50vh;
    overflow-y: auto;
    padding: 4px;
  }
  :global(.palette-item) {
    align-items: baseline;
    gap: 10px;
    color: var(--text-secondary);
  }
  :global(.palette-item[data-selected]) {
    color: var(--text-primary);
  }
  .name {
    font-size: 13px;
    white-space: nowrap;
  }
  .dir {
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    padding: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
</style>

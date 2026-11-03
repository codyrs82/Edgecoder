<script lang="ts">
  import { tick } from "svelte";
  import { fsFind } from "../lib/api";

  interface Props {
    onOpen: (path: string) => void;
    onClose: () => void;
  }
  let { onOpen, onClose }: Props = $props();

  let query = $state("");
  let results = $state<string[]>([]);
  let picked = $state(0);
  let input: HTMLInputElement | undefined = $state(undefined);
  let seq = 0;

  async function search() {
    const s = ++seq;
    try {
      const found = (await fsFind(query, 30)).filter((m) => m.kind === "file").map((m) => m.path);
      if (s !== seq) return;
      results = found;
      picked = 0;
    } catch {
      results = [];
    }
  }

  $effect(() => {
    void query;
    void search();
  });

  $effect(() => {
    void tick().then(() => input?.focus());
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) picked = (picked + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = results[picked];
      if (p) {
        onClose();
        onOpen(p);
      }
    }
  }

  function parts(path: string): { dir: string; name: string } {
    const i = path.lastIndexOf("/");
    return { dir: i < 0 ? "" : path.slice(0, i), name: path.slice(i + 1) };
  }
</script>

<div class="backdrop" role="presentation" onclick={onClose}></div>
<div class="palette" role="dialog" aria-label="Go to file">
  <input bind:this={input} bind:value={query} placeholder="Go to file…" onkeydown={onKey} aria-label="File name" />
  <div class="results" role="listbox">
    {#each results as path, i (path)}
      {@const p = parts(path)}
      <button
        role="option"
        aria-selected={i === picked}
        class:picked={i === picked}
        onmousedown={(e) => { e.preventDefault(); onClose(); onOpen(path); }}
      >
        <span class="name">{p.name}</span>
        <span class="dir">{p.dir}</span>
      </button>
    {:else}
      <div class="empty">{query ? "No matching files" : "Type to search the project"}</div>
    {/each}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
  }
  .palette {
    position: fixed;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(640px, 90vw);
    z-index: 91;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }
  input {
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
  .results {
    max-height: 50vh;
    overflow-y: auto;
    padding: 4px;
  }
  button {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: none;
    border-radius: var(--radius-sm);
    text-align: left;
    cursor: pointer;
    color: var(--text-secondary);
  }
  button.picked {
    background: var(--bg-surface);
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

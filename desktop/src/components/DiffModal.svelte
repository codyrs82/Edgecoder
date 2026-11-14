<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import Dialog from "./ui/Dialog.svelte";
  import { detectLanguage } from "../lib/editor-store";
  import { onThemeChange, resolvedTheme } from "../lib/theme";
  import { monacoThemeDataOrBase } from "../lib/monaco-theme";
  import tokens from "@edgecoder/tokens/tokens.json";

  interface Props {
    path: string;
    /** null: the file did not exist before / does not exist now. */
    before: string | null;
    after: string | null;
    onClose: () => void;
    /** Put this file back as it was before (shown when provided). */
    onUndo?: () => void;
  }
  let { path, before, after, onClose, onUndo }: Props = $props();

  let container: HTMLDivElement | undefined = $state(undefined);
  let diffEditor: any = null;
  let models: any[] = [];
  let offTheme: (() => void) | undefined;

  onMount(async () => {
    await import("../lib/monaco-setup");
    const monaco = await import("monaco-editor");
    monaco.editor.defineTheme("edgecoder-dark", monacoThemeDataOrBase(tokens, "dark"));
    monaco.editor.defineTheme("edgecoder-light", monacoThemeDataOrBase(tokens, "light"));
    offTheme = onThemeChange((t) => monaco.editor.setTheme(`edgecoder-${t}`));
    // The dialog renders in a portal, so make sure its body exists before Monaco needs it.
    await tick();
    if (!container) return;
    const language = detectLanguage(path);
    const original = monaco.editor.createModel(before ?? "", language);
    const modified = monaco.editor.createModel(after ?? "", language);
    models = [original, modified];
    diffEditor = monaco.editor.createDiffEditor(container, {
      theme: `edgecoder-${resolvedTheme()}`,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: tokens.font.mono,
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    diffEditor.setModel({ original, modified });
  });

  onDestroy(() => {
    offTheme?.();
    diffEditor?.dispose();
    for (const m of models) m.dispose();
  });

  let label = $derived(before === null ? "new file" : after === null ? "deleted" : "modified");
</script>

<Dialog variant="inset" label="Changes to {path}" {onClose}>
  <header>
    <div class="title">
      <span class="path">{path}</span>
      <span class="label">{label}</span>
    </div>
    <div class="buttons">
      {#if onUndo}<button class="undo" onclick={onUndo}>Undo this file</button>{/if}
      <button onclick={onClose}>Close</button>
    </div>
  </header>
  <div class="sides"><span>Before</span><span>After</span></div>
  <div class="diff" bind:this={container}></div>
</Dialog>

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 0.5px solid var(--border);
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .path {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label {
    font-size: 11px;
    color: var(--text-muted);
  }
  .buttons {
    display: flex;
    gap: 8px;
  }
  button {
    padding: 5px 12px;
    border-radius: var(--radius-sm);
    border: 0.5px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 12px;
  }
  button.undo:hover {
    border-color: var(--red);
    color: var(--red);
  }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    font-size: 11px;
    color: var(--text-muted);
    padding: 4px 14px;
    border-bottom: 0.5px solid var(--border);
  }
  .diff {
    flex: 1;
    min-height: 0;
  }
</style>

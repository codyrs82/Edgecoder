<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import FileExplorer from "../components/FileExplorer.svelte";
  import { createFile, type EditorFile } from "../lib/editor-store";

  let editorContainer: HTMLDivElement | undefined = $state(undefined);
  let editor: any = $state(null);
  let monaco: any = $state(null);

  let files: EditorFile[] = $state([
    createFile("main.py", '# Welcome to EdgeCoder\nprint("Hello, world!")'),
  ]);
  let activeFilePath: string | null = $state("main.py");
  let explorerWidth = $state(200);

  let activeFile = $derived(files.find((f) => f.path === activeFilePath) ?? null);

  onMount(async () => {
    const mon = await import("monaco-editor");
    monaco = mon;

    mon.editor.defineTheme("edgecoder-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#1a1a1a",
        "editor.foreground": "#e8e6e3",
        "editorLineNumber.foreground": "#6b6960",
        "editorLineNumber.activeForeground": "#9a9892",
        "editor.selectionBackground": "#264f78",
        "editor.lineHighlightBackground": "#252525",
        "editorCursor.foreground": "#3b82f6",
      },
    });

    if (editorContainer) {
      editor = mon.editor.create(editorContainer, {
        value: activeFile?.content ?? "",
        language: activeFile?.language ?? "plaintext",
        theme: "edgecoder-dark",
        minimap: { enabled: false },
        fontSize: 14,
        fontFamily: "SF Mono, Fira Code, Cascadia Code, monospace",
        lineNumbers: "on",
        renderLineHighlight: "line",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12 },
      });

      editor.onDidChangeModelContent(() => {
        if (activeFile) {
          activeFile.content = editor.getValue();
          activeFile.dirty = true;
          files = files;
        }
      });
    }
  });

  onDestroy(() => {
    editor?.dispose();
  });

  function selectFile(path: string) {
    activeFilePath = path;
    const file = files.find((f) => f.path === path);
    if (file && editor && monaco) {
      const model = monaco.editor.createModel(file.content, file.language);
      editor.setModel(model);
    }
  }

  export function openFile(path: string, content: string) {
    const existing = files.find((f) => f.path === path);
    if (existing) {
      existing.content = content;
      files = files;
      selectFile(path);
    } else {
      const newFile = createFile(path, content);
      files = [...files, newFile];
      selectFile(path);
    }
  }
</script>

<div class="editor-layout">
  <div class="explorer-panel" style="width: {explorerWidth}px">
    <FileExplorer {files} activeFile={activeFilePath} onSelect={selectFile} />
  </div>
  <div class="editor-panel">
    {#if activeFile}
      <div class="tab-bar">
        {#each files as file}
          <button
            class="file-tab {activeFilePath === file.path ? 'active' : ''}"
            onclick={() => selectFile(file.path)}
          >
            {file.path.split("/").pop()}{file.dirty ? " *" : ""}
          </button>
        {/each}
      </div>
    {/if}
    <div class="monaco-container" bind:this={editorContainer}></div>
  </div>
</div>

<style>
  .editor-layout {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .explorer-panel {
    border-right: 1px solid var(--border);
    flex-shrink: 0;
    overflow: hidden;
  }
  .editor-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tab-bar {
    display: flex;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .file-tab {
    padding: 8px 16px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    white-space: nowrap;
    transition: all 0.1s;
  }
  .file-tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
    background: var(--bg-base);
  }
  .file-tab:hover:not(.active) {
    color: var(--text-primary);
  }
  .monaco-container {
    flex: 1;
  }
</style>

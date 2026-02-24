<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import FileExplorer from "../components/FileExplorer.svelte";
  import EditorChatPanel from "../components/EditorChatPanel.svelte";
  import { createFile, type EditorFile } from "../lib/editor-store";

  let editorContainer: HTMLDivElement | undefined = $state(undefined);
  let editor: any = $state(null);
  let monaco: any = $state(null);

  let files: EditorFile[] = $state([
    createFile("main.py", '# Welcome to EdgeCoder\nprint("Hello, world!")'),
  ]);
  let activeFilePath: string | null = $state("main.py");
  let explorerWidth = $state(200);

  let chatPanelWidth = $state(380);
  let chatPanelVisible = $state(true);
  let isResizing = $state(false);
  let editorChatPanel: EditorChatPanel | undefined = $state(undefined);

  let activeFile = $derived(files.find((f) => f.path === activeFilePath) ?? null);

  onMount(async () => {
    // Restore chat panel state from localStorage
    const savedVisible = localStorage.getItem("edgecoder-chat-visible");
    if (savedVisible !== null) chatPanelVisible = savedVisible === "true";
    const savedWidth = localStorage.getItem("edgecoder-chat-width");
    if (savedWidth !== null) chatPanelWidth = Math.max(280, Number(savedWidth));

    const mon = await import("monaco-editor");
    monaco = mon;

    mon.editor.defineTheme("edgecoder-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#262624",
        "editor.foreground": "#f7f5f0",
        "editorLineNumber.foreground": "#8a8478",
        "editorLineNumber.activeForeground": "#b8b0a4",
        "editor.selectionBackground": "#5a4a3a",
        "editor.lineHighlightBackground": "#2f2f2d",
        "editorCursor.foreground": "#c17850",
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

  export function getActiveFileContext(): { path: string; content: string; language: string } | null {
    if (!activeFile) return null;
    return { path: activeFile.path, content: activeFile.content, language: activeFile.language };
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

  export function toggleChatPanel() {
    chatPanelVisible = !chatPanelVisible;
    localStorage.setItem("edgecoder-chat-visible", String(chatPanelVisible));
  }

  function handleApplyCode(code: string, language: string) {
    const extMap: Record<string, string> = {
      python: "py", javascript: "js", typescript: "ts",
      rust: "rs", go: "go", html: "html", css: "css", json: "json",
    };
    if (activeFile) {
      activeFile.content = code;
      activeFile.dirty = true;
      files = files;
      if (editor) editor.setValue(code);
    } else {
      const ext = extMap[language] || "txt";
      openFile(`snippet.${ext}`, code);
    }
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    isResizing = true;
    const startX = e.clientX;
    const startWidth = chatPanelWidth;

    function onMouseMove(e: MouseEvent) {
      const delta = startX - e.clientX;
      chatPanelWidth = Math.max(280, Math.min(startWidth + delta, window.innerWidth * 0.5));
    }

    function onMouseUp() {
      isResizing = false;
      localStorage.setItem("edgecoder-chat-width", String(chatPanelWidth));
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }
</script>

<div class="editor-layout" class:resizing={isResizing}>
  <div class="explorer-panel" style="width: {explorerWidth}px">
    <FileExplorer {files} activeFile={activeFilePath} onSelect={selectFile} />
  </div>
  <div class="editor-panel">
    <div class="tab-bar">
      {#each files as file}
        <button
          class="file-tab {activeFilePath === file.path ? 'active' : ''}"
          onclick={() => selectFile(file.path)}
        >
          {file.path.split("/").pop()}{file.dirty ? " *" : ""}
        </button>
      {/each}
      <div class="tab-bar-spacer"></div>
      <button
        class="toggle-chat-btn"
        class:chat-active={chatPanelVisible}
        onclick={toggleChatPanel}
        title={chatPanelVisible ? "Hide chat" : "Show chat"}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
        </svg>
      </button>
    </div>
    <div class="monaco-container" bind:this={editorContainer}></div>
  </div>
  {#if chatPanelVisible}
    <div class="resize-handle" onmousedown={startResize}></div>
    <div class="chat-panel" style="width: {chatPanelWidth}px">
      <EditorChatPanel
        bind:this={editorChatPanel}
        onApplyCode={handleApplyCode}
        getFileContext={getActiveFileContext}
      />
    </div>
  {/if}
</div>

<style>
  .editor-layout {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .editor-layout.resizing {
    cursor: col-resize;
    user-select: none;
  }
  .explorer-panel {
    border-right: 0.5px solid var(--border);
    flex-shrink: 0;
    overflow: hidden;
  }
  .editor-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 200px;
  }
  .tab-bar {
    display: flex;
    align-items: center;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .tab-bar-spacer {
    flex: 1;
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
  .toggle-chat-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-right: 8px;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .toggle-chat-btn:hover {
    color: var(--accent);
    background: var(--bg-elevated);
  }
  .toggle-chat-btn.chat-active {
    color: var(--accent);
  }
  .monaco-container {
    flex: 1;
  }
  .resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .resize-handle:hover,
  .resize-handle:active {
    background: var(--accent);
  }
  .chat-panel {
    flex-shrink: 0;
    border-left: 0.5px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-base);
    position: relative;
  }
</style>

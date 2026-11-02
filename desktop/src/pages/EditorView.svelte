<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import FileTree from "../components/FileTree.svelte";
  import QuickOpen from "../components/QuickOpen.svelte";
  import TerminalPanel from "../components/TerminalPanel.svelte";
  import EditorChatPanel from "../components/EditorChatPanel.svelte";
  import { createFile, detectLanguage, type EditorFile } from "../lib/editor-store";
  import { fsRead, fsWrite, fsStat, fsGitStatus, FsError, ideInlineEdit, ideComplete } from "../lib/api";
  import { registerAutocomplete } from "../lib/autocomplete";
  import { InlineEditController } from "../lib/inline-edit-session";
  import { onThemeChange, resolvedTheme } from "../lib/theme";
  import { monacoThemeDataOrBase } from "../lib/monaco-theme";
  import tokens from "@edgecoder/tokens/tokens.json";

  interface Props {
    projectRoot?: string | null;
    onOpenProject?: () => void;
  }
  let { projectRoot = null, onOpenProject }: Props = $props();

  /** Prefix for buffers that are not (yet) a project file, e.g. code opened from chat. */
  const UNTITLED = "untitled:";
  const POLL_MS = 2000;

  let editorContainer: HTMLDivElement | undefined = $state(undefined);
  let editor: any = $state(null);
  let monaco: any = $state(null);
  /** One Monaco model per open file, so each tab keeps its undo history, cursor and scroll. */
  const models = new Map<string, any>();
  const viewStates = new Map<string, unknown>();

  let files: EditorFile[] = $state([]);
  let activeFilePath: string | null = $state(null);
  let gitBranch: string | null = $state(null);
  let gitFiles: Record<string, string> = $state({});
  let treeRefresh = $state(0);
  let notice: { kind: "error" | "info"; text: string } | null = $state(null);
  let explorerWidth = $state(240);

  let chatPanelWidth = $state(380);
  let chatPanelVisible = $state(true);
  let isResizing = $state(false);
  let editorChatPanel: EditorChatPanel | undefined = $state(undefined);

  let activeFile = $derived(files.find((f) => f.path === activeFilePath) ?? null);

  let offTheme: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let inlineEdit: InlineEditController | undefined;
  let autocomplete: { dispose: () => void } | undefined;
  let autocompleteOn = $state(true);
  let quickOpen = $state(false);
  /** Bottom terminal panel: mounted on first open, then kept (hidden) so the shell survives. */
  let terminalOpen = $state(false);
  let terminalMounted = $state(false);
  let terminalHeight = $state(240);
  let terminalPanel: TerminalPanel | undefined = $state(undefined);

  function toggleTerminal() {
    terminalOpen = !terminalOpen;
    if (terminalOpen) {
      terminalMounted = true;
      setTimeout(() => terminalPanel?.focus(), 30);
    } else {
      editor?.focus();
    }
  }
  /** Suppresses the dirty flag while the editor itself loads content into a model. */
  let applyingExternal = false;

  function showNotice(text: string, kind: "error" | "info" = "error") {
    notice = { kind, text };
    if (kind === "info") setTimeout(() => { if (notice?.text === text) notice = null; }, 4000);
  }

  onMount(async () => {
    const savedVisible = localStorage.getItem("edgecoder-chat-visible");
    if (savedVisible !== null) chatPanelVisible = savedVisible === "true";
    const savedWidth = localStorage.getItem("edgecoder-chat-width");
    if (savedWidth !== null) chatPanelWidth = Math.max(280, Number(savedWidth));
    const savedExplorer = localStorage.getItem("edgecoder-explorer-width");
    if (savedExplorer !== null) explorerWidth = Math.max(160, Number(savedExplorer));

    // #11: register bundled workers first so Monaco never needs eval/blob loaders.
    await import("../lib/monaco-setup");
    const mon = await import("monaco-editor");
    monaco = mon;

    // #25: both editor themes come from the shared design tokens.
    mon.editor.defineTheme("edgecoder-dark", monacoThemeDataOrBase(tokens, "dark"));
    mon.editor.defineTheme("edgecoder-light", monacoThemeDataOrBase(tokens, "light"));
    offTheme = onThemeChange((t) => mon.editor.setTheme(`edgecoder-${t}`));

    if (editorContainer) {
      editor = mon.editor.create(editorContainer, {
        model: null,
        theme: `edgecoder-${resolvedTheme()}`,
        minimap: { enabled: false },
        fontSize: 14,
        fontFamily: tokens.font.mono,
        lineNumbers: "on",
        renderLineHighlight: "line",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12 },
        inlineSuggest: { enabled: true, mode: "subwordSmart" },
      });
      editor.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.KeyS, () => void saveActive());
      editor.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.KeyW, () => { if (activeFilePath) void closeFile(activeFilePath); });
      editor.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.KeyP, () => { if (projectRoot) quickOpen = true; });
      editor.addCommand(mon.KeyMod.WinCtrl | mon.KeyCode.Backquote, () => toggleTerminal());
      inlineEdit = new InlineEditController(
        editor,
        mon,
        (body) => ideInlineEdit(body),
        () => activeFilePath?.replace(UNTITLED, "") ?? null,
        (m) => showNotice(m),
      );
      try { autocompleteOn = localStorage.getItem("edgecoder-autocomplete") !== "off"; } catch { /* storage unavailable */ }
      autocomplete = registerAutocomplete(mon, editor, {
        request: (prefix, suffix, signal) => ideComplete(prefix, suffix, signal),
        enabled: () => autocompleteOn && Boolean(activeFilePath),
        onUnavailable: (m) => showNotice(m, "info"),
      });
    }
    pollTimer = setInterval(() => void pollDisk(), POLL_MS);
  });

  onDestroy(() => {
    offTheme?.();
    autocomplete?.dispose();
    if (pollTimer) clearInterval(pollTimer);
    for (const m of models.values()) m.dispose();
    models.clear();
    editor?.dispose();
  });

  // A different project closes everything from the old one.
  let loadedRoot: string | null = null;
  $effect(() => {
    const root = projectRoot;
    if (root === loadedRoot) return;
    loadedRoot = root;
    untrack(() => resetForProject(root));
  });

  function resetForProject(root: string | null) {
    for (const m of models.values()) m.dispose();
    models.clear();
    viewStates.clear();
    files = files.filter((f) => f.path.startsWith(UNTITLED));
    activeFilePath = files[0]?.path ?? null;
    if (editor) editor.setModel(activeFilePath ? models.get(activeFilePath) ?? null : null);
    gitFiles = {};
    gitBranch = null;
    if (root) void refreshGit();
  }

  function modelFor(file: EditorFile): any {
    let model = models.get(file.path);
    if (!model && monaco) {
      const uri = monaco.Uri.from({ scheme: file.path.startsWith(UNTITLED) ? "untitled" : "file", path: `/${file.path.replace(UNTITLED, "")}` });
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(file.content, file.language, uri);
      model.onDidChangeContent(() => {
        if (applyingExternal) return;
        const f = files.find((x) => x.path === file.path);
        if (!f) return;
        f.content = model.getValue();
        f.dirty = f.content !== f.savedContent || f.path.startsWith(UNTITLED);
      });
      models.set(file.path, model);
    }
    return model;
  }

  function showFile(path: string) {
    inlineEdit?.cancel();
    if (editor && activeFilePath && models.has(activeFilePath)) viewStates.set(activeFilePath, editor.saveViewState());
    activeFilePath = path;
    const file = files.find((f) => f.path === path);
    if (!file || !editor) return;
    editor.setModel(modelFor(file));
    const vs = viewStates.get(path);
    if (vs) editor.restoreViewState(vs);
    editor.focus();
  }

  /** Open a project file from disk (or switch to it if it's already open). */
  export async function openPath(path: string, line?: number) {
    if (!files.some((f) => f.path === path)) {
      try {
        const disk = await fsRead(path);
        files = [...files, createFile(path, disk.content, disk.mtimeMs)];
      } catch (e) {
        showNotice(e instanceof FsError && e.code === "binary" ? `${path} is a binary file.` : `Couldn't open ${path}: ${(e as Error).message}`);
        return;
      }
    }
    showFile(path);
    if (line && editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
  }

  async function saveActive() {
    const file = activeFile;
    if (!file) return;
    if (file.path.startsWith(UNTITLED)) return saveUntitled(file);
    await saveFile(file, false);
  }

  async function saveFile(file: EditorFile, force: boolean) {
    try {
      const res = await fsWrite(file.path, file.content, force ? undefined : file.mtimeMs);
      file.savedContent = file.content;
      file.mtimeMs = res.mtimeMs;
      file.dirty = false;
      file.diskChanged = false;
      file.missing = false;
      void refreshGit();
    } catch (e) {
      if (e instanceof FsError && e.code === "conflict") {
        file.diskChanged = true;
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const overwrite = await ask(`${file.path} was changed on disk (by the agent or another program) since you opened it.\n\nOverwrite it with your version?`, {
          title: "File changed on disk",
          kind: "warning",
          okLabel: "Overwrite",
          cancelLabel: "Keep editing",
        });
        if (overwrite) await saveFile(file, true);
        return;
      }
      showNotice(`Couldn't save ${file.path}: ${(e as Error).message}`);
    }
  }

  async function saveUntitled(file: EditorFile) {
    if (!projectRoot) {
      showNotice("Open a project folder to save this file.");
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const name = file.path.slice(UNTITLED.length);
    const target = await save({ defaultPath: `${projectRoot}/${name}`, title: "Save in project" });
    if (!target) return;
    const root = projectRoot.replace(/\/+$/, "");
    if (!target.startsWith(`${root}/`)) {
      showNotice("Save the file inside the open project folder.");
      return;
    }
    const rel = target.slice(root.length + 1);
    try {
      const res = await fsWrite(rel, file.content);
      const content = file.content;
      await closeFile(file.path, true);
      files = [...files, createFile(rel, content, res.mtimeMs)];
      showFile(rel);
      treeRefresh++;
      void refreshGit();
    } catch (e) {
      showNotice(`Couldn't save ${rel}: ${(e as Error).message}`);
    }
  }

  async function closeFile(path: string, force = false) {
    const file = files.find((f) => f.path === path);
    if (!file) return;
    if (file.dirty && !force) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const discard = await ask(`${path.replace(UNTITLED, "")} has unsaved changes. Close it and lose them?`, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard",
        cancelLabel: "Cancel",
      });
      if (!discard) return;
    }
    const idx = files.findIndex((f) => f.path === path);
    files = files.filter((f) => f.path !== path);
    models.get(path)?.dispose();
    models.delete(path);
    viewStates.delete(path);
    if (activeFilePath === path) {
      const next = files[Math.min(idx, files.length - 1)];
      activeFilePath = null;
      if (next) showFile(next.path);
      else editor?.setModel(null);
    }
  }

  /** Replace a model's text as one undoable edit, without marking the file dirty. */
  function setModelText(path: string, text: string) {
    const model = models.get(path);
    if (!model || model.getValue() === text) return;
    applyingExternal = true;
    try {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    } finally {
      applyingExternal = false;
    }
  }

  /** Pick up changes made on disk (by the agent, git or another editor) to open files. */
  async function pollDisk() {
    if (!projectRoot || document.hidden) return;
    const open = files.filter((f) => !f.path.startsWith(UNTITLED));
    if (open.length === 0) return;
    let mtimes: Record<string, number | null>;
    try {
      mtimes = await fsStat(open.map((f) => f.path));
    } catch {
      return;
    }
    let changed = false;
    for (const f of open) {
      const m = mtimes[f.path];
      if (m === undefined) continue;
      if (m === null) {
        if (!f.missing) { f.missing = true; changed = true; }
        continue;
      }
      if (f.mtimeMs !== undefined && Math.abs(m - f.mtimeMs) <= 1) continue;
      changed = true;
      if (f.dirty) {
        f.diskChanged = true;
        continue;
      }
      await reloadFromDisk(f);
    }
    if (changed) {
      treeRefresh++;
      void refreshGit();
    }
  }

  async function reloadFromDisk(f: EditorFile) {
    try {
      const disk = await fsRead(f.path);
      f.content = disk.content;
      f.savedContent = disk.content;
      f.mtimeMs = disk.mtimeMs;
      f.dirty = false;
      f.diskChanged = false;
      f.missing = false;
      setModelText(f.path, disk.content);
    } catch {
      f.missing = true;
    }
  }

  async function refreshGit() {
    if (!projectRoot) return;
    try {
      const st = await fsGitStatus();
      gitBranch = st.branch;
      gitFiles = st.files;
    } catch {
      // not fatal: the tree just shows no markers
    }
  }

  function handleRenamed(from: string, to: string) {
    for (const f of files) {
      if (f.path === from || f.path.startsWith(`${from}/`)) {
        const newPath = to + f.path.slice(from.length);
        const model = models.get(f.path);
        models.delete(f.path);
        // Monaco models are keyed by URI; reopen under the new name with the same text.
        const content = model?.getValue() ?? f.content;
        model?.dispose();
        f.path = newPath;
        f.language = detectLanguage(newPath);
        f.content = content;
        if (activeFilePath === from || activeFilePath?.startsWith(`${from}/`)) activeFilePath = newPath;
      }
    }
    files = [...files];
    if (activeFilePath) showFile(activeFilePath);
    void refreshGit();
  }

  function handleDeleted(path: string) {
    for (const f of [...files]) if (f.path === path || f.path.startsWith(`${path}/`)) void closeFile(f.path, true);
    void refreshGit();
  }

  /** The open file and selection, for the chat panel. */
  export function getActiveFileContext(): { path: string; content: string; language: string; selection?: { text: string; startLine: number; endLine: number } } | null {
    if (!activeFile) return null;
    let selection: { text: string; startLine: number; endLine: number } | undefined;
    const sel = editor?.getSelection();
    const model = editor?.getModel();
    if (sel && model && !sel.isEmpty()) {
      selection = { text: model.getValueInRange(sel), startLine: sel.startLineNumber, endLine: sel.endLineNumber };
    }
    return { path: activeFile.path.replace(UNTITLED, ""), content: activeFile.content, language: activeFile.language, ...(selection ? { selection } : {}) };
  }

  /** Open code (e.g. from chat) in a new untitled buffer. */
  export function openFile(path: string, content: string) {
    let name = path.replace(UNTITLED, "");
    let key = `${UNTITLED}${name}`;
    for (let n = 2; files.some((f) => f.path === key); n++) {
      const dot = name.lastIndexOf(".");
      key = `${UNTITLED}${dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`}`;
    }
    const file = createFile(key, content);
    file.dirty = true;
    files = [...files, file];
    showFile(key);
  }

  /** Called when the agent reports it changed files: reload clean buffers now rather than at the next poll. */
  export function onAgentChangedFiles() {
    void pollDisk();
    treeRefresh++;
  }

  export function toggleChatPanel() {
    chatPanelVisible = !chatPanelVisible;
    localStorage.setItem("edgecoder-chat-visible", String(chatPanelVisible));
  }

  function handleApplyCode(code: string, language: string) {
    if (activeFile && models.has(activeFile.path)) {
      // One undoable edit; the file stays unsaved until the user saves it.
      const model = models.get(activeFile.path);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: code }], () => null);
      editor?.focus();
    } else {
      const ext: Record<string, string> = { python: "py", javascript: "js", typescript: "ts", rust: "rs", go: "go", html: "html", css: "css", json: "json" };
      openFile(`snippet.${ext[language] || "txt"}`, code);
    }
  }

  function startResize(e: MouseEvent, which: "chat" | "explorer") {
    e.preventDefault();
    isResizing = true;
    const startX = e.clientX;
    const startWidth = which === "chat" ? chatPanelWidth : explorerWidth;

    function onMouseMove(e: MouseEvent) {
      if (which === "chat") chatPanelWidth = Math.max(280, Math.min(startWidth + (startX - e.clientX), window.innerWidth * 0.5));
      else explorerWidth = Math.max(160, Math.min(startWidth + (e.clientX - startX), window.innerWidth * 0.4));
    }

    function onMouseUp() {
      isResizing = false;
      localStorage.setItem(which === "chat" ? "edgecoder-chat-width" : "edgecoder-explorer-width", String(which === "chat" ? chatPanelWidth : explorerWidth));
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function startTerminalResize(e: MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const start = terminalHeight;
    const move = (ev: MouseEvent) => { terminalHeight = Math.max(100, Math.min(start + (startY - ev.clientY), window.innerHeight * 0.7)); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function tabName(path: string): string {
    return path.replace(UNTITLED, "").split("/").pop() ?? path;
  }
</script>

<svelte:window onkeydown={(e) => {
  // Cmd/Ctrl+P anywhere in the editor tab (the Monaco command covers the editor itself).
  // The editor stays mounted (hidden) while another tab shows; only act when it is visible.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p" && projectRoot && !quickOpen && editorContainer?.offsetParent) {
    e.preventDefault();
    quickOpen = true;
  }
  // Ctrl+` toggles the terminal (from the terminal itself too).
  if (e.ctrlKey && e.key === "`" && editorContainer?.offsetParent) {
    e.preventDefault();
    toggleTerminal();
  }
}} />

{#if quickOpen}
  <QuickOpen onOpen={(p) => void openPath(p)} onClose={() => { quickOpen = false; editor?.focus(); }} />
{/if}

<div class="editor-layout" class:resizing={isResizing}>
  <div class="explorer-panel" style="width: {explorerWidth}px">
    {#if projectRoot}
      <FileTree
        {projectRoot}
        activePath={activeFilePath}
        {gitFiles}
        refreshKey={treeRefresh}
        onOpen={(p) => void openPath(p)}
        onRenamed={handleRenamed}
        onDeleted={handleDeleted}
        onError={(m) => showNotice(m)}
      />
    {:else}
      <div class="no-project">
        <p>No folder open</p>
        <button class="open-btn" onclick={() => onOpenProject?.()}>Open Folder…</button>
      </div>
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (mouse drag handle for resizing) -->

  <div class="resize-handle" role="separator" aria-orientation="vertical" onmousedown={(e) => startResize(e, "explorer")}></div>
  <div class="editor-panel">
    <div class="tab-bar">
      {#each files as file (file.path)}
        <div class="file-tab" class:active={activeFilePath === file.path} title={file.path.replace(UNTITLED, "")}>
          <button class="tab-label" onclick={() => showFile(file.path)}>
            <span class:missing={file.missing}>{tabName(file.path)}</span>
          </button>
          <button class="tab-close" aria-label="Close {tabName(file.path)}" onclick={() => void closeFile(file.path)}>
            {#if file.dirty}<span class="dirty-dot">●</span>{:else}×{/if}
          </button>
        </div>
      {/each}
      <div class="tab-bar-spacer"></div>
      {#if gitBranch}<span class="branch" title="Git branch">⎇ {gitBranch}</span>{/if}
      <button class="ac-toggle" class:on={terminalOpen} title="Terminal (Ctrl+`)" onclick={toggleTerminal}>Terminal</button>
      <button
        class="ac-toggle"
        class:on={autocompleteOn}
        title={autocompleteOn ? "AI autocomplete on (Tab accepts). Click to turn off." : "AI autocomplete off. Click to turn on."}
        onclick={() => { autocompleteOn = !autocompleteOn; try { localStorage.setItem("edgecoder-autocomplete", autocompleteOn ? "on" : "off"); } catch { /* storage unavailable */ } }}
      >AI {autocompleteOn ? "✓" : "–"}</button>
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
    {#if notice}
      <div class="notice" class:error={notice.kind === "error"} role="status">
        <span>{notice.text}</span>
        <button aria-label="Dismiss" onclick={() => (notice = null)}>×</button>
      </div>
    {/if}
    {#if activeFile?.diskChanged}
      <div class="notice" role="status">
        <span>{activeFile.path} changed on disk. Your unsaved edits are kept.</span>
        <button onclick={() => activeFile && void reloadFromDisk(activeFile)}>Reload from disk</button>
      </div>
    {:else if activeFile?.missing}
      <div class="notice" role="status"><span>{activeFile.path} was deleted or moved on disk. Save to recreate it.</span></div>
    {/if}
    <div class="monaco-wrap" style={terminalOpen ? `flex: 1 1 0; min-height: 80px` : ""}>
      <div class="monaco-container" bind:this={editorContainer}></div>
      {#if files.length === 0}
        <div class="editor-empty">
          {#if projectRoot}
            <p>Open a file from the tree, or ask the agent in the chat panel.</p>
            <p class="hint">⌘P go to file · ⌘K edit with AI · Tab accepts suggestions · Ctrl+` terminal · ⌘S save</p>
          {:else}
            <p>Open a folder to start.</p>
            <button class="open-btn" onclick={() => onOpenProject?.()}>Open Folder…</button>
          {/if}
        </div>
      {/if}
    </div>
    {#if terminalMounted}
      <div class="terminal-section" class:hidden={!terminalOpen} style="height: {terminalHeight}px">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions (mouse drag handle for resizing) -->

        <div class="terminal-resize" role="separator" aria-orientation="horizontal" onmousedown={startTerminalResize}></div>
        <div class="terminal-bar">
          <span>Terminal</span>
          <button title="Hide (Ctrl+`)" aria-label="Hide terminal" onclick={toggleTerminal}>×</button>
        </div>
        <div class="terminal-body"><TerminalPanel bind:this={terminalPanel} cwd={projectRoot} /></div>
      </div>
    {/if}
  </div>
  {#if chatPanelVisible}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (mouse drag handle for resizing) -->

    <div class="resize-handle" role="separator" aria-orientation="vertical" onmousedown={(e) => startResize(e, "chat")}></div>
    <div class="chat-panel" style="width: {chatPanelWidth}px">
      <EditorChatPanel
        bind:this={editorChatPanel}
        {projectRoot}
        onApplyCode={handleApplyCode}
        getFileContext={getActiveFileContext}
        onFilesChanged={onAgentChangedFiles}
        onOpenPath={(p) => void openPath(p)}
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
    flex-shrink: 0;
    overflow: hidden;
    background: var(--bg-base);
  }
  .no-project {
    padding: 24px 16px;
    font-size: 13px;
    color: var(--text-muted);
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .open-btn {
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    border: 0.5px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 13px;
  }
  .open-btn:hover {
    border-color: var(--accent);
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
    min-height: 34px;
  }
  .tab-bar-spacer {
    flex: 1;
  }
  .file-tab {
    display: flex;
    align-items: center;
    border-bottom: 2px solid transparent;
    border-right: 0.5px solid var(--border);
    white-space: nowrap;
  }
  .file-tab.active {
    border-bottom-color: var(--accent);
    background: var(--bg-base);
  }
  .tab-label {
    padding: 8px 4px 8px 12px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .file-tab.active .tab-label,
  .tab-label:hover {
    color: var(--text-primary);
  }
  .missing {
    text-decoration: line-through;
  }
  .tab-close {
    width: 20px;
    height: 20px;
    margin-right: 6px;
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    font-size: 14px;
    line-height: 1;
  }
  .tab-close:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
  .dirty-dot {
    font-size: 10px;
    color: var(--accent);
  }
  .branch {
    font-size: 11px;
    color: var(--text-muted);
    margin-right: 10px;
    white-space: nowrap;
  }
  .ac-toggle {
    border: 0.5px solid var(--border);
    background: none;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    font-size: 11px;
    padding: 2px 6px;
    margin-right: 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .ac-toggle.on {
    color: var(--accent);
    border-color: var(--accent);
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
  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    font-size: 12px;
    background: var(--bg-elevated);
    border-bottom: 0.5px solid var(--border);
    color: var(--text-secondary);
  }
  .notice.error {
    color: var(--danger, #f85149);
  }
  .notice button {
    border: 0.5px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    cursor: pointer;
    font-size: 12px;
  }
  .monaco-wrap {
    flex: 1;
    position: relative;
    display: flex;
  }
  .terminal-section {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-top: 0.5px solid var(--border);
    position: relative;
  }
  .terminal-section.hidden {
    display: none;
  }
  .terminal-resize {
    position: absolute;
    top: -3px;
    left: 0;
    right: 0;
    height: 6px;
    cursor: row-resize;
    z-index: 2;
  }
  .terminal-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 8px 2px 12px;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .terminal-bar button {
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 14px;
  }
  .terminal-body {
    flex: 1;
    min-height: 0;
  }
  .monaco-container {
    flex: 1;
  }
  .editor-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-muted);
    font-size: 13px;
    background: var(--bg-base);
  }
  .hint {
    font-size: 11px;
  }
  .resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background 0.15s;
    border-left: 0.5px solid var(--border);
  }
  .resize-handle:hover,
  .resize-handle:active {
    background: var(--accent);
  }
  .chat-panel {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-base);
    position: relative;
  }
</style>

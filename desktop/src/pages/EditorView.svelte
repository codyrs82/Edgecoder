<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { setBusy as setRestartBusy, clearBusy as clearRestartBusy } from "../lib/auto-restart";
  import { Popover, Tabs } from "bits-ui";
  import { Settings2, PanelRight, PanelLeft, Globe, Columns2, SquareTerminal, Sparkles, TriangleAlert, GitBranch, X, RotateCw } from "@lucide/svelte";
  import { notify } from "../lib/toast";
  import FileTree from "../components/FileTree.svelte";
  import Select from "../components/ui/Select.svelte";
  import QuickOpen from "../components/QuickOpen.svelte";
  import TerminalPanel from "../components/TerminalPanel.svelte";
  import SourceControl from "../components/SourceControl.svelte";
  import EditorChatPanel from "../components/EditorChatPanel.svelte";
  import { createFile, detectLanguage, type EditorFile } from "../lib/editor-store";
  import { fsRead, fsWrite, fsStat, fsGitStatus, FsError, ideInlineEdit, ideComplete, ideDiagnostics, ideProjectTrust, ideSetProjectTrust, idePreviewUrl, type Diagnostic } from "../lib/api";
  import { registerAutocomplete } from "../lib/autocomplete";
  import { loadEditorSettings, saveEditorSettings, monacoOptions, type EditorSettings } from "../lib/editor-settings";
  import { InlineEditController } from "../lib/inline-edit-session";
  import { onThemeChange, resolvedTheme } from "../lib/theme";
  import { monacoThemeDataOrBase } from "../lib/monaco-theme";
  import tokens from "@edgecoder/tokens/tokens.json";

  interface Props {
    projectRoot?: string | null;
    /** Open a folder (the picker). */
    onOpenProject?: () => void;
    /** The IDE server already opened this folder (a clone): show it. */
    onProjectOpened?: (root: string) => void;
    /** No project: open this recent one. */
    onPickProject?: (root: string) => void;
    onNewProject?: () => void;
    onClone?: () => void;
    onConnectGitHub?: () => void;
    /** The coding chat showing changed. */
    onConversationChange?: (id: string) => void;
    /** Told when the view has nothing to edit (no files and editor showing): the chat then takes the room. */
    onBareChange?: (bare: boolean) => void;
  }
  let { projectRoot = null, onOpenProject, onProjectOpened, onPickProject, onNewProject, onClone, onConnectGitHub, onConversationChange, onBareChange }: Props = $props();

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
  const restartKey = `editor:${Math.random().toString(36).slice(2)}`;
  $effect(() => {
    setRestartBusy(restartKey, files.some((f) => f.dirty) && "unsaved");
    return () => clearRestartBusy(restartKey);
  });
  let activeFilePath: string | null = $state(null);
  let gitBranch: string | null = $state(null);
  let gitFiles: Record<string, string> = $state({});
  let treeRefresh = $state(0);
  let explorerWidth = $state(240);

  let chatPanelWidth = $state(380);
  let chatPanelVisible = $state(true);
  let isResizing = $state(false);
  let editorChatPanel: EditorChatPanel | undefined = $state(undefined);

  let activeFile = $derived(files.find((f) => f.path === activeFilePath) ?? null);
  /** The files and editor beside the chat. Hidden, the chat takes the whole view (like a chat-first IDE). */
  let workspaceOpen = $state(readWorkspacePref());
  let explorerOpen = $state(true);
  function readWorkspacePref(): boolean {
    try {
      const v = localStorage.getItem("edgecoder-workspace-open");
      if (v !== null) return v === "true";
    } catch { /* storage unavailable */ }
    // Chat first, like Claude Code: the files and editor come in when a file opens or on the toggle.
    return false;
  }
  function setWorkspaceOpen(open: boolean) {
    workspaceOpen = open;
    try { localStorage.setItem("edgecoder-workspace-open", String(open)); } catch { /* storage unavailable */ }
  }
  /** Nothing to edit, or the editor is put away: the chat gets the whole view. */
  const bare = $derived(projectRoot ? !workspaceOpen : files.length === 0);
  $effect(() => {
    onBareChange?.(bare);
  });

  let offTheme: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let inlineEdit: InlineEditController | undefined;
  let autocomplete: { dispose: () => void } | undefined;
  let autocompleteOn = $state(true);
  let quickOpen = $state(false);
  let sidebarView = $state<"files" | "git">("files");
  /** Live preview of the project's web page, beside the editor; reloads when files change. */
  let previewUrl = $state<string | null>(null);
  let previewNonce = $state(0);

  export async function openPreview(path = "") {
    try {
      previewUrl = await idePreviewUrl(path || (activeFilePath && /\.html?$/.test(activeFilePath) ? activeFilePath : ""));
    } catch (e) {
      showNotice(`Couldn't open the preview: ${(e as Error).message}`);
    }
  }
  $effect(() => {
    void treeRefresh;
    if (previewUrl) previewNonce++;
  });
  let editorSettings = $state<EditorSettings>(loadEditorSettings());
  let settingsOpen = $state(false);

  function updateSettings(patch: Partial<EditorSettings>) {
    editorSettings = { ...editorSettings, ...patch };
    saveEditorSettings(editorSettings);
    const opts = monacoOptions(editorSettings);
    editor?.updateOptions(opts);
    splitEditor?.updateOptions(opts);
    for (const m of models.values()) m.updateOptions({ tabSize: editorSettings.tabSize });
  }
  /** Split view: a second editor on the same models (edits show in both). */
  let splitPath = $state<string | null>(null);
  let splitContainer: HTMLDivElement | undefined = $state(undefined);
  let splitEditor: any = null;

  function openSplit() {
    if (!activeFilePath || !monaco) return;
    splitPath = activeFilePath;
  }

  function closeSplit() {
    splitEditor?.dispose();
    splitEditor = null;
    splitPath = null;
  }

  // Create the split editor once its container exists, and follow splitPath.
  $effect(() => {
    const path = splitPath;
    const host = splitContainer;
    if (!path || !host || !monaco) return;
    const file = untrack(() => files.find((f) => f.path === path));
    if (!file) return;
    if (!splitEditor) {
      splitEditor = monaco.editor.create(host, {
        model: null,
        theme: `edgecoder-${resolvedTheme()}`,
        ...monacoOptions(editorSettings),
        fontFamily: tokens.font.mono,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12 },
      });
      splitEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        const f = files.find((x) => x.path === splitPath);
        if (f) void (f.path.startsWith(UNTITLED) ? saveUntitled(f) : saveFile(f, false));
      });
    }
    splitEditor.setModel(untrack(() => modelFor(file)));
  });
  /** Problems from the project's checkers, by project-relative path. */
  let problems = $state<Record<string, Diagnostic[]>>({});
  let problemCount = $derived(Object.values(problems).reduce((n, ds) => n + ds.filter((d) => d.severity !== "info").length, 0));
  let checking = $state(false);
  const CHECKED = /\.((m|c)?[jt]sx?|py|rs)$/;

  // Workspace trust: the project's own checkers (tsc, cargo) run code from the folder, so the IDE
  // server skips them until the user trusts it. null = not known (older server, no project yet).
  let projectTrusted = $state<boolean | null>(null);
  /** The trust notice is showing; "Not now" hides it for this folder until it is opened again. */
  let trustPrompt = $state(false);
  let trustDeclined = false;
  let trustBusy = $state(false);

  async function refreshTrust(root: string) {
    try {
      const t = await ideProjectTrust();
      if (projectRoot !== root || t.projectRoot === null) return;
      projectTrusted = t.trusted;
      if (!t.trusted && !trustDeclined) trustPrompt = true;
    } catch {
      // older IDE server without trust, or no project yet: nothing to show
    }
  }

  async function setTrust(trusted: boolean) {
    trustBusy = true;
    try {
      const t = await ideSetProjectTrust(trusted);
      projectTrusted = t.trusted;
      trustPrompt = false;
      if (t.trusted) void runDiagnostics(files.map((f) => f.path));
    } catch (e) {
      showNotice(`Couldn't change folder trust: ${(e as Error).message ?? String(e)}`);
    } finally {
      trustBusy = false;
    }
  }

  /** Run the checkers for these files and show their problems on every open file. */
  async function runDiagnostics(paths: string[]) {
    if (!editorSettings.diagnostics) return;
    const targets = paths.filter((p) => CHECKED.test(p) && !p.startsWith(UNTITLED));
    if (!projectRoot || targets.length === 0 || !monaco) return;
    checking = true;
    try {
      const r = await ideDiagnostics(targets);
      if (r.untrusted?.length) {
        projectTrusted = false;
        if (!trustDeclined) trustPrompt = true;
      }
      // A whole-project checker (tsc) reports every file: the count is the project's, and the
      // checked files' old problems are replaced by this run's.
      const next: Record<string, Diagnostic[]> = { ...problems };
      for (const p of targets) delete next[p];
      for (const [p, ds] of Object.entries(r.byPath)) next[p] = ds;
      problems = next;
      for (const f of files) {
        const model = models.get(f.path);
        if (!model) continue;
        const ds = problems[f.path] ?? [];
        monaco.editor.setModelMarkers(model, "edgecoder", ds.map((d) => ({
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.endLine ?? d.line,
          endColumn: d.endColumn ?? model.getLineMaxColumn(Math.min(d.line, model.getLineCount())),
          message: `${d.message} [${d.source}]`,
          severity: d.severity === "error" ? monaco.MarkerSeverity.Error : d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        })));
      }
    } catch {
      // checkers are best effort
    } finally {
      checking = false;
    }
  }

  /** Jump to the next problem in the open files. */
  function nextProblem() {
    const entries = Object.entries(problems).filter(([, ds]) => ds.length);
    if (!entries.length) return;
    const [path, ds] = entries.find(([p]) => p !== activeFilePath) ?? entries[0];
    void openPath(path, ds[0].line);
  }
  let changeCount = $derived(Object.keys(gitFiles).length);
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

  /** One editor message at a time: a new one replaces the last (#24: a toast, not a banner). */
  function showNotice(text: string, kind: "error" | "info" = "error") {
    notify(text, kind, "editor-notice");
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

    // The project's tsc reports type errors (runDiagnostics); Monaco only sees open files, so its own
    // semantic checks would flag every import. Keep its syntax checks.
    const tsApi = (mon as any).typescript ?? (mon as any).languages?.typescript;
    for (const d of [tsApi?.typescriptDefaults, tsApi?.javascriptDefaults]) d?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });

    // #25: both editor themes come from the shared design tokens.
    mon.editor.defineTheme("edgecoder-dark", monacoThemeDataOrBase(tokens, "dark"));
    mon.editor.defineTheme("edgecoder-light", monacoThemeDataOrBase(tokens, "light"));
    offTheme = onThemeChange((t) => mon.editor.setTheme(`edgecoder-${t}`));

    if (editorContainer) {
      editor = mon.editor.create(editorContainer, {
        model: null,
        theme: `edgecoder-${resolvedTheme()}`,
        ...monacoOptions(editorSettings),
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
        request: (prefix, suffix, signal) => ideComplete(prefix, suffix, signal, editorSettings.completionModel || undefined),
        enabled: () => autocompleteOn && Boolean(activeFilePath),
        onUnavailable: (m) => showNotice(m, "info"),
      });
    }
    pollTimer = setInterval(() => void pollDisk(), POLL_MS);
  });

  onDestroy(() => {
    offTheme?.();
    autocomplete?.dispose();
    splitEditor?.dispose();
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
    untrack(() => {
      projectTrusted = null;
      trustPrompt = false;
      trustDeclined = false;
      resetForProject(root);
      if (root) void refreshTrust(root);
    });
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
      model.updateOptions({ tabSize: editorSettings.tabSize });
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
    const model = modelFor(file);
    editor.setModel(model);
    const ds = problems[path];
    if (ds && monaco && monaco.editor.getModelMarkers({ resource: model.uri, owner: "edgecoder" }).length === 0 && ds.length) {
      monaco.editor.setModelMarkers(model, "edgecoder", ds.map((d) => ({
        startLineNumber: d.line, startColumn: d.column, endLineNumber: d.endLine ?? d.line,
        endColumn: d.endColumn ?? model.getLineMaxColumn(Math.min(d.line, model.getLineCount())),
        message: `${d.message} [${d.source}]`,
        severity: d.severity === "error" ? monaco.MarkerSeverity.Error : d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      })));
    }
    const vs = viewStates.get(path);
    if (vs) editor.restoreViewState(vs);
    editor.focus();
  }

  /** Open a project file from disk (or switch to it if it's already open). */
  export async function openPath(path: string, line?: number) {
    if (!workspaceOpen) setWorkspaceOpen(true);
    if (!files.some((f) => f.path === path)) {
      try {
        const disk = await fsRead(path);
        files = [...files, createFile(path, disk.content, disk.mtimeMs)];
        if (!problems[path]) setTimeout(() => void runDiagnostics([path]), 0);
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
      treeRefresh++;
      void runDiagnostics([file.path]);
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
    if (splitPath === path) closeSplit();
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
    if (projectRoot && !workspaceOpen) setWorkspaceOpen(true);
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

  /** The coding chat: a new one in the open project, a saved one, or a note in the current one. */
  export const newChat = () => editorChatPanel?.newChat();
  export const openChat = (id: string) => editorChatPanel?.openChat(id);
  export const addNote = (text: string) => editorChatPanel?.addNote(text);

  /** Uncommitted changes: Source Control beside the chat. */
  function reviewChanges() {
    setWorkspaceOpen(true);
    explorerOpen = true;
    sidebarView = "git";
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

<div class="editor-layout" class:resizing={isResizing} class:bare>
  {#if !bare && explorerOpen}
  <div class="explorer-panel" style="width: {explorerWidth}px">
    {#if projectRoot}
      <!-- #24: bits-ui Tabs. Only the open view is mounted, as before. -->
      <Tabs.Root class="contents" bind:value={sidebarView}>
        <Tabs.List aria-label="Sidebar">
          {#snippet child({ props })}
            <div {...props} class="sidebar-tabs">
              <Tabs.Trigger value="files">Files</Tabs.Trigger>
              <Tabs.Trigger value="git">Source Control{#if changeCount}<span class="count">{changeCount}</span>{/if}</Tabs.Trigger>
            </div>
          {/snippet}
        </Tabs.List>
        <Tabs.Content value={sidebarView} tabindex={-1}>
          {#snippet child({ props })}
            <div {...props} class="sidebar-body">
              {#if sidebarView === "git"}
                <SourceControl
                  refreshKey={treeRefresh}
                  onOpen={(p) => void openPath(p)}
                  onChanged={() => { onAgentChangedFiles(); void refreshGit(); }}
                  onError={(m) => showNotice(m)}
                  onInfo={(m) => { showNotice(m, "info"); void refreshGit(); }}
                  onProjectOpened={(root) => onProjectOpened?.(root)}
                />
              {:else}
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
              {/if}
            </div>
          {/snippet}
        </Tabs.Content>
      </Tabs.Root>
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (mouse drag handle for resizing) -->

  <div class="resize-handle" role="separator" aria-orientation="vertical" onmousedown={(e) => startResize(e, "explorer")}></div>
  {/if}
  <div class="editor-panel" class:hidden={bare}>
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
      <div class="tools">
        {#if projectRoot}
          <button class="icon-btn" class:on={explorerOpen} aria-pressed={explorerOpen} title={explorerOpen ? "Hide files" : "Show files"} aria-label="Files" onclick={() => (explorerOpen = !explorerOpen)}><PanelLeft size={16} /></button>
        {/if}
        {#if gitBranch}<span class="branch" title="Git branch"><GitBranch size={13} /> {gitBranch}</span>{/if}
        {#if checking}
          <span class="branch" title="Running the project's checkers">Checking…</span>
        {:else if problemCount}
          <button class="btn btn--ghost btn--sm problems" title="{problemCount} problem(s) from the project's checkers. Click for the next one." onclick={nextProblem}><TriangleAlert size={13} /> {problemCount}</button>
        {/if}
        {#if projectRoot}
          <button class="icon-btn" class:on={Boolean(previewUrl)} aria-pressed={Boolean(previewUrl)} title={previewUrl ? "Close the preview" : "Preview the project's web page (index.html, or the open .html file)"} aria-label="Preview" onclick={() => (previewUrl ? (previewUrl = null) : void openPreview())}><Globe size={16} /></button>
        {/if}
        {#if activeFile}
          <button class="icon-btn" class:on={Boolean(splitPath)} aria-pressed={Boolean(splitPath)} title={splitPath ? "Close split view" : "Split: show a second file side by side"} aria-label="Split" onclick={() => (splitPath ? closeSplit() : openSplit())}><Columns2 size={16} /></button>
        {/if}
        <button class="icon-btn" class:on={terminalOpen} aria-pressed={terminalOpen} title="Terminal (Ctrl+`)" aria-label="Terminal" onclick={toggleTerminal}><SquareTerminal size={16} /></button>
        <button
          class="icon-btn"
          class:on={autocompleteOn}
          aria-pressed={autocompleteOn}
          aria-label="AI autocomplete"
          title={autocompleteOn ? "AI autocomplete on (Tab accepts). Click to turn off." : "AI autocomplete off. Click to turn on."}
          onclick={() => { autocompleteOn = !autocompleteOn; try { localStorage.setItem("edgecoder-autocomplete", autocompleteOn ? "on" : "off"); } catch { /* storage unavailable */ } }}
        ><Sparkles size={16} /></button>
        <!-- #24: a bits-ui Popover: closes on Escape or a click away and returns focus to the button. -->
        <Popover.Root bind:open={settingsOpen}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <button {...props} class="icon-btn" class:on={settingsOpen} title="Editor settings" aria-label="Editor settings"><Settings2 size={16} /></button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content class="ui-popup settings-pop" role="dialog" aria-label="Editor settings" align="end" sideOffset={6} collisionPadding={8}>
              <label>Font size <input type="number" min="10" max="28" value={editorSettings.fontSize} onchange={(e) => updateSettings({ fontSize: Number((e.target as HTMLInputElement).value) })} /></label>
              <label>Tab size <input type="number" min="1" max="8" value={editorSettings.tabSize} onchange={(e) => updateSettings({ tabSize: Number((e.target as HTMLInputElement).value) })} /></label>
              <label class="check"><input type="checkbox" checked={editorSettings.wordWrap} onchange={(e) => updateSettings({ wordWrap: (e.target as HTMLInputElement).checked })} /> Word wrap</label>
              <label class="check"><input type="checkbox" checked={editorSettings.minimap} onchange={(e) => updateSettings({ minimap: (e.target as HTMLInputElement).checked })} /> Minimap</label>
              <label class="check"><input type="checkbox" checked={editorSettings.diagnostics} onchange={(e) => updateSettings({ diagnostics: (e.target as HTMLInputElement).checked })} /> Check files on open and save</label>
              {#if projectRoot && projectTrusted !== null}
                <label class="check" title="Lets this folder's own TypeScript and Rust checkers run. They run code from the folder."><input type="checkbox" checked={projectTrusted} disabled={trustBusy} onchange={(e) => void setTrust((e.target as HTMLInputElement).checked)} /> Trust this folder (run its own checkers)</label>
              {/if}
              <label>Autocomplete model <input type="text" placeholder="qwen2.5-coder:1.5b" value={editorSettings.completionModel} onchange={(e) => updateSettings({ completionModel: (e.target as HTMLInputElement).value })} /></label>
              <p class="settings-note">A coder model that can fill in the middle (qwen2.5-coder). Bigger is better but slower.</p>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <span class="tools-sep" aria-hidden="true"></span>
        <button class="icon-btn" class:on={chatPanelVisible} aria-pressed={chatPanelVisible} onclick={toggleChatPanel} title={chatPanelVisible ? "Hide chat" : "Show chat"} aria-label="Chat panel">
          <PanelRight size={16} />
        </button>
      </div>
    </div>
    {#if trustPrompt && projectRoot}
      <div class="notice" role="status" data-testid="trust-notice">
        <span>TypeScript/Rust checks are off for this folder because they would run code from it. Trust this folder?</span>
        <span class="notice-actions">
          <button disabled={trustBusy} onclick={() => void setTrust(true)}>Trust</button>
          <button disabled={trustBusy} onclick={() => { trustDeclined = true; trustPrompt = false; }}>Not now</button>
        </span>
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
      {#if previewUrl}
        <div class="split-pane">
          <div class="split-bar">
            <span class="preview-label" title={previewUrl}>Preview</span>
            <button class="icon-btn icon-btn--sm" title="Reload" aria-label="Reload preview" onclick={() => previewNonce++}><RotateCw size={14} /></button>
            <button class="icon-btn icon-btn--sm" title="Close preview" aria-label="Close preview" onclick={() => (previewUrl = null)}><X size={14} /></button>
          </div>
          {#key previewNonce}
            <!-- Project content: it may run scripts, but never navigate or take over the app window. -->
            <iframe class="preview-frame" title="Preview" src={previewUrl} sandbox="allow-scripts allow-forms allow-same-origin allow-modals"></iframe>
          {/key}
        </div>
      {/if}
      {#if splitPath}
        <div class="split-pane">
          <div class="split-bar">
            <Select
              class="ui-select--sm ui-select--fill"
              ariaLabel="File in split view"
              value={splitPath ?? undefined}
              onChange={(p) => (splitPath = p)}
              options={files.map((f) => ({ value: f.path, label: `${tabName(f.path)}${f.dirty ? " ●" : ""}` }))}
            />
            <button class="icon-btn icon-btn--sm" title="Close split" aria-label="Close split" onclick={closeSplit}><X size={14} /></button>
          </div>
          <div class="split-editor" bind:this={splitContainer}></div>
        </div>
      {/if}
      {#if files.length === 0 && projectRoot}
        <div class="editor-empty">
          <p>Open a file from the tree, or ask the agent in the chat panel.</p>
          <p class="hint"><kbd>⌘P</kbd> go to file · <kbd>⌘K</kbd> edit with AI · <kbd>Tab</kbd> accept · <kbd>⌃`</kbd> terminal · <kbd>⌘S</kbd> save</p>
        </div>
      {/if}
    </div>
    {#if terminalMounted}
      <div class="terminal-section" class:hidden={!terminalOpen} style="height: {terminalHeight}px">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions (mouse drag handle for resizing) -->

        <div class="terminal-resize" role="separator" aria-orientation="horizontal" onmousedown={startTerminalResize}></div>
        <div class="terminal-bar">
          <span>Terminal</span>
          <button class="icon-btn icon-btn--sm" title="Hide (Ctrl+`)" aria-label="Hide terminal" onclick={toggleTerminal}><X size={14} /></button>
        </div>
        <div class="terminal-body"><TerminalPanel bind:this={terminalPanel} cwd={projectRoot} /></div>
      </div>
    {/if}
  </div>
  {#if chatPanelVisible || bare}
    {#if !bare}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (mouse drag handle for resizing) -->
      <div class="resize-handle" role="separator" aria-orientation="vertical" onmousedown={(e) => startResize(e, "chat")}></div>
    {/if}
    <div class="chat-panel" class:wide={bare} style={bare ? "" : `width: ${chatPanelWidth}px`}>
      <EditorChatPanel
        bind:this={editorChatPanel}
        wide={bare}
        {projectRoot}
        gitRefreshKey={treeRefresh}
        {onPickProject}
        {onNewProject}
        onOpenFolder={onOpenProject}
        {onClone}
        {onConnectGitHub}
        onReviewChanges={reviewChanges}
        {workspaceOpen}
        onToggleWorkspace={() => setWorkspaceOpen(!workspaceOpen)}
        {onConversationChange}
        onApplyCode={handleApplyCode}
        getFileContext={getActiveFileContext}
        onFilesChanged={onAgentChangedFiles}
        onOpenPath={(p) => void openPath(p)}
        onPreview={(p) => void openPreview(p)}
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
    background: var(--bg-deep);
  }
  .explorer-panel {
    display: flex;
    flex-direction: column;
  }
  .sidebar-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 36px;
    padding: 0 6px;
    border-bottom: 0.5px solid var(--border);
    flex-shrink: 0;
  }
  .sidebar-tabs :global(button) {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--control-sm);
    padding: 0 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: 500;
    cursor: pointer;
  }
  .sidebar-tabs :global(button:hover) {
    color: var(--text-primary);
  }
  .sidebar-tabs :global(button[data-state="active"]) {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
  .count {
    background: var(--bg-surface);
    border-radius: 999px;
    padding: 0 5px;
    font-size: var(--fs-2xs);
    line-height: 16px;
  }
  .sidebar-body {
    flex: 1;
    min-height: 0;
  }
  .editor-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 200px;
  }
  /* Kept mounted (Monaco lives here) but out of the way while there is nothing to edit. */
  .editor-panel.hidden {
    display: none;
  }
  .tab-bar {
    display: flex;
    align-items: center;
    background: var(--bg-base);
    border-bottom: 0.5px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
    height: 36px;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px 0 8px;
    flex-shrink: 0;
  }
  .tools-sep {
    width: 0.5px;
    height: 16px;
    margin: 0 4px;
    background: var(--border-strong);
  }
  .tools .problems {
    color: var(--yellow);
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
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 6px;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  /* Portalled to <body> by bits-ui, outside this component's scope. */
  :global {
    .settings-pop {
      width: min(270px, calc(100vw - 16px));
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary);
    }
    .settings-pop label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .settings-pop label.check {
      justify-content: flex-start;
    }
    .settings-pop input[type="number"] {
      width: 56px;
    }
    .settings-pop input[type="text"] {
      width: 140px;
    }
    .settings-pop input[type="number"],
    .settings-pop input[type="text"] {
      background: var(--bg-base);
      color: var(--text-primary);
      border: 0.5px solid var(--border-control);
      border-radius: var(--radius-sm);
      padding: 2px 6px;
      font-size: 12px;
    }
    .settings-pop .settings-note {
      margin: 0;
      font-size: 11px;
      color: var(--text-muted);
    }
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
  .notice-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
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
    height: 32px;
    padding: 0 6px 0 12px;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text-secondary);
  }
  .terminal-body {
    flex: 1;
    min-height: 0;
  }
  .monaco-container {
    flex: 1;
    min-width: 0;
  }
  .split-pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-left: 0.5px solid var(--border);
  }
  .split-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 36px;
    padding: 0 6px 0 10px;
    border-bottom: 0.5px solid var(--border);
    background: var(--bg-base);
  }
  .preview-label {
    flex: 1;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text-secondary);
  }
  .preview-frame {
    flex: 1;
    width: 100%;
    border: none;
    /* Pages without their own background expect the browser's white canvas, in either theme. */
    background: #fff;
  }
  .split-editor {
    flex: 1;
    min-height: 0;
  }
  .editor-empty p {
    margin: 0;
  }
  .editor-empty kbd {
    font-family: inherit;
    padding: 1px 5px;
    border: 0.5px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-secondary);
  }
  .editor-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    /* Keeps the repository form off the pane edges when the pane is narrow. */
    padding: 0 12px;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    background: var(--bg-base);
  }
  .hint {
    font-size: var(--fs-xs);
    color: var(--text-muted);
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
  .chat-panel.wide {
    flex: 1;
    min-width: 0;
  }
  /* #29: the side panels keep their dragged widths until the window is too narrow for all three. */
  @media (max-width: 860px) {
    .explorer-panel { max-width: 26vw; }
    .chat-panel { max-width: 40vw; }
  }
</style>

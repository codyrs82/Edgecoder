// Inline edit (Cmd+K) in Monaco: a prompt box above the selection, then the model's replacement
// applied as a reviewable diff. Removed lines show in red above the added (green) lines; each
// change has accept/reject buttons, and Cmd+Enter / Esc accept or reject everything left.
// The edit is applied to the buffer right away (one undo step) and is not saved until the user saves.
import { diffLines } from "./line-diff";

export interface InlineEditRequestBody {
  path: string;
  language: string;
  prefix: string;
  selection: string;
  suffix: string;
  instruction: string;
}

type Monaco = any;
type Editor = any;

const PREFIX_CHARS = 4000;
const SUFFIX_CHARS = 2000;
let stylesInjected = false;
let widgetSeq = 0;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
  .ec-ie-added { background: rgba(46, 160, 67, 0.18); }
  .ec-ie-added-gutter { border-left: 3px solid rgba(46, 160, 67, 0.9); }
  .ec-ie-removed { background: rgba(248, 81, 73, 0.14); color: var(--text-muted, #8b949e); text-decoration: line-through; white-space: pre; overflow: hidden; font-family: inherit; }
  .ec-ie-removed div { padding-left: 4px; border-left: 3px solid rgba(248, 81, 73, 0.9); }
  .ec-ie-box { width: max-content; white-space: nowrap; display: flex; gap: 6px; align-items: center; padding: 4px; border-radius: 6px; background: var(--bg-elevated, #1f242c); border: 1px solid var(--accent, #e8963b); box-shadow: 0 4px 16px rgba(0,0,0,.35); font: 12px system-ui, sans-serif; color: var(--text-primary, #e6edf3); z-index: 20; }
  .ec-ie-box input { width: 380px; border: none; outline: none; background: transparent; color: inherit; font: 13px system-ui, sans-serif; padding: 4px 6px; }
  .ec-ie-box button { border: 1px solid var(--border, #30363d); background: var(--bg-surface, #161b22); color: inherit; border-radius: 4px; padding: 2px 8px; cursor: pointer; font: 12px system-ui, sans-serif; }
  .ec-ie-box button:hover { border-color: var(--accent, #e8963b); }
  .ec-ie-box .muted { color: var(--text-muted, #8b949e); }
  .ec-ie-hunk { width: max-content; white-space: nowrap; display: flex; gap: 4px; margin-left: 16px; }
  .ec-ie-hunk button { border: 1px solid var(--border, #30363d); background: var(--bg-surface, #161b22); color: var(--text-primary, #e6edf3); border-radius: 4px; padding: 0 6px; cursor: pointer; font: 11px system-ui, sans-serif; line-height: 16px; }
  .ec-ie-hunk button.ok:hover { border-color: rgba(46,160,67,.9); }
  .ec-ie-hunk button.no:hover { border-color: rgba(248,81,73,.9); }
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}

interface Hunk {
  oldLines: string[];
  newCount: number;
  /** Tracks the added lines (or, for a pure deletion, the point where lines were removed). */
  decorations: any;
  zoneId: string | null;
  widget: any;
}

export class InlineEditController {
  private active = false;
  private disposers: Array<() => void> = [];
  private hunks: Hunk[] = [];
  private activeKey: any;

  constructor(
    private readonly editor: Editor,
    private readonly monaco: Monaco,
    private readonly request: (body: InlineEditRequestBody) => Promise<string>,
    private readonly getPath: () => string | null,
    private readonly onError: (message: string) => void,
  ) {
    injectStyles();
    this.activeKey = editor.createContextKey("ecInlineEdit", false);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => this.start());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => this.finish(true), "ecInlineEdit");
    editor.addCommand(monaco.KeyCode.Escape, () => this.finish(false), "ecInlineEdit");
  }

  /** Open the prompt for the current selection (whole lines) or the cursor line. */
  start() {
    const model = this.editor.getModel();
    const path = this.getPath();
    if (!model || !path) return;
    if (this.active) this.finish(true);
    const sel = this.editor.getSelection();
    const m = this.monaco;
    let startLine = sel.startLineNumber;
    let endLine = sel.endLineNumber;
    // A selection ending at column 1 doesn't include that line.
    if (!sel.isEmpty() && sel.endColumn === 1 && endLine > startLine) endLine--;
    let range: any;
    let selection: string;
    if (sel.isEmpty()) {
      const blank = model.getLineContent(startLine).trim() === "";
      if (blank) {
        // Fill the blank line.
        range = new m.Range(startLine, 1, startLine, model.getLineMaxColumn(startLine));
        selection = "";
      } else {
        // Insert below the cursor line.
        startLine += 1;
        range = startLine <= model.getLineCount()
          ? new m.Range(startLine, 1, startLine, 1)
          : new m.Range(startLine - 1, model.getLineMaxColumn(startLine - 1), startLine - 1, model.getLineMaxColumn(startLine - 1));
        selection = "";
      }
      endLine = startLine - 1;
    } else {
      range = endLine < model.getLineCount()
        ? new m.Range(startLine, 1, endLine + 1, 1)
        : new m.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
      selection = model.getValueInRange(range);
    }
    const atEof = range.startLineNumber === range.endLineNumber && range.startColumn > 1;
    this.showPrompt(Math.max(1, Math.min(startLine, model.getLineCount())), async (instruction) => {
      const full = model.getValue();
      const startOffset = model.getOffsetAt(range.getStartPosition());
      const endOffset = model.getOffsetAt(range.getEndPosition());
      const body: InlineEditRequestBody = {
        path,
        language: model.getLanguageId(),
        prefix: full.slice(Math.max(0, startOffset - PREFIX_CHARS), startOffset),
        selection,
        suffix: full.slice(endOffset, endOffset + SUFFIX_CHARS),
        instruction,
      };
      let replacement = await this.request(body);
      if (!selection && replacement && !atEof && !replacement.endsWith("\n")) replacement += "\n";
      if (atEof && replacement) replacement = `\n${replacement}`;
      if (replacement === selection) {
        this.onError("The model returned the code unchanged.");
        return;
      }
      this.applyDiff(range, selection, replacement, instruction, atEof);
    });
  }

  private showPrompt(line: number, submit: (instruction: string) => Promise<void>) {
    const m = this.monaco;
    const box = document.createElement("div");
    box.className = "ec-ie-box";
    const input = document.createElement("input");
    input.placeholder = "Edit selection… (Enter to generate, Esc to cancel)";
    const status = document.createElement("span");
    status.className = "muted";
    box.append(input, status);
    const widget = {
      getId: () => "ec.inlineEdit.prompt",
      getDomNode: () => box,
      getPosition: () => ({ position: { lineNumber: line, column: 1 }, preference: [m.editor.ContentWidgetPositionPreference.ABOVE, m.editor.ContentWidgetPositionPreference.BELOW] }),
    };
    this.editor.addContentWidget(widget);
    const close = () => {
      this.editor.removeContentWidget(widget);
      this.editor.focus();
    };
    let busy = false;
    input.addEventListener("keydown", async (e) => {
      e.stopPropagation();
      // The editor regains focus when the box closes; without this the Enter that submitted
      // would also be typed into the code.
      if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
      if (e.key === "Escape") {
        close();
      } else if (e.key === "Enter" && !busy && input.value.trim()) {
        busy = true;
        input.disabled = true;
        status.textContent = "Generating…";
        try {
          await submit(input.value.trim());
        } catch (err) {
          this.onError(`Inline edit failed: ${(err as Error).message}`);
        } finally {
          close();
        }
      }
    });
    setTimeout(() => input.focus(), 0);
  }

  private applyDiff(range: any, selection: string, replacement: string, instruction: string, atEof: boolean) {
    const m = this.monaco;
    const model = this.editor.getModel();
    const startLine = range.startLineNumber + (atEof ? 1 : 0);
    this.editor.pushUndoStop();
    this.editor.executeEdits("inline-edit", [{ range, text: replacement, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();

    const lines = (s: string) => {
      const t = atEof ? s.replace(/^\n/, "") : s;
      if (t === "") return [];
      return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
    };
    const oldLines = lines(selection);
    const newLines = lines(replacement);
    const diff = diffLines(oldLines, newLines);
    if (diff.length === 0) return;

    this.active = true;
    this.activeKey.set(true);
    this.hunks = diff.map((h, idx) => {
      const first = startLine + h.newStart;
      const decoRange = h.newCount > 0
        ? new m.Range(first, 1, first + h.newCount - 1, model.getLineMaxColumn(first + h.newCount - 1))
        : new m.Range(Math.min(first, model.getLineCount()), 1, Math.min(first, model.getLineCount()), 1);
      const decorations = this.editor.createDecorationsCollection([
        {
          range: decoRange,
          options: h.newCount > 0
            ? { isWholeLine: true, className: "ec-ie-added", linesDecorationsClassName: "ec-ie-added-gutter", stickiness: m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
            : { stickiness: m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        },
      ]);
      let zoneId: string | null = null;
      if (h.oldLines.length > 0) {
        const dom = document.createElement("div");
        dom.className = "ec-ie-removed";
        for (const l of h.oldLines) {
          const row = document.createElement("div");
          row.textContent = l || " ";
          dom.appendChild(row);
        }
        this.editor.changeViewZones((acc: any) => {
          zoneId = acc.addZone({ afterLineNumber: first - 1, heightInLines: h.oldLines.length, domNode: dom });
        });
      }
      const hunk: Hunk = { oldLines: h.oldLines, newCount: h.newCount, decorations, zoneId, widget: null };
      hunk.widget = this.hunkWidget(hunk, idx);
      this.editor.addContentWidget(hunk.widget);
      return hunk;
    });
    this.addSessionBar(startLine, instruction);
  }

  private hunkWidget(hunk: Hunk, idx: number) {
    const m = this.monaco;
    const dom = document.createElement("div");
    dom.className = "ec-ie-hunk";
    const ok = document.createElement("button");
    ok.className = "ok";
    ok.textContent = "✓ Keep";
    ok.title = "Keep this change";
    const no = document.createElement("button");
    no.className = "no";
    no.textContent = "✕ Undo";
    no.title = "Undo this change";
    for (const b of [ok, no]) b.addEventListener("mousedown", (e) => e.preventDefault());
    ok.addEventListener("click", () => this.resolve(hunk, true));
    no.addEventListener("click", () => this.resolve(hunk, false));
    dom.append(ok, no);
    // Fixed per widget: Monaco finds the widget by this id when it is removed.
    const id = `ec.inlineEdit.hunk.${idx}.${++widgetSeq}`;
    return {
      getId: () => id,
      getDomNode: () => dom,
      getPosition: () => {
        const r = hunk.decorations.getRange(0);
        if (!r) return null;
        const model = this.editor.getModel();
        const line = Math.min(r.startLineNumber, model.getLineCount());
        return { position: { lineNumber: line, column: model.getLineMaxColumn(line) }, preference: [m.editor.ContentWidgetPositionPreference.EXACT] };
      },
    };
  }

  private addSessionBar(line: number, instruction: string) {
    const m = this.monaco;
    const bar = document.createElement("div");
    bar.className = "ec-ie-box";
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `“${instruction.length > 60 ? `${instruction.slice(0, 57)}…` : instruction}”`;
    const accept = document.createElement("button");
    accept.textContent = "Accept all ⌘↵";
    const reject = document.createElement("button");
    reject.textContent = "Reject all Esc";
    for (const b of [accept, reject]) b.addEventListener("mousedown", (e) => e.preventDefault());
    accept.addEventListener("click", () => this.finish(true));
    reject.addEventListener("click", () => this.finish(false));
    bar.append(label, accept, reject);
    // Below the last change, so it never covers a change's own buttons (above line 1 there is no room).
    const widget = {
      getId: () => "ec.inlineEdit.session",
      getDomNode: () => bar,
      getPosition: () => {
        const last = this.hunks[this.hunks.length - 1];
        const r = last?.decorations.getRange(0);
        return { position: { lineNumber: r ? r.endLineNumber : line, column: 1 }, preference: [m.editor.ContentWidgetPositionPreference.BELOW, m.editor.ContentWidgetPositionPreference.ABOVE] };
      },
    };
    // An empty strip under the changes holds the bar, so it never covers code.
    const lastRange = this.hunks[this.hunks.length - 1]?.decorations.getRange(0);
    let spacerId: string | null = null;
    this.editor.changeViewZones((acc: any) => {
      spacerId = acc.addZone({ afterLineNumber: lastRange ? lastRange.endLineNumber : line, heightInPx: 36, domNode: document.createElement("div") });
    });
    this.editor.addContentWidget(widget);
    this.relayout = () => this.editor.layoutContentWidget(widget);
    this.disposers.push(() => {
      this.editor.removeContentWidget(widget);
      if (spacerId) {
        const id = spacerId;
        this.editor.changeViewZones((acc: any) => acc.removeZone(id));
      }
      this.relayout = undefined;
    });
  }

  private relayout: (() => void) | undefined;

  /** Keep or undo one change. */
  private resolve(hunk: Hunk, keep: boolean) {
    const m = this.monaco;
    const model = this.editor.getModel();
    const r = hunk.decorations.getRange(0);
    if (!keep && r && model) {
      const old = hunk.oldLines.length > 0 ? `${hunk.oldLines.join("\n")}\n` : "";
      let range;
      if (hunk.newCount > 0) {
        range = r.endLineNumber < model.getLineCount()
          ? new m.Range(r.startLineNumber, 1, r.endLineNumber + 1, 1)
          : new m.Range(r.startLineNumber > 1 ? r.startLineNumber - 1 : 1, r.startLineNumber > 1 ? model.getLineMaxColumn(r.startLineNumber - 1) : 1, r.endLineNumber, model.getLineMaxColumn(r.endLineNumber));
        const atEnd = r.endLineNumber >= model.getLineCount();
        const text = atEnd ? (r.startLineNumber > 1 && old ? `\n${old.slice(0, -1)}` : old.slice(0, -1)) : old;
        this.editor.executeEdits("inline-edit", [{ range, text }]);
      } else {
        range = new m.Range(r.startLineNumber, 1, r.startLineNumber, 1);
        this.editor.executeEdits("inline-edit", [{ range, text: old }]);
      }
    }
    this.clearHunk(hunk);
    this.hunks = this.hunks.filter((h) => h !== hunk);
    if (this.hunks.length === 0) this.end();
    else this.relayout?.();
  }

  private clearHunk(hunk: Hunk) {
    hunk.decorations.clear();
    if (hunk.zoneId) {
      const id = hunk.zoneId;
      this.editor.changeViewZones((acc: any) => acc.removeZone(id));
    }
    if (hunk.widget) this.editor.removeContentWidget(hunk.widget);
  }

  /** Accept or reject every change still pending. */
  finish(keep: boolean) {
    if (!this.active) return;
    this.editor.pushUndoStop();
    // Bottom-up, so undoing one change never moves the ones above it.
    for (const h of [...this.hunks].reverse()) this.resolve(h, keep);
    this.editor.pushUndoStop();
    this.end();
  }

  private end() {
    for (const h of this.hunks) this.clearHunk(h);
    this.hunks = [];
    for (const d of this.disposers.splice(0)) d();
    this.active = false;
    this.activeKey.set(false);
    this.editor.focus();
  }

  /** Clear any pending review (e.g. before switching files). */
  cancel() {
    if (this.active) this.end();
  }
}

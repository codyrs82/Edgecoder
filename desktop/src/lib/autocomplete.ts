// Tab autocomplete in Monaco: ghost text from the IDE server's fill-in-the-middle model
// (/v1/ide/complete). Requests wait for a short pause in typing and are cancelled when the user
// keeps typing; Tab accepts, Esc dismisses (Monaco's inline suggestion keys).
import type { CompletionResponse } from "./api";

const DEBOUNCE_MS = 300;
const PREFIX_CHARS = 3000;
const SUFFIX_CHARS = 1500;

export interface AutocompleteOptions {
  request: (prefix: string, suffix: string, signal: AbortSignal) => Promise<CompletionResponse>;
  enabled: () => boolean;
  /** Shown once when completions can't work (e.g. the model is not installed). */
  onUnavailable: (message: string) => void;
}

export function registerAutocomplete(monaco: any, editor: any, opts: AutocompleteOptions): { dispose: () => void } {
  let warned = false;
  return monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, {
    async provideInlineCompletions(model: any, position: any, _context: unknown, token: any) {
      // Only the main editor (not diff views), only when on.
      if (!opts.enabled() || model !== editor.getModel()) return { items: [] };
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
      if (token.isCancellationRequested) return { items: [] };
      const full = model.getValue();
      const offset = model.getOffsetAt(position);
      const prefix = full.slice(Math.max(0, offset - PREFIX_CHARS), offset);
      const suffix = full.slice(offset, offset + SUFFIX_CHARS);
      // Nothing to go on yet.
      if (!prefix.trim()) return { items: [] };
      const abort = new AbortController();
      const sub = token.onCancellationRequested(() => abort.abort());
      try {
        const r = await opts.request(prefix, suffix, abort.signal);
        if ("reason" in r) {
          if (!warned && r.reason !== "error") {
            warned = true;
            opts.onUnavailable(r.message);
          }
          return { items: [] };
        }
        if (!r.completion || token.isCancellationRequested) return { items: [] };
        return {
          items: [{ insertText: r.completion, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }],
        };
      } catch {
        return { items: [] };
      } finally {
        sub.dispose();
      }
    },
    freeInlineCompletions() {},
    disposeInlineCompletions() {},
  });
}

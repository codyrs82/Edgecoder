// Editor preferences, per device (localStorage; the editor works with defaults when it's unavailable).
export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  /** Run the project's checkers on open and save. */
  diagnostics: boolean;
  /** Ollama model for tab autocomplete ("" = the server's default). */
  completionModel: string;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 14,
  tabSize: 4,
  wordWrap: false,
  minimap: false,
  diagnostics: true,
  completionModel: "",
};

const KEY = "edgecoder-editor-settings";

export function loadEditorSettings(): EditorSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<EditorSettings>;
    return sanitize({ ...DEFAULT_EDITOR_SETTINGS, ...raw });
  } catch {
    return { ...DEFAULT_EDITOR_SETTINGS };
  }
}

export function saveEditorSettings(s: EditorSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitize(s)));
  } catch {
    // storage unavailable: settings last for this session
  }
}

export function sanitize(s: EditorSettings): EditorSettings {
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return {
    fontSize: num(s.fontSize, 10, 28, DEFAULT_EDITOR_SETTINGS.fontSize),
    tabSize: num(s.tabSize, 1, 8, DEFAULT_EDITOR_SETTINGS.tabSize),
    wordWrap: Boolean(s.wordWrap),
    minimap: Boolean(s.minimap),
    diagnostics: s.diagnostics !== false,
    completionModel: typeof s.completionModel === "string" ? s.completionModel.trim().slice(0, 200) : "",
  };
}

/** Monaco options for these settings. */
export function monacoOptions(s: EditorSettings) {
  return { fontSize: s.fontSize, tabSize: s.tabSize, wordWrap: (s.wordWrap ? "on" : "off") as "on" | "off", minimap: { enabled: s.minimap } };
}

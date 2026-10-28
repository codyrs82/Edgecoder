// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * #25: Monaco editor themes derived from the shared design tokens (packages/tokens), so the
 * editor matches the app in both light and dark and follows token changes automatically.
 */

export type TokenMode = "light" | "dark";
type Tokens = { color: Record<string, { light: string; dark: string }> };

/** Structurally the same as monaco.editor.ITokenThemeRule (kept local so this file has no Monaco import). */
export interface MonacoTokenRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: MonacoTokenRule[];
  colors: Record<string, string>;
}

/** Monaco color key -> design token. */
export const MONACO_TOKEN_MAP: Record<string, string> = {
  "editor.background": "bg-input",
  "editor.foreground": "text-primary",
  "editorLineNumber.foreground": "text-muted",
  "editorLineNumber.activeForeground": "text-secondary",
  "editor.selectionBackground": "selection",
  "editor.lineHighlightBackground": "bg-base",
  "editorCursor.foreground": "accent",
  // #131 review: bg-elevated (not bg-surface, which equals bg-input in light mode) plus a hex
  // border, so suggest/hover widgets stand out from the editor in both modes.
  "editorWidget.background": "bg-elevated",
  "editorWidget.border": "text-muted",
  "editorHoverWidget.background": "bg-elevated",
  "editorHoverWidget.border": "text-muted",
  "editorSuggestWidget.background": "bg-elevated",
  "editorSuggestWidget.border": "text-muted",
  "editorSuggestWidget.selectedBackground": "selection",
  "focusBorder": "accent"
};

export function monacoThemeData(tokens: Tokens, mode: TokenMode): MonacoThemeData {
  const colors: Record<string, string> = {};
  for (const [key, token] of Object.entries(MONACO_TOKEN_MAP)) {
    const value = tokens.color[token]?.[mode];
    if (!value) throw new Error(`monaco theme: missing token "${token}" (${mode})`);
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) {
      throw new Error(`monaco theme: token "${token}" (${mode}) must be a hex color for Monaco, got ${value}`);
    }
    colors[key] = value;
  }
  return { base: mode === "dark" ? "vs-dark" : "vs", inherit: true, rules: [], colors };
}

/** #131 review: a bad token must not blank the editor; fall back to Monaco's base theme. */
export function monacoThemeDataOrBase(tokens: Tokens, mode: TokenMode, onError: (e: unknown) => void = console.error): MonacoThemeData {
  try {
    return monacoThemeData(tokens, mode);
  } catch (error) {
    onError(error);
    return { base: mode === "dark" ? "vs-dark" : "vs", inherit: true, rules: [], colors: {} };
  }
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * #25: Monaco editor themes derived from the shared design tokens (packages/tokens), so the
 * editor matches the app in both light and dark and follows token changes automatically.
 */

export type TokenMode = "light" | "dark";
type Tokens = { color: Record<string, { light: string; dark: string }> };

export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: [];
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
  "editorWidget.background": "bg-surface",
  "editorSuggestWidget.background": "bg-surface",
  "editorSuggestWidget.selectedBackground": "bg-elevated",
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

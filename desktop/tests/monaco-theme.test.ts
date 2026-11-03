import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MONACO_TOKEN_MAP, monacoThemeData, monacoThemeDataOrBase } from "../src/lib/monaco-theme";

const tokens = JSON.parse(readFileSync(new URL("../../packages/tokens/src/tokens.json", import.meta.url), "utf8"));

describe("Monaco theme from tokens (#25)", () => {
  it("maps every editor color to the token value for each mode", () => {
    for (const mode of ["dark", "light"] as const) {
      const t = monacoThemeData(tokens, mode);
      expect(t.base).toBe(mode === "dark" ? "vs-dark" : "vs");
      for (const [key, token] of Object.entries(MONACO_TOKEN_MAP)) expect(t.colors[key]).toBe(tokens.color[token][mode]);
    }
  });

  it("pins the 7 core editor colors to the current token values in both modes", () => {
    expect(monacoThemeData(tokens, "dark").colors).toMatchObject({
      "editor.background": "#0f1318",
      "editor.foreground": "#e8ecf1",
      "editorLineNumber.foreground": "#8b96a4",
      "editorLineNumber.activeForeground": "#aab3c0",
      "editor.selectionBackground": "#2a2114",
      "editor.lineHighlightBackground": "#12161c",
      "editorCursor.foreground": "#f7931a"
    });
    expect(monacoThemeData(tokens, "light").colors).toMatchObject({
      "editor.background": "#ffffff",
      "editor.foreground": "#10151c",
      "editorLineNumber.foreground": "#596470",
      "editorLineNumber.activeForeground": "#46505e",
      "editor.selectionBackground": "#fce4c4",
      "editor.lineHighlightBackground": "#f3f5f8",
      "editorCursor.foreground": "#8a4f08"
    });
  });

  it("widgets differ from the editor background in both modes", () => {
    for (const mode of ["dark", "light"] as const) {
      const c = monacoThemeData(tokens, mode).colors;
      expect(c["editorSuggestWidget.background"], mode).not.toBe(c["editor.background"]);
      expect(c["editorWidget.border"], mode).toMatch(/^#/);
    }
  });

  it("falls back to the base theme instead of throwing", () => {
    const errors: unknown[] = [];
    expect(monacoThemeDataOrBase({ color: {} }, "light", (e) => errors.push(e))).toEqual({ base: "vs", inherit: true, rules: [], colors: {} });
    expect(errors).toHaveLength(1);
  });

  it("rejects a missing or non-hex token", () => {
    expect(() => monacoThemeData({ color: {} }, "dark")).toThrow(/missing token/);
    const bad = structuredClone(tokens);
    bad.color["bg-input"].dark = "rgba(0,0,0,1)";
    expect(() => monacoThemeData(bad, "dark")).toThrow(/must be a hex color/);
  });
});

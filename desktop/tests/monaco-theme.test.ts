import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MONACO_TOKEN_MAP, monacoThemeData } from "../src/lib/monaco-theme";

const tokens = JSON.parse(readFileSync(new URL("../../packages/tokens/src/tokens.json", import.meta.url), "utf8"));

describe("Monaco theme from tokens (#25)", () => {
  it("maps every editor color to the token value for each mode", () => {
    for (const mode of ["dark", "light"] as const) {
      const t = monacoThemeData(tokens, mode);
      expect(t.base).toBe(mode === "dark" ? "vs-dark" : "vs");
      for (const [key, token] of Object.entries(MONACO_TOKEN_MAP)) expect(t.colors[key]).toBe(tokens.color[token][mode]);
    }
  });

  it("keeps the previous hand-written editor colors", () => {
    expect(monacoThemeData(tokens, "dark").colors).toMatchObject({
      "editor.background": "#262624",
      "editor.foreground": "#f7f5f0",
      "editor.selectionBackground": "#5a4a3a",
      "editor.lineHighlightBackground": "#2f2f2d",
      "editorCursor.foreground": "#c17850"
    });
    expect(monacoThemeData(tokens, "light").colors).toMatchObject({
      "editor.background": "#ffffff",
      "editor.lineHighlightBackground": "#f7f5f0",
      "editorCursor.foreground": "#a65a33"
    });
  });

  it("rejects a missing or non-hex token", () => {
    expect(() => monacoThemeData({ color: {} }, "dark")).toThrow(/missing token/);
    const bad = structuredClone(tokens);
    bad.color["bg-input"].dark = "rgba(0,0,0,1)";
    expect(() => monacoThemeData(bad, "dark")).toThrow(/must be a hex color/);
  });
});

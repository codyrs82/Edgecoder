import { describe, expect, it } from "vitest";
import { DEFAULT_EDITOR_SETTINGS, monacoOptions, sanitize } from "../src/lib/editor-settings";

describe("editor settings", () => {
  it("clamps and fills bad values", () => {
    expect(sanitize({ ...DEFAULT_EDITOR_SETTINGS, fontSize: 99, tabSize: 0, completionModel: "  qwen2.5-coder:7b  " })).toMatchObject({ fontSize: 28, tabSize: 1, completionModel: "qwen2.5-coder:7b" });
    expect(sanitize({ ...DEFAULT_EDITOR_SETTINGS, fontSize: Number.NaN })).toMatchObject({ fontSize: 14 });
  });
  it("maps to Monaco options", () => {
    expect(monacoOptions({ ...DEFAULT_EDITOR_SETTINGS, wordWrap: true, minimap: true })).toEqual({ fontSize: 14, tabSize: 4, wordWrap: "on", minimap: { enabled: true } });
  });
});

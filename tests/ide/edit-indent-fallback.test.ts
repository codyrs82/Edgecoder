// edit_file when the model gets the indentation wrong (dogfooding: qwen3-coder:30b wrote a
// vitepress config entry with 12 spaces where the file has 10, five times in a row).
import { describe, expect, it } from "vitest";
import { locateEdit } from "../../src/apps/ide/tool-executor.js";

const apply = (content: string, m: ReturnType<typeof locateEdit>) => {
  if ("error" in m) throw new Error(m.error);
  return content.slice(0, m.index) + m.newString + content.slice(m.index + m.oldString.length);
};

const CONFIG = [
  "export default {",
  "  sidebar: [",
  "      items: [",
  "          { text: \"BLE Local Mesh\", link: \"/guide/ble-local-mesh\" },",
  "          { text: \"Model Management\", link: \"/guide/model-management\" }",
  "        ]",
  "  ]",
  "};",
  "",
].join("\n");

describe("locateEdit: indentation-insensitive fallback", () => {
  it("applies an edit written with deeper indentation, keeping the file's", () => {
    const oldS = "            { text: \"Model Management\", link: \"/guide/model-management\" }";
    const newS = "            { text: \"Model Management\", link: \"/guide/model-management\" },\n            { text: \"Remote\", link: \"/guide/remote\" }";
    const out = apply(CONFIG, locateEdit(CONFIG, oldS, newS));
    expect(out).toContain("          { text: \"Model Management\", link: \"/guide/model-management\" },\n          { text: \"Remote\", link: \"/guide/remote\" }\n        ]");
  });

  it("applies a multi-line edit written with shallower indentation", () => {
    const oldS = "  { text: \"BLE Local Mesh\", link: \"/guide/ble-local-mesh\" },\n  { text: \"Model Management\", link: \"/guide/model-management\" }";
    const newS = "  { text: \"BLE Local Mesh\", link: \"/guide/ble-local-mesh\" },\n    { text: \"Nested\", link: \"/n\" }";
    const out = apply(CONFIG, locateEdit(CONFIG, oldS, newS));
    expect(out).toContain("          { text: \"BLE Local Mesh\", link: \"/guide/ble-local-mesh\" },\n            { text: \"Nested\", link: \"/n\" }\n        ]");
  });

  it("still prefers an exact match", () => {
    const m = locateEdit("  a\n    a\n", "    a", "    b");
    expect(m).toEqual({ index: 4, oldString: "    a", newString: "    b" });
  });

  it("refuses when the lines match in several places ignoring indentation", () => {
    expect(locateEdit("  x\n    x\n", "x ", "y")).toEqual({ error: expect.stringContaining("multiple locations") });
  });

  it("names the nearest real line when the rest does not match", () => {
    const m = locateEdit(CONFIG, "    { text: \"Model Management\", link: \"/guide/model-management\" }\n    ]\n  },", "z");
    expect("error" in m && m.error).toMatch(/^old_string not found in file\. Line 5 has that text as `          \{ text: "Model Management"/);
    expect(locateEdit("abc", "zzz\n", "")).toEqual({ error: "old_string not found in file" });
  });
});

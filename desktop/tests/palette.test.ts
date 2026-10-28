import { describe, expect, it } from "vitest";
import { filterCommands, groupCommands, isMac, isPaletteShortcut, type PaletteCommand } from "../src/lib/palette";

const k = (o: Partial<KeyboardEvent>) => ({ key: "k", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

describe("command palette (#24)", () => {
  it("Cmd+K on mac, Ctrl+K elsewhere, nothing else", () => {
    expect(isPaletteShortcut(k({ metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(k({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(k({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(k({ key: "K", ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(k({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(k({}), false)).toBe(false);
    expect(isPaletteShortcut(k({ key: "j", ctrlKey: true }), false)).toBe(false);
  });

  it("detects mac platforms", () => {
    expect(isMac("MacIntel")).toBe(true);
    expect(isMac("Win32")).toBe(false);
    expect(isMac("Linux x86_64")).toBe(false);
  });

  it("groups in a fixed order, hides `when: false`, rejects duplicate ids", () => {
    const noop = () => {};
    const cmds: PaletteCommand[] = [
      { id: "logout", label: "Sign out", group: "Account", run: noop },
      { id: "chat", label: "Go to Chat", group: "Navigate", run: noop },
      { id: "sidebar", label: "Toggle sidebar", group: "Chat", run: noop, when: false },
      { id: "dark", label: "Dark theme", group: "Appearance", run: noop },
    ];
    expect(groupCommands(cmds).map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
      ["Navigate", ["chat"]],
      ["Appearance", ["dark"]],
      ["Account", ["logout"]],
    ]);
    expect(() => groupCommands([...cmds, { id: "chat", label: "x", group: "Chat", run: noop }])).toThrow("duplicate");
  });
});

describe("filterCommands (#24)", () => {
  const noop = () => {};
  const cmds: PaletteCommand[] = [
    { id: "go-editor", label: "Go to Editor", group: "Navigate", keywords: ["IDE", "code"], run: noop },
    { id: "new-chat", label: "New chat", group: "Chat", run: noop },
    { id: "sign-out", label: "Sign out", group: "Account", keywords: ["log out"], run: noop },
  ];
  it("matches label and keywords, case-insensitively, all terms required", () => {
    expect(filterCommands(cmds, "editor").map((c) => c.id)).toEqual(["go-editor"]);
    expect(filterCommands(cmds, "ide").map((c) => c.id)).toEqual(["go-editor"]);
    expect(filterCommands(cmds, "LOG").map((c) => c.id)).toEqual(["sign-out"]);
    expect(filterCommands(cmds, "new chat").map((c) => c.id)).toEqual(["new-chat"]);
    expect(filterCommands(cmds, "new editor")).toEqual([]);
    expect(filterCommands(cmds, "   ")).toHaveLength(3);
  });
});

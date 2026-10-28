// #24: command palette model (framework-free, so the root suite can test it).

export interface PaletteCommand {
  id: string;
  label: string;
  group: "Navigate" | "Chat" | "Project" | "Appearance" | "Account";
  keywords?: string[];
  /** Shown as a hint, e.g. "⌘K". */
  shortcut?: string;
  run: () => void;
  /** Hidden when false (e.g. "Toggle sidebar" outside the chat tab). */
  when?: boolean;
}

/** Cmd+K on macOS, Ctrl+K elsewhere; plain K, or with Shift/Alt, doesn't count. */
export function isPaletteShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean {
  if (e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function isMac(platform = typeof navigator !== "undefined" ? navigator.platform : ""): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

const ORDER: PaletteCommand["group"][] = ["Navigate", "Chat", "Project", "Appearance", "Account"];

/** Visible commands grouped in a fixed order; ids must be unique. */
export function groupCommands(commands: readonly PaletteCommand[]): Array<{ group: PaletteCommand["group"]; items: PaletteCommand[] }> {
  const seen = new Set<string>();
  for (const c of commands) {
    if (seen.has(c.id)) throw new Error(`duplicate palette command id: ${c.id}`);
    seen.add(c.id);
  }
  const visible = commands.filter((c) => c.when !== false);
  return ORDER.map((group) => ({ group, items: visible.filter((c) => c.group === group) })).filter((g) => g.items.length > 0);
}

/**
 * Case-insensitive match on label and keywords: every whitespace-separated term must appear.
 * Done here (bits-ui's `shouldFilter` is off) so the behaviour is predictable and tested.
 */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...commands];
  return commands.filter((c) => {
    const hay = [c.label, ...(c.keywords ?? [])].join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

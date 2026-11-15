// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Keyboard helpers shared by the dialog shell (components/ui/Dialog.svelte) and the menu action
 * (lib/menu.ts). The focus trap itself comes from bits-ui since #24.
 */

/** Roving index for arrow keys in a tablist / listbox; Home/End jump. Returns null for other keys. */
export function rovingIndex(key: string, current: number, count: number, orientation: "vertical" | "horizontal" = "vertical"): number | null {
  if (count <= 0) return null;
  const prev = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  if (key === next) return (current + 1) % count;
  if (key === prev) return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export interface EscapeSource {
  defaultPrevented: boolean;
  target: { tagName?: string; getAttribute?(name: string): string | null } | null;
}

/** Whether an Escape keydown should close the dialog. */
export function escapeClosesDialog(e: EscapeSource): boolean {
  if (e.defaultPrevented) return false;
  const t = e.target;
  const tag = (t?.tagName ?? "").toUpperCase();
  if (tag === "SELECT" || tag === "TEXTAREA") return false;
  if (tag === "INPUT") return false;
  const role = t?.getAttribute?.("role");
  if (role === "combobox" || role === "listbox") return false;
  if (t?.getAttribute?.("aria-expanded") === "true") return false;
  return true;
}

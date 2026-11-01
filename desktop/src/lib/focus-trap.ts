// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * #26: focus trap for modal surfaces (Settings sheet).
 * - Tab / Shift+Tab cycle inside the node, over real tab stops only (tabindex >= 0), so a
 *   roving-tabindex tablist is a single stop.
 * - Escape calls onEscape, unless something inside already handled it (defaultPrevented) or it
 *   came from an open select / combobox / text field, where Escape means "cancel this control".
 * - Focus moves to `initialFocus` (or the first stop) on mount and back to the opener on destroy.
 * - Everything outside the dialog is made `inert` while it is open.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';

/** Index to focus after Tab (or Shift+Tab) from `current` in a list of `count` items; wraps. */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

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

export interface TabStopLike {
  tabIndex: number;
  getClientRects(): { length: number };
}

/**
 * Real tab stops: tabindex >= 0 (drops roving `tabindex=-1` tabs) and rendered. Uses
 * getClientRects rather than offsetParent, which is null for position: fixed.
 */
export function tabStops<T extends TabStopLike>(candidates: Iterable<T>, active?: unknown): T[] {
  return Array.from(candidates).filter((el) => el.tabIndex >= 0 && (el.getClientRects().length > 0 || el === active));
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

export function focusTrap(node: HTMLElement, opts: { onEscape?: () => void; initialFocus?: () => HTMLElement | null | undefined } = {}) {
  const opener = document.activeElement as HTMLElement | null;
  let onEscape = opts.onEscape;
  const items = () => tabStops(node.querySelectorAll<HTMLElement>(FOCUSABLE), document.activeElement);

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (onEscape && escapeClosesDialog(e as unknown as EscapeSource)) {
        e.preventDefault();
        onEscape();
      }
      return;
    }
    if (e.key !== "Tab") return;
    const list = items();
    e.preventDefault();
    if (list.length === 0) {
      node.focus();
      return;
    }
    list[nextFocusIndex(list.indexOf(document.activeElement as HTMLElement), list.length, e.shiftKey)]?.focus();
  }

  // inert everything outside the dialog (siblings of each ancestor up to <body>).
  const madeInert: HTMLElement[] = [];
  for (let el: HTMLElement | null = node; el && el !== document.body; el = el.parentElement) {
    for (const sib of Array.from(el.parentElement?.children ?? [])) {
      if (sib !== el && sib instanceof HTMLElement && !sib.inert) {
        sib.inert = true;
        madeInert.push(sib);
      }
    }
  }

  node.addEventListener("keydown", onKeydown);
  queueMicrotask(() => (opts.initialFocus?.() ?? items()[0] ?? node).focus());

  return {
    update(next: { onEscape?: () => void } = {}) {
      onEscape = next.onEscape;
    },
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      for (const el of madeInert) el.inert = false;
      if (opener && document.contains(opener)) opener.focus();
    }
  };
}

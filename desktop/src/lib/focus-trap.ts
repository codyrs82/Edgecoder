// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * #26: focus trap for modal surfaces (Settings sheet). Tab / Shift+Tab cycle inside the node,
 * Escape calls onEscape, focus moves in on mount and returns to the opener on destroy.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

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

export function focusTrap(node: HTMLElement, opts: { onEscape?: () => void } = {}) {
  const opener = document.activeElement as HTMLElement | null;
  let onEscape = opts.onEscape;
  const items = () =>
    Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const list = items();
    if (list.length === 0) {
      e.preventDefault();
      node.focus();
      return;
    }
    const i = nextFocusIndex(list.indexOf(document.activeElement as HTMLElement), list.length, e.shiftKey);
    e.preventDefault();
    list[i]?.focus();
  }

  node.addEventListener("keydown", onKeydown);
  queueMicrotask(() => (items()[0] ?? node).focus());

  return {
    update(next: { onEscape?: () => void } = {}) {
      onEscape = next.onEscape;
    },
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      if (opener && document.contains(opener)) opener.focus();
    }
  };
}

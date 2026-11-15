// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * #161: keyboard behaviour for a `role="menu"` popup (WAI-ARIA menu button pattern).
 * - Focus moves to the first enabled menuitem when the menu opens.
 * - ArrowDown / ArrowUp move between items (wrapping); Home / End jump to the ends.
 * - Escape closes the menu and asks for focus to go back to the trigger.
 * - Tab closes the menu and lets focus move on normally.
 * - A pointerdown outside the menu (and outside its trigger) closes it.
 * Returning focus is the caller's job (`onClose(true, ...)`), because only the caller knows when
 * the trigger is back in a stable DOM after the menu is removed.
 */

import { rovingIndex } from "./focus-trap";

export type MenuCloseReason = "escape" | "tab" | "outside";

export interface MenuOptions {
  /** Called when the menu should close. `returnFocus` is true for Escape. */
  onClose: (returnFocus: boolean, reason: MenuCloseReason) => void;
  /** The button that opened the menu; pointer events on it are left to its own toggle handler. */
  trigger?: HTMLElement | null;
}

const ITEM = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

/** Index of the item to focus for `key`, or null when the key isn't a menu navigation key. */
export function menuKeyIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (current < 0 && (key === "ArrowDown" || key === "ArrowUp")) return key === "ArrowDown" ? 0 : count - 1;
  return rovingIndex(key, current, count, "vertical");
}

export function menu(node: HTMLElement, opts: MenuOptions) {
  let options = opts;
  const items = () => Array.from(node.querySelectorAll<HTMLElement>(ITEM));

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      options.onClose(true, "escape");
      return;
    }
    if (e.key === "Tab") {
      options.onClose(false, "tab");
      return;
    }
    const list = items();
    const next = menuKeyIndex(e.key, list.indexOf(document.activeElement as HTMLElement), list.length);
    if (next === null) return;
    e.preventDefault();
    list[next]?.focus();
  }

  function onPointerDown(e: Event) {
    const t = e.target as Node | null;
    if (!t || node.contains(t) || options.trigger?.contains(t)) return;
    options.onClose(false, "outside");
  }

  node.addEventListener("keydown", onKeydown);
  document.addEventListener("pointerdown", onPointerDown, true);
  queueMicrotask(() => (items()[0] ?? node).focus());

  return {
    update(next: MenuOptions) {
      options = next;
    },
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    },
  };
}

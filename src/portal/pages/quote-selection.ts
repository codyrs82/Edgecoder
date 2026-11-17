// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import * as Q from "../../common/quote-selection.js";

/**
 * "Add to chat" on the portal's Chat and Bots pages, like the desktop app's QuoteSelection.svelte:
 * select text in a message body (an element marked data-quotable inside the scroll pane) and a
 * small "Add to chat ⌘L" chip appears just above it; the chip or Cmd+L (Ctrl+L elsewhere) adds the
 * selection to the composer as a Markdown quote (src/common/quote-selection.ts, shipped here via
 * Function.prototype.toString). Esc, scrolling or a click away hides the chip; it never takes the
 * selection, so Cmd+C still copies.
 */
export const QUOTE_SELECTION_BROWSER_LIB = [Q.quoteMarkdown, Q.insertQuoteText, Q.quotableSelection, Q.quoteButtonPosition]
  .map((f) => f.toString())
  .join("\n");

/** The chip's style, for the page's own nonce'd style block. */
export const QUOTE_SELECTION_CSS = `
      .quote-chip { position:fixed; z-index:60; display:inline-flex; align-items:center; gap:6px; height:28px; min-height:0; padding:0 10px 0 12px; border:1px solid var(--card-border); border-radius:999px; background:var(--bg-elevated); color:var(--text); box-shadow:var(--shadow-2); font:inherit; font-size:12px; white-space:nowrap; cursor:pointer; }
      .quote-chip[hidden] { display:none; }
      .quote-chip:hover { background:var(--bg-surface); }
      .quote-chip kbd { font:inherit; color:var(--muted); background:none; border:none; padding:0; }
`;

/**
 * The page script: wires the chip to the scroll pane `scrollId` and the composer `inputId`
 * (a textarea). Needs QUOTE_SELECTION_BROWSER_LIB before it.
 */
export function quoteSelectionScript(scrollId: string, inputId: string): string {
  return `
    (function() {
      var scope = document.getElementById(${JSON.stringify(scrollId)});
      var input = document.getElementById(${JSON.stringify(inputId)});
      if (!scope || !input) return;
      var isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
      var keyLabel = isMac ? "\\u2318L" : "Ctrl+L";
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "quote-chip";
      chip.hidden = true;
      chip.setAttribute("aria-label", "Add selection to chat");
      chip.setAttribute("aria-keyshortcuts", isMac ? "Meta+L" : "Control+L");
      chip.title = "Quote the selection in your message (" + keyLabel + ")";
      chip.setAttribute("data-testid", "quote-selection");
      chip.appendChild(document.createTextNode("Add to chat "));
      var kbd = document.createElement("kbd");
      kbd.textContent = keyLabel;
      chip.appendChild(kbd);
      // Right after the pane in the tab order.
      scope.parentNode.insertBefore(chip, scope.nextSibling);
      var dismissedFor = null;
      function current() { return quotableSelection(window.getSelection(), scope); }
      function refresh() {
        var q = current();
        if (!q) { chip.hidden = true; dismissedFor = null; return; }
        if (dismissedFor === q.text) return;
        dismissedFor = null;
        var p = quoteButtonPosition(q.rect, scope.getBoundingClientRect(), chip.offsetWidth || 128, chip.offsetHeight || 28);
        chip.style.left = p.left + "px";
        chip.style.top = p.top + "px";
        chip.hidden = false;
      }
      function hide() {
        if (chip.hidden) return;
        var q = current();
        dismissedFor = q ? q.text : null;
        chip.hidden = true;
      }
      function add() {
        var q = current();
        chip.hidden = true;
        if (!q) return;
        dismissedFor = q.text;
        var next = insertQuoteText(input.value, input.selectionEnd == null ? input.value.length : input.selectionEnd, quoteMarkdown(q.text, q.code));
        input.value = next.value;
        input.focus();
        input.setSelectionRange(next.caret, next.caret);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      chip.addEventListener("mousedown", function(e) { e.preventDefault(); });
      chip.addEventListener("click", add);
      document.addEventListener("selectionchange", refresh);
      scope.addEventListener("scroll", hide, { passive: true });
      window.addEventListener("resize", hide);
      window.addEventListener("mousedown", function(e) { if (!chip.contains(e.target)) hide(); }, true);
      window.addEventListener("keydown", function(e) {
        if (e.key === "Escape" && !chip.hidden) { hide(); return; }
        var mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
        if (!mod || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== "l") return;
        var t = e.target;
        if (t && t !== chip && t.closest && t.closest("textarea, input, [contenteditable]:not([contenteditable='false'])")) return;
        if (!current()) return;
        e.preventDefault();
        add();
      });
    })();
  `;
}

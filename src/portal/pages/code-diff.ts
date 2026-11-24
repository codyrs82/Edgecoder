// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A turn's file changes on the Code page, as a line diff (the Mac sends each file's text before and
 * after the turn, cut at 32,000 characters). Plain browser JS included in pages/code.ts; every line
 * goes through escapeHtml, and nothing in it is ever run.
 */
export const CODE_DIFF_JS = String.raw`
    /* Lines of a and b as [" "|"+"|"-", text]: shared head and tail trimmed, then an LCS table (small middles only). */
    function codeLineDiff(before, after) {
      var a = before === null || before === undefined ? [] : String(before).split("\n");
      var b = after === null || after === undefined ? [] : String(after).split("\n");
      var head = 0;
      while (head < a.length && head < b.length && a[head] === b[head]) head++;
      var tail = 0;
      while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
      var am = a.slice(head, a.length - tail), bm = b.slice(head, b.length - tail);
      var out = [];
      a.slice(0, head).forEach(function(l) { out.push([" ", l]); });
      if (am.length * bm.length > 2000000) {
        am.forEach(function(l) { out.push(["-", l]); });
        bm.forEach(function(l) { out.push(["+", l]); });
      } else {
        var n = am.length, m = bm.length, w = m + 1, t = new Uint32Array((n + 1) * w);
        for (var i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
        var x = 0, y = 0;
        while (x < n && y < m) {
          if (am[x] === bm[y]) { out.push([" ", am[x]]); x++; y++; }
          else if (t[(x + 1) * w + y] >= t[x * w + y + 1]) { out.push(["-", am[x]]); x++; }
          else { out.push(["+", bm[y]]); y++; }
        }
        while (x < n) out.push(["-", am[x++]]);
        while (y < m) out.push(["+", bm[y++]]);
      }
      b.slice(b.length - tail).forEach(function(l) { out.push([" ", l]); });
      return out;
    }
    /* Changed lines with 3 lines of context; long unchanged runs fold to "…". */
    function codeDiffHtml(file) {
      var lines = codeLineDiff(file.before, file.after);
      var keep = lines.map(function() { return false; });
      lines.forEach(function(l, i) { if (l[0] !== " ") for (var k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) keep[k] = true; });
      var html = "", skipped = false, added = 0, removed = 0;
      lines.forEach(function(l, i) {
        if (l[0] === "+") added++;
        if (l[0] === "-") removed++;
        if (!keep[i]) { if (!skipped) html += '<span class="dl fold">…</span>'; skipped = true; return; }
        skipped = false;
        html += '<span class="dl ' + (l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx") + '">' + escapeHtml(l[0] + " " + l[1]) + "</span>";
      });
      var what = file.before === null ? "new file" : file.after === null ? "deleted" : "+" + added + " −" + removed;
      return { html: '<pre class="diff">' + (html || '<span class="dl fold">No line changes</span>') + "</pre>" + (file.cut ? '<div class="muted u-fs-12">Long file: only its first 32,000 characters are compared.</div>' : ""), what: what };
    }
    function codeChangesHtml(data) {
      var items = (data && data.items) || [];
      if (!items.length) return '<div class="muted u-fs-12">No file changes recorded for this turn.</div>';
      return items.map(function(f) {
        var d = codeDiffHtml(f);
        return '<details class="cd-file"><summary><span class="cd-path">' + escapeHtml(f.path) + '</span><span class="cd-what">' + escapeHtml(d.what) + "</span></summary>" + d.html + "</details>";
      }).join("") + (data.total > items.length ? '<div class="muted u-fs-12">' + escapeHtml(data.total - items.length + " more files changed; see them on the Mac.") + "</div>" : "");
    }
`;

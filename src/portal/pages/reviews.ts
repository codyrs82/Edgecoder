// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";

// #16: moved verbatim from src/portal/server.ts.
/* ───────────────── Reviews page — Cloud Review Diff UI ───────────────── */
export function registerReviewsPage(app: FastifyInstance): void {
app.get("/portal/reviews", async (_req, reply) => {
  const content = `
    <style>
      .reviews-layout { display:flex; gap:12px; min-height:calc(100vh - 120px); }
      .reviews-list { width:320px; min-width:280px; flex-shrink:0; }
      .reviews-detail { flex:1; min-width:0; }
      .review-item {
        padding:12px 14px; border-radius:var(--radius-sm); cursor:pointer; margin:4px 0;
        border:1px solid var(--card-border); background:var(--card);
        transition:all var(--transition-fast);
      }
      .review-item:hover { border-color:var(--brand); transform:translateX(2px); }
      .review-item.active { border-color:var(--brand); background:var(--bg-surface); border-left:3px solid var(--brand); }
      .review-item .ri-task { font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .review-item .ri-meta { font-size:11px; color:var(--muted); margin-top:4px; display:flex; align-items:center; gap:6px; }
      /* ── Diff view (GitHub-style) ── */
      .diff-container {
        display:grid; grid-template-columns:1fr 1fr; gap:0;
        border:1px solid var(--card-border); border-radius:var(--radius-md); overflow:hidden;
        font-family:var(--font-mono); font-size:12px; line-height:1.7;
        background:#0d1117;
      }
      .diff-pane { overflow-x:auto; }
      .diff-pane-header {
        padding:10px 14px; font-size:11px; font-weight:700;
        letter-spacing:0.04em; color:var(--muted);
        border-bottom:1px solid rgba(255,255,255,0.06);
        background:rgba(255,255,255,0.03);
        display:flex; align-items:center; gap:8px;
      }
      .diff-pane-header .diff-file-icon { opacity:0.5; }
      .diff-pane-left .diff-pane-header { border-right:1px solid rgba(255,255,255,0.06); }
      .diff-line {
        display:flex; padding:0; min-height:22px; white-space:pre;
        border-bottom:1px solid rgba(255,255,255,0.02);
      }
      .diff-line-num {
        width:48px; min-width:48px; text-align:right; padding:0 10px 0 8px;
        color:rgba(255,255,255,0.25); user-select:none; flex-shrink:0;
        font-size:11px; border-right:1px solid rgba(255,255,255,0.04);
        background:rgba(255,255,255,0.01);
      }
      .diff-line-content { flex:1; min-width:0; padding:0 12px; }
      .diff-line.removed {
        background:rgba(248, 81, 73, 0.12);
        border-left:3px solid #f85149;
      }
      .diff-line.removed .diff-line-num { background:rgba(248, 81, 73, 0.15); color:rgba(248, 81, 73, 0.7); }
      .diff-line.added {
        background:rgba(63, 185, 80, 0.12);
        border-left:3px solid #3fb950;
      }
      .diff-line.added .diff-line-num { background:rgba(63, 185, 80, 0.15); color:rgba(63, 185, 80, 0.7); }
      .diff-line.unchanged {
        border-left:3px solid transparent;
      }
      .diff-pane-left { border-right:1px solid rgba(255,255,255,0.06); }
      /* ── Syntax highlighting hints ── */
      .syntax-keyword { color:#ff7b72; }
      .syntax-string { color:#a5d6ff; }
      .syntax-comment { color:#8b949e; font-style:italic; }
      .syntax-number { color:#79c0ff; }
      .syntax-function { color:#d2a8ff; }
      .syntax-builtin { color:#ffa657; }
      .diff-stats {
        display:flex; gap:12px; padding:8px 14px; font-size:11px;
        color:var(--muted); border-top:1px solid rgba(255,255,255,0.06);
        background:rgba(255,255,255,0.02);
      }
      .diff-stats .added-count { color:#3fb950; }
      .diff-stats .removed-count { color:#f85149; }
      /* ── Decision buttons ── */
      .review-actions { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
      .review-actions button {
        padding:12px 28px; font-size:14px; font-weight:700;
        border-radius:var(--radius-md); letter-spacing:0.02em;
        transition:all var(--transition-fast);
      }
      .btn-accept {
        background:linear-gradient(140deg, #16a34a, #22c55e);
        border:2px solid rgba(34, 197, 94, 0.7); color:white;
        box-shadow:0 2px 8px rgba(34, 197, 94, 0.2);
      }
      .btn-accept:hover { filter:brightness(1.15); box-shadow:0 4px 16px rgba(34, 197, 94, 0.35); transform:translateY(-2px); }
      .btn-reject {
        background:linear-gradient(140deg, #dc2626, #ef4444);
        border:2px solid rgba(239, 68, 68, 0.7); color:white;
        box-shadow:0 2px 8px rgba(239, 68, 68, 0.2);
      }
      .btn-reject:hover { filter:brightness(1.15); box-shadow:0 4px 16px rgba(239, 68, 68, 0.35); transform:translateY(-2px); }
      .btn-edit {
        background:linear-gradient(140deg, var(--brand), var(--brand-2));
        border:2px solid rgba(193, 120, 80, 0.7); color:white;
        box-shadow:0 2px 8px rgba(193, 120, 80, 0.2);
      }
      .btn-edit:hover { filter:brightness(1.15); box-shadow:0 4px 16px rgba(193, 120, 80, 0.35); transform:translateY(-2px); }
      .edit-area {
        width:100%; min-height:300px; margin-top:10px;
        font-family:var(--font-mono); font-size:12px; line-height:1.7;
        padding:12px; border:2px solid var(--brand);
        border-radius:var(--radius-sm); background:#0d1117; color:var(--text);
        resize:vertical;
      }
      .notes-section {
        margin-top:12px; padding:12px 16px;
        border:1px solid var(--card-border); border-radius:var(--radius-sm);
        background:var(--bg-soft); font-size:13px; color:var(--text-secondary);
        line-height:1.6;
      }
      .notes-section strong { color:var(--text); }
      .empty-state {
        text-align:center; padding:60px 20px; color:var(--muted);
      }
      .empty-state .empty-icon { font-size:42px; margin-bottom:12px; opacity:0.5; }
      .empty-state h3 { color:var(--text-secondary); margin:0 0 8px; font-size:16px; }
      .empty-state p { margin:0; font-size:13px; line-height:1.6; max-width:360px; display:inline-block; }
      .success-banner {
        padding:16px 20px; border-radius:var(--radius-md); text-align:center;
        background:rgba(34, 197, 94, 0.12); border:1px solid rgba(34, 197, 94, 0.4);
        color:var(--ok); font-weight:600; font-size:14px; margin-bottom:12px;
        animation:fadeSlideIn 0.3s ease;
      }
      @media (max-width:800px) {
        .reviews-layout { flex-direction:column; }
        .reviews-list { width:100%; }
        .diff-container { grid-template-columns:1fr; }
      }
    </style>
    <div class="reviews-layout">
      <div class="reviews-list">
        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <h3 style="margin:0;">Pending Reviews</h3>
            <span class="status-badge" id="reviewCountBadge" style="font-size:10px;">--</span>
          </div>
          <div id="reviewsList"><div class="loading-state"><span class="loading-spinner sm"></span> Loading reviews...</div></div>
        </div>
      </div>
      <div class="reviews-detail">
        <div id="reviewDetail">
          <div class="card empty-state">
            <div class="empty-icon">&#9998;</div>
            <h3>No review selected</h3>
            <p>Select a review from the list to view the code diff and make a decision.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  const script = `
    var reviews = [];
    var activeTaskId = null;
    var editMode = false;

    async function loadReviews() {
      try {
        var res = await api("/portal/api/reviews");
        reviews = res.reviews || [];
        renderReviewList();
      } catch (err) {
        document.getElementById("reviewsList").innerHTML =
          '<div class="muted">Could not load reviews: ' + String(err.message || err) + '</div>';
      }
    }

    function renderReviewList() {
      var container = document.getElementById("reviewsList");
      var badge = document.getElementById("reviewCountBadge");
      if (badge) {
        badge.textContent = String(reviews.length);
        badge.className = reviews.length > 0 ? "status-badge warn" : "status-badge ok";
      }
      if (reviews.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:32px 12px;"><div class="empty-icon">&#10003;</div><h3>No reviews pending</h3><p>All caught up! When agents escalate tasks for human review, they will appear here.</p></div>';
        return;
      }
      var html = "";
      for (var i = 0; i < reviews.length; i++) {
        var r = reviews[i];
        var active = r.taskId === activeTaskId ? " active" : "";
        var statusTone = r.status === "completed" ? "ok" : r.status === "failed" ? "danger" : "warn";
        html += '<div class="review-item' + active + '" onclick="selectReview(\\'' + r.taskId + '\\')">';
        html += '<div class="ri-task">' + escapeHtml(r.task || r.taskId) + '</div>';
        html += '<div class="ri-meta">' + statusBadge(r.status, statusTone) + ' <span style="color:var(--muted);">&middot;</span> ' + escapeHtml(r.language || "unknown") + '</div>';
        html += '</div>';
      }
      container.innerHTML = html;
    }

    function escapeHtml(str) {
      var div = document.createElement("div");
      div.appendChild(document.createTextNode(str));
      return div.innerHTML;
    }

    function syntaxHighlight(text) {
      var s = escapeHtml(text);
      // Comments (single-line: // or #)
      s = s.replace(/(\\/\\/.*$|#.*$)/gm, '<span class="syntax-comment">$1</span>');
      // Strings (double and single quotes)
      s = s.replace(/(&quot;[^&]*?&quot;|&#039;[^&]*?&#039;)/g, '<span class="syntax-string">$1</span>');
      // Numbers
      s = s.replace(/\\b(\\d+\\.?\\d*)\\b/g, '<span class="syntax-number">$1</span>');
      // Keywords (JS/TS/Python)
      s = s.replace(/\\b(function|return|const|let|var|if|else|for|while|class|import|from|export|default|async|await|try|catch|throw|new|this|def|self|yield|with|as|in|not|and|or|True|False|None|true|false|null|undefined|typeof|instanceof)\\b/g, '<span class="syntax-keyword">$1</span>');
      // Built-in functions
      s = s.replace(/\\b(console|print|len|range|map|filter|reduce|parseInt|parseFloat|Math|JSON|Object|Array|String|Number|Promise|setTimeout|require)\\b/g, '<span class="syntax-builtin">$1</span>');
      // Function calls
      s = s.replace(/\\b([a-zA-Z_]\\w*)\\s*\\(/g, '<span class="syntax-function">$1</span>(');
      return s;
    }

    function computeDiff(oldCode, newCode) {
      var oldLines = (oldCode || "").split("\\n");
      var newLines = (newCode || "").split("\\n");
      var maxLen = Math.max(oldLines.length, newLines.length);
      var leftHtml = "";
      var rightHtml = "";
      var addedCount = 0;
      var removedCount = 0;
      var leftLineNum = 0;
      var rightLineNum = 0;

      for (var i = 0; i < maxLen; i++) {
        var oldLine = i < oldLines.length ? oldLines[i] : null;
        var newLine = i < newLines.length ? newLines[i] : null;

        if (oldLine !== null && newLine !== null && oldLine === newLine) {
          leftLineNum++; rightLineNum++;
          leftHtml += '<div class="diff-line unchanged"><span class="diff-line-num">' + leftLineNum + '</span><span class="diff-line-content">' + syntaxHighlight(oldLine) + '</span></div>';
          rightHtml += '<div class="diff-line unchanged"><span class="diff-line-num">' + rightLineNum + '</span><span class="diff-line-content">' + syntaxHighlight(newLine) + '</span></div>';
        } else {
          if (oldLine !== null) {
            leftLineNum++; removedCount++;
            leftHtml += '<div class="diff-line removed"><span class="diff-line-num">' + leftLineNum + '</span><span class="diff-line-content">' + syntaxHighlight(oldLine) + '</span></div>';
          } else {
            leftHtml += '<div class="diff-line unchanged"><span class="diff-line-num"></span><span class="diff-line-content"></span></div>';
          }
          if (newLine !== null) {
            rightLineNum++; addedCount++;
            rightHtml += '<div class="diff-line added"><span class="diff-line-num">' + rightLineNum + '</span><span class="diff-line-content">' + syntaxHighlight(newLine) + '</span></div>';
          } else {
            rightHtml += '<div class="diff-line unchanged"><span class="diff-line-num"></span><span class="diff-line-content"></span></div>';
          }
        }
      }
      return { leftHtml: leftHtml, rightHtml: rightHtml, addedCount: addedCount, removedCount: removedCount };
    }

    async function selectReview(taskId) {
      activeTaskId = taskId;
      editMode = false;
      renderReviewList();

      var detail = document.getElementById("reviewDetail");
      detail.innerHTML = '<div class="card"><div class="muted">Loading review details...</div></div>';

      try {
        var res = await api("/portal/api/reviews/" + encodeURIComponent(taskId));
        renderReviewDetail(res);
      } catch (err) {
        detail.innerHTML = '<div class="card"><div class="muted">Failed to load review: ' + String(err.message || err) + '</div></div>';
      }
    }

    var currentReview = null;

    function renderReviewDetail(data) {
      currentReview = data;
      var detail = document.getElementById("reviewDetail");
      var diff = computeDiff(data.failedCode, data.improvedCode);

      var html = '';
      html += '<div class="card">';
      html += '<h2 style="margin-top:0;">Task</h2>';
      html += '<p style="color:var(--text-secondary);margin:0;font-size:14px;line-height:1.6;">' + escapeHtml(data.task || "No task description") + '</p>';
      if (data.language) {
        html += '<div style="margin-top:8px;">' + statusBadge(data.language, "neutral") + '</div>';
      }
      html += '</div>';

      html += '<div class="card" style="padding:0;overflow:hidden;">';
      html += '<div class="diff-container">';
      html += '<div class="diff-pane diff-pane-left">';
      html += '<div class="diff-pane-header"><span class="diff-file-icon">&#128196;</span> Original (failed)</div>';
      html += diff.leftHtml;
      html += '</div>';
      html += '<div class="diff-pane diff-pane-right">';
      html += '<div class="diff-pane-header"><span class="diff-file-icon">&#128196;</span> Improved</div>';
      html += diff.rightHtml;
      html += '</div>';
      html += '</div>';
      html += '<div class="diff-stats"><span class="added-count">+' + diff.addedCount + ' added</span><span class="removed-count">-' + diff.removedCount + ' removed</span></div>';
      html += '</div>';

      if (data.explanation) {
        html += '<div class="notes-section"><strong>&#128172; Cloud Model Notes:</strong><br>' + escapeHtml(data.explanation) + '</div>';
      }
      if (data.resolvedByModel) {
        html += '<div class="notes-section"><strong>&#9881; Resolved by:</strong> ' + escapeHtml(data.resolvedByModel) + '</div>';
      }

      html += '<div id="editArea"></div>';

      html += '<div class="review-actions" id="reviewActions">';
      html += '<button class="btn-accept" onclick="submitDecision(\\'accept\\')">&#10003; Accept Changes</button>';
      html += '<button class="btn-reject" onclick="submitDecision(\\'reject\\')">&#10007; Reject</button>';
      html += '<button class="btn-edit" onclick="toggleEdit()">&#9998; Edit &amp; Accept</button>';
      html += '</div>';

      detail.innerHTML = html;
    }

    function toggleEdit() {
      editMode = !editMode;
      var editArea = document.getElementById("editArea");
      if (editMode && currentReview) {
        editArea.innerHTML = '<label style="font-size:12px;color:var(--muted);text-transform:uppercase;">Edit improved code before accepting</label>'
          + '<textarea class="edit-area" id="editTextarea">' + escapeHtml(currentReview.improvedCode || "") + '</textarea>';
        document.getElementById("editTextarea").focus();
      } else {
        editArea.innerHTML = "";
      }
    }

    async function submitDecision(decision) {
      if (!activeTaskId) return;
      var body = { decision: decision };
      if (decision === "edit" || (editMode && decision === "accept")) {
        var ta = document.getElementById("editTextarea");
        if (ta) {
          body.decision = "edit";
          body.editedCode = ta.value;
        }
      }

      try {
        await api("/portal/api/reviews/" + encodeURIComponent(activeTaskId) + "/decision", {
          method: "POST",
          body: JSON.stringify(body)
        });
        var detail = document.getElementById("reviewDetail");
        var decisionLabel = body.decision === "accept" ? "accepted" : body.decision === "reject" ? "rejected" : "edited and accepted";
        detail.innerHTML = '<div class="success-banner">Review ' + escapeHtml(decisionLabel) + ' successfully.</div>'
          + '<div class="card empty-state"><h3>Decision submitted</h3><p>Select another review from the list or wait for new escalations.</p></div>';
        activeTaskId = null;
        loadReviews();
      } catch (err) {
        showToast("Failed to submit decision: " + String(err.message || err), true);
      }
    }

    requireAuth().then(function() {
      loadReviews();
    });
  `;

  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Reviews",
    activeTab: "reviews",
    heading: "Code Reviews",
    subtitle: "Review escalated code from the cloud model.",
    content,
    script
  }));
});
}

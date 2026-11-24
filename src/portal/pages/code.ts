// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";
import { icon } from "./design-system.js";
import { CSP_NONCE } from "../csp-nonce.js";
import { CLIENT_SAFE_MARKDOWN_JS } from "./safe-markdown.js";
import { CODE_COMMON_JS } from "./code-common.js";
import { CODE_LIST_JS } from "./code-list.js";
import { CODE_SESSION_JS } from "./code-session.js";
import { CODE_DIFF_JS } from "./code-diff.js";
import { IMAGE_ATTACH_CSS, IMAGE_ATTACH_JS } from "./image-attach.js";

/**
 * Code: the coding sessions running in the EdgeCoder desktop app on your own Macs, on the web. The
 * web twin of the iPhone app's Code mode, through the same relay ("Code from your phone",
 * src/common/code-relay.ts; the portal routes are routes/code.ts):
 *
 *   /portal/code                         each Mac with its trusted projects and shared sessions
 *                                        (newest first), and New session
 *   /portal/code/:agentId/:sessionId     one session: the conversation, tool steps, file changes,
 *                                        approvals and plan approval, a composer, Stop, Undo, mode
 *
 * The sessions run on the Mac; nothing here runs code. The page shell has no user data; its script
 * calls /portal/api/code/* (the owner's session; the coordinator checks the machine's verified owner
 * and the Mac checks its own signed-in account). A Mac that is offline, or has Code from your phone
 * off or on View only, is shown read-only with how to turn it on.
 */
export function registerCodePage(app: FastifyInstance): void {
  const handler = async (_req: unknown, reply: FastifyReply) => {
    const icons = {
      send: icon("arrowRight", 16),
      refresh: icon("refresh", 14),
      stop: icon("x", 14),
      back: icon("chevronLeft", 14),
      plus: icon("plus", 14),
      code: icon("code", 28),
      folder: icon("file", 13),
      file: icon("file", 13),
      x: icon("x", 14),
      image: icon("image", 16),
    };
    const content = `
    <style nonce="${CSP_NONCE}">
      .shell { max-width:none !important; padding:0 !important; }
      .content-stack { padding:0 !important; }
      .code-wrap { max-width:var(--content-max); margin:0 auto; padding:20px 24px 40px; }
      .code-toolbar { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; margin-bottom:14px; }
      .code-toolbar p { margin:0; font-size:13px; color:var(--text-secondary); max-width:640px; line-height:1.55; }
      .code-empty { text-align:center; padding:56px 16px; color:var(--muted); }
      .code-empty .empty-icon { width:52px; height:52px; margin:0 auto 12px; border-radius:var(--radius-md); border:1px solid var(--card-border); display:flex; align-items:center; justify-content:center; }
      .code-empty h3 { color:var(--text-secondary); margin:0 0 8px; font-size:16px; }
      .code-empty p { max-width:440px; margin:0 auto 8px; font-size:13px; line-height:1.6; }
      .cm { border:1px solid var(--card-border); border-radius:var(--radius-md); background:var(--card); padding:14px 16px; margin-bottom:14px; min-width:0; }
      .cm-head { display:flex; gap:10px; align-items:flex-start; justify-content:space-between; }
      .cm-who { min-width:0; }
      .cm-name { margin:0; font-size:15px; overflow-wrap:anywhere; }
      .cm-sub { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; margin-top:2px; }
      .dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--muted); }
      .dot.on { background:var(--ok); }
      .cm-note { margin:10px 0 0; font-size:12.5px; }
      .cp { margin-top:12px; }
      .cp-head { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:12px; color:var(--muted); margin-bottom:4px; }
      .cp-name { display:inline-flex; align-items:center; gap:5px; font-weight:600; color:var(--text-secondary); font-size:13px; }
      .cp-empty { font-size:12px; color:var(--muted); padding:4px 0; }
      .cs-rows { display:flex; flex-direction:column; }
      .cs-row { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:9px 10px; margin:0 -10px; border-radius:var(--radius-sm); color:var(--text); text-decoration:none; min-width:0; }
      .cs-row:hover, .cs-row:focus-visible { background:var(--bg-elevated); }
      .cs-row-text { display:flex; flex-direction:column; min-width:0; gap:2px; }
      .cs-row-title { font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .cs-row-sub { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .chip { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; border:1px solid var(--card-border); color:var(--text-secondary); white-space:nowrap; flex:none; }
      .chip.tone-accent { color:var(--brand-2); border-color:var(--brand-border); background:var(--brand-soft); }
      .chip.tone-warn { color:var(--yellow); border-color:color-mix(in srgb, var(--yellow) 40%, transparent); background:color-mix(in srgb, var(--yellow) 10%, transparent); }
      dialog.code-new { width:min(520px, calc(100vw - 32px)); border:1px solid var(--border-strong); border-radius:var(--radius-md); background:var(--bg-surface); color:var(--text); padding:0; }
      dialog.code-new::backdrop { background:var(--scrim); }
      .code-new form { padding:18px 20px; display:flex; flex-direction:column; gap:12px; }
      .code-new label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--text-secondary); }
      .code-new .foot { display:flex; justify-content:flex-end; gap:8px; }

      /* ── One session ── */
      .cs-view { display:flex; flex-direction:column; height:calc(100vh - var(--topbar-h)); height:calc(100dvh - var(--topbar-h)); min-height:0; }
      .cs-head { display:flex; gap:12px; align-items:flex-start; padding:12px 20px; border-bottom:1px solid var(--card-border); }
      .cs-head .who { flex:1; min-width:0; }
      .cs-head .back { font-size:12px; color:var(--muted); text-decoration:none; display:inline-flex; align-items:center; gap:2px; }
      .cs-head .line1 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:2px; }
      .cs-head h2 { font-size:16px; margin:0; overflow-wrap:anywhere; }
      .cs-head .meta { font-size:12px; color:var(--muted); margin-top:3px; overflow-wrap:anywhere; }
      .cs-head .actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
      #codeList [hidden], #codeSession [hidden] { display:none !important; }
      .cs-head select { width:auto; min-height:30px; padding:4px 8px; }
      .cs-note { margin:10px 20px 0; }
      .cs-scroll { flex:1; overflow-y:auto; min-height:0; }
      .cs-thread { max-width:820px; margin:0 auto; padding:12px 20px 20px; }
      .older-row { text-align:center; padding:6px 0 10px; }
      .code-wait { text-align:center; padding:40px 0; font-size:13px; }
      .cmsg { padding:12px 0; line-height:1.65; font-size:14px; min-width:0; }
      .cmsg + .cmsg { border-top:1px solid var(--card-border); }
      .cmsg-head { display:flex; align-items:center; gap:8px; margin-bottom:4px; font-size:11px; color:var(--muted); }
      .cmsg-head .who { font-weight:700; text-transform:uppercase; letter-spacing:0.4px; }
      .cmsg.user .who { color:var(--brand-2); }
      .cmsg-head .working { display:inline-flex; align-items:center; gap:6px; }
      .cmsg.note { font-size:12px; color:var(--muted); padding:6px 0; text-align:center; overflow-wrap:anywhere; }
      .cmsg-foot { font-size:12px; color:var(--muted); margin-top:4px; }
      .msg-body { overflow-wrap:anywhere; }
      .msg-body pre { background:var(--bg-input); padding:10px 12px; border-radius:var(--radius-sm); overflow-x:auto; border:1px solid var(--card-border); }
      .msg-body code { font-family:var(--font-mono); font-size:12.5px; }
      .msg-body :not(pre) > code { background:var(--bg-elevated); padding:1px 5px; border-radius:4px; }
      details > summary { cursor:pointer; font-size:12px; color:var(--text-secondary); }
      .steps-d, .chg-d { margin:4px 0 6px; }
      .chg-d > summary { display:inline-flex; align-items:center; gap:5px; font-weight:600; }
      .chg-body { margin-top:6px; }
      .steps { list-style:none; margin:6px 0 0; padding:0; display:flex; flex-direction:column; gap:3px; }
      .steps li { font-size:12px; color:var(--text-secondary); display:flex; gap:6px; min-width:0; }
      .s-tool { font-family:var(--font-mono); color:var(--muted); flex:none; font-size:12px; }
      .steps .s-detail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1; }
      .steps .s-status { flex:none; color:var(--muted); }
      .steps .st-error .s-status, .steps .st-denied .s-status { color:var(--danger-ink); }
      .steps .st-pending .s-status { color:var(--yellow); }
      .cd-file { border:1px solid var(--card-border); border-radius:var(--radius-sm); margin:6px 0; background:var(--bg-surface); min-width:0; }
      .cd-file > summary { display:flex; gap:8px; justify-content:space-between; padding:6px 10px; }
      .cd-path { font-family:var(--font-mono); overflow-wrap:anywhere; min-width:0; }
      .cd-what { flex:none; color:var(--muted); }
      pre.diff { margin:0; padding:6px 0; overflow-x:auto; font-family:var(--font-mono); font-size:12px; line-height:1.5; border-top:1px solid var(--card-border); max-height:60vh; }
      pre.diff .dl { display:block; padding:0 10px; white-space:pre; min-width:max-content; }
      pre.diff .add { color:var(--ok); background:color-mix(in srgb, var(--ok) 10%, transparent); }
      pre.diff .del { color:var(--danger-ink); background:color-mix(in srgb, var(--danger) 12%, transparent); }
      pre.diff .fold { color:var(--muted); }
      .queued { display:flex; gap:8px; align-items:flex-start; padding:10px 12px; margin:8px 0; border-radius:var(--radius-md); background:var(--bg-elevated); }
      .queued .q-text { flex:1; min-width:0; font-size:13px; overflow-wrap:anywhere; white-space:pre-wrap; }
      .queued .q-label { display:block; font-size:11px; font-weight:600; color:var(--muted); }
      .ask-card { margin:10px 0; padding:12px 14px; border:1px solid color-mix(in srgb, var(--yellow) 45%, transparent); border-radius:var(--radius-md); background:color-mix(in srgb, var(--yellow) 6%, var(--bg-surface)); min-width:0; }
      .ask-card.plan { border-color:var(--brand-border); background:var(--brand-soft); }
      .ask-card .ask-q { font-weight:600; font-size:13px; margin-bottom:6px; }
      .ask-card .ask-tool { font-size:12px; color:var(--text-secondary); overflow-wrap:anywhere; margin-bottom:6px; }
      .ask-card code { display:block; font-family:var(--font-mono); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg-input); padding:6px 8px; border-radius:var(--radius-sm); max-height:40vh; overflow:auto; }
      .ask-card .ask-choices { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center; }
      .ask-card .on-mac { font-size:12px; color:var(--muted); }
      .composer { border-top:1px solid var(--card-border); padding:10px 20px 14px; }
      .composer-pill { max-width:820px; margin:0 auto; display:flex; align-items:flex-end; gap:8px; padding:6px 6px 6px 16px; border:1px solid var(--card-border); border-radius:22px; background:var(--bg-input); }
      .composer-pill:focus-within { border-color:var(--brand); box-shadow:0 0 0 3px var(--brand-soft); }
      .composer-pill textarea { flex:1; resize:none; border:none; background:transparent; color:var(--text); font:inherit; font-size:14px; line-height:1.5; padding:6px 0; min-height:0; max-height:40vh; outline:none; box-shadow:none; }
      .composer-pill .send { width:32px; height:32px; min-height:0; padding:0; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; flex:none; }
      .cs-imgs { max-width:820px; margin:0 auto 8px; }
      .cs-imgs:has(.img-tray:empty) { display:none; }
      .composer-pill .img-attach { margin-left:-10px; }
${IMAGE_ATTACH_CSS}      .composer .controls { max-width:820px; margin:6px auto 0; font-size:11.5px; color:var(--muted); display:flex; gap:10px; justify-content:space-between; }
      .visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
      @media (max-width:700px) {
        .code-wrap { padding:14px 16px 32px; }
        .code-toolbar { flex-direction:column; }
        .cs-head { flex-wrap:wrap; padding:10px 16px; }
        .cs-head .actions { width:100%; justify-content:flex-start; }
        .cs-note { margin:8px 16px 0; }
        .cs-thread { padding:10px 16px 16px; }
        .composer { padding:8px 16px 12px; }
        .composer .controls { flex-direction:column; gap:2px; }
      }
    </style>
    <section id="codeList" aria-labelledby="codeListHeading" hidden>
      <div class="code-wrap">
        <h2 id="codeListHeading" class="visually-hidden">Your Macs</h2>
        <div class="code-toolbar">
          <p>Coding sessions running in the EdgeCoder app on your Macs. Read them, reply, answer approvals and stop a turn from here; the work stays on the Mac. A Mac shows up once <strong>Code from your phone</strong> is on in the app's Settings.</p>
          <button type="button" class="sm" id="codeRefresh">${icons.refresh}<span>Refresh</span></button>
        </div>
        <div id="codeMachines"><div class="loading-state"><span class="loading-spinner sm"></span> Loading your Macs…</div></div>
      </div>
      <dialog class="code-new" id="cnDialog" aria-labelledby="cnTitle">
        <form id="cnForm" method="dialog">
          <h3 id="cnTitle" class="u-m-0">New session</h3>
          <p class="muted u-fs-12 u-m-0" id="cnWhere"></p>
          <label>Project<select name="projectId" id="cnProject" required></select></label>
          <label>Title (optional)<input name="title" maxlength="120" autocomplete="off" /></label>
          <label>Mode<select name="mode" id="cnMode"></select></label>
          <p class="muted u-fs-12 u-m-0">Commands that aren't read-only always ask first. Auto mode is turned on from the Mac only.</p>
          <div id="cnError" class="callout danger u-m-0" role="alert" hidden></div>
          <div class="foot"><button type="button" id="cnCancel">Cancel</button><button type="submit" class="primary" id="cnSave">Start session</button></div>
        </form>
      </dialog>
    </section>
    <section id="codeSession" hidden>
      <div class="cs-view">
        <header class="cs-head">
          <div class="who">
            <a class="back" href="/portal/code">${icons.back}<span>All sessions</span></a>
            <div class="line1"><h2 id="csTitle">Session</h2><span class="chip" id="csChip"></span></div>
            <div class="meta" id="csMeta"></div>
          </div>
          <div class="actions">
            <label for="csMode" class="visually-hidden">Permission mode</label>
            <select id="csMode" hidden></select>
            <button type="button" class="sm danger" id="csStop" hidden>${icons.stop}<span>Stop</span></button>
            <button type="button" class="sm" id="csUndo" hidden><span>Undo last turn</span></button>
            <button type="button" class="sm ghost" id="csRefresh" aria-label="Refresh" title="Refresh">${icons.refresh}</button>
          </div>
        </header>
        <div class="callout warn cs-note" id="csNote" role="status" hidden></div>
        <div class="cs-scroll" id="csScroll">
          <div class="cs-thread">
            <div class="older-row"><button type="button" class="sm ghost" id="csOlder" hidden>Load earlier messages</button></div>
            <div id="csMessages" aria-live="polite" aria-relevant="additions"></div>
            <div id="csLive"></div>
          </div>
        </div>
        <div class="composer">
          <div class="cs-imgs"><div class="img-tray" id="csImgs" aria-label="Images to send"></div></div>
          <div class="composer-pill" id="csPill">
            <button type="button" class="img-attach" id="csAttach" aria-label="Attach images" title="Attach images (or paste or drop them)" hidden>${icons.image}</button>
            <input type="file" id="csFile" accept="image/png,image/jpeg,image/webp" multiple hidden>
            <label for="csInput" class="visually-hidden">Message your Mac</label>
            <textarea id="csInput" rows="1" placeholder="Message your Mac…" autocomplete="off" disabled></textarea>
            <button type="button" class="primary send" id="csSend" aria-label="Send" disabled>${icons.send}</button>
          </div>
          <div class="controls"><span>Enter to send, Shift+Enter for a new line. It runs on your Mac.</span><span id="csWorking" role="status"></span></div>
        </div>
      </div>
    </section>
    `;
    const script = `
    ${CLIENT_SAFE_MARKDOWN_JS}
    var CODE_ICONS = ${JSON.stringify(icons)};
    ${CODE_COMMON_JS}
    ${CODE_DIFF_JS}
    ${IMAGE_ATTACH_JS}
    ${CODE_LIST_JS}
    ${CODE_SESSION_JS}
    (async function() {
      try { await requireAuth(); } catch (_e) { return; }
      var m = /^\\/portal\\/code\\/([^/]+)\\/([^/]+)\\/?$/.exec(location.pathname);
      if (m) initSession(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      else initList();
    })();
    `;
    return reply.type("text/html").send(
      portalAuthedPageHtml({
        title: "EdgeCoder | Code",
        activeTab: "code",
        heading: "Code",
        subtitle: "Coding sessions on your Macs",
        content,
        script,
      }),
    );
  };
  app.get("/portal/code", handler);
  app.get("/portal/code/:agentId/:sessionId", handler);
}

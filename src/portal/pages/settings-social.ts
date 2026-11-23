// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { CSP_NONCE } from "../csp-nonce.js";
import { SETTINGS_HELPERS_SCRIPT, settingRow, settingsPage } from "./settings-shell.js";

/**
 * Settings > Social posts (/portal/settings/social), system admins only: the brand account's post
 * queue (src/portal/social.ts, src/social). The page shell carries no data; its script calls
 * /portal/api/admin/social*, which check the session is a system admin.
 *
 * - The switch: off (paused) stops all drafting and sending. Sending also needs
 *   SOCIAL_POSTING_ENABLED=1 on the portal; the page shows whether it is set, and whether X and
 *   Nostr are configured (never the values).
 * - Compose a draft by hand (release notes for iOS, anything else), optionally in a thread, with a
 *   send time and up to 4 images (PNG/JPEG, 5 MB each).
 * - The queue: edit, approve (sends at once when sending is on and it is due) or reject each draft;
 *   image thumbnails (click to enlarge, add with alt text, remove), the send time (shown and edited in America/Chicago
 *   time) and the thread. A thread is approved as a whole. A draft that breaks a rule lists the
 *   problems and cannot be approved until it is edited.
 * - Recent: posted (with the X post and Nostr note links) and rejected.
 */
export function socialPageContent(): string {
  return `
    <style nonce="${CSP_NONCE}">
      .soc-post { border:1px solid var(--card-border); border-radius:var(--radius-md); background:var(--card); padding:12px; margin-bottom:10px; }
      .soc-post-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--muted); margin-bottom:8px; }
      .soc-post textarea, #socCompose { width:100%; min-height:96px; font-size:13px; line-height:1.45; resize:vertical; }
      .soc-meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px; font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
      .soc-meta .over { color:var(--danger-ink); font-weight:600; }
      .soc-problems { margin:6px 0 0; padding-left:18px; font-size:12.5px; color:var(--danger-ink); }
      .soc-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
      .soc-error { font-size:12.5px; color:var(--danger-ink); margin-top:6px; }
      .soc-empty { color:var(--muted); font-size:13px; padding:4px 0; }
      .soc-table { overflow-x:auto; }
      .soc-recent td { font-size:12.5px; vertical-align:top; }
      .soc-recent .txt { max-width:420px; white-space:pre-wrap; }
      .soc-recent a { color:var(--brand-2); }
      .soc-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; font-size:12.5px; }
      .soc-row label { color:var(--muted); }
      .soc-row input[type="text"] { width:160px; }
      .soc-row input[type="number"] { width:70px; }
      .soc-thumbs { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
      .soc-thumb { display:flex; flex-direction:column; gap:4px; align-items:flex-start; font-size:11.5px; color:var(--muted); max-width:120px; }
      .soc-thumb img { width:120px; height:90px; object-fit:cover; border-radius:var(--radius-md); border:1px solid var(--card-border); }
      .soc-thumb-open { padding:0; border:0; background:none; cursor:zoom-in; border-radius:var(--radius-md); }
      .soc-thumb-open:focus-visible { outline:2px solid var(--brand-2); outline-offset:2px; }
      .soc-lightbox { border:0; padding:0; background:transparent; max-width:96vw; max-height:96vh; }
      .soc-lightbox::backdrop { background:rgba(0,0,0,0.85); }
      .soc-lightbox figure { margin:0; display:flex; flex-direction:column; align-items:center; gap:8px; }
      .soc-lightbox img { max-width:94vw; max-height:84vh; object-fit:contain; border-radius:var(--radius-md); background:#000; }
      .soc-lightbox figcaption { color:#fff; font-size:13px; text-align:center; max-width:94vw; }
      .soc-lightbox-bar { display:flex; gap:8px; justify-content:center; align-items:center; }
      .soc-lightbox-bar span { color:#ccc; font-size:12.5px; }
      .soc-thread { border-left:3px solid var(--brand-2); padding-left:10px; margin-bottom:12px; }
      .soc-thread-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12.5px; margin-bottom:6px; }
    </style>
    <h2 class="set-title">Social posts</h2>
    <p class="set-lead">Posts for the EdgeCoder brand account on X, cross-posted to Nostr. Drafts come from live network data, new releases and new docs pages; every post needs your approval.</p>
    <div id="socDenied" class="callout warn hidden"><h3>Admin access required</h3><div class="muted">This section is only available to system administrators.</div></div>
    <div id="socError" class="callout warn hidden"></div>
    <div id="socBody" class="hidden">
      <div class="set-card">
        ${settingRow("Posting", 'Off pauses everything: no drafts are made and nothing is sent. Sending also needs <code>SOCIAL_POSTING_ENABLED=1</code> on the portal.', '<span class="set-value" id="socSwitchState">-</span><button type="button" id="socSwitch" class="primary">-</button>')}
        ${settingRow("Accounts", "Whether the credentials are set on the portal. Values are never shown.", '<span id="socChannels" class="muted"></span>')}
        ${settingRow("Draft now", "Run the drafting job now: weekly report, new releases (desktop and agent), new docs pages. Nothing runs while paused.", '<button type="button" id="socRun" class="btn-secondary">Draft now</button>')}
      </div>
      <div class="muted" id="socStatus" role="status"></div>
      <h3 class="set-group">Compose</h3>
      <div class="soc-post">
        <textarea id="socCompose" maxlength="2000" placeholder="Write a post (iOS release notes, announcements). Original posts only: no @mentions." aria-label="New post"></textarea>
        <div class="soc-meta" id="socComposeMeta"></div>
        <ul class="soc-problems" id="socComposeProblems"></ul>
        <div class="soc-row">
          <label for="socComposeThread">Thread (optional)</label><input type="text" id="socComposeThread" maxlength="100" placeholder="e.g. launch-week">
          <label for="socComposePos">Position</label><input type="number" id="socComposePos" min="1" max="1000" placeholder="next">
        </div>
        <div class="soc-row">
          <label for="socComposeWhen">Send time (America/Chicago, optional)</label><input type="datetime-local" id="socComposeWhen">
        </div>
        <div class="soc-row">
          <label for="socComposeImages">Images (up to 4, PNG/JPEG, 5 MB each)</label><input type="file" id="socComposeImages" accept="image/png,image/jpeg" multiple>
        </div>
        <div class="soc-actions"><button type="button" class="primary" id="socComposeBtn">Save draft</button></div>
      </div>
      <h3 class="set-group">Queue</h3>
      <div id="socQueue"></div>
      <dialog id="socLightbox" class="soc-lightbox" aria-label="Image preview">
        <figure><img id="socLightboxImg" alt=""><figcaption id="socLightboxCap"></figcaption></figure>
        <div class="soc-lightbox-bar">
          <button type="button" class="btn-secondary" id="socLightboxPrev" aria-label="Previous image">&larr;</button>
          <span id="socLightboxPos"></span>
          <button type="button" class="btn-secondary" id="socLightboxNext" aria-label="Next image">&rarr;</button>
          <a class="btn-secondary" id="socLightboxOpen" target="_blank" rel="noopener">Open full size</a>
          <button type="button" class="primary" id="socLightboxClose">Close</button>
        </div>
      </dialog>
      <h3 class="set-group">Recent</h3>
      <div class="set-card soc-recent"><div class="soc-table">
        <table><thead><tr><th>When</th><th>Status</th><th>Post</th><th>Links</th></tr></thead><tbody id="socRecent"></tbody></table>
      </div></div>
    </div>`;
}

export function socialPageScript(): string {
  return `
    ${SETTINGS_HELPERS_SCRIPT}
    const $ = (id) => document.getElementById(id);
    const KIND = { weekly: "Weekly report", release: "Release", docs: "Docs", manual: "Manual", import: "Imported" };
    const TZ_LABEL = "America/Chicago";
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    // Lightbox: click a thumbnail to see the image large; arrows step through that post's images.
    let lbImages = [], lbIndex = 0;
    function lbShow() {
      const img = lbImages[lbIndex];
      if (!img) return;
      $("socLightboxImg").src = img.url;
      $("socLightboxImg").alt = img.alt || img.filename || "";
      $("socLightboxCap").textContent = img.alt ? img.alt : (img.filename || "");
      $("socLightboxOpen").href = img.url;
      $("socLightboxPos").textContent = lbImages.length > 1 ? (lbIndex + 1) + " / " + lbImages.length : "";
      $("socLightboxPrev").hidden = lbImages.length < 2;
      $("socLightboxNext").hidden = lbImages.length < 2;
    }
    function openLightbox(images, index) {
      lbImages = images; lbIndex = index; lbShow();
      const d = $("socLightbox");
      if (typeof d.showModal === "function") { if (!d.open) d.showModal(); }
      else window.open(images[index].url, "_blank", "noopener");
    }
    function lbStep(delta) { if (lbImages.length < 2) return; lbIndex = (lbIndex + delta + lbImages.length) % lbImages.length; lbShow(); }
    $("socLightboxPrev").addEventListener("click", () => lbStep(-1));
    $("socLightboxNext").addEventListener("click", () => lbStep(1));
    $("socLightboxClose").addEventListener("click", () => $("socLightbox").close());
    $("socLightbox").addEventListener("click", (e) => { if (e.target === $("socLightbox")) $("socLightbox").close(); });
    $("socLightbox").addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); lbStep(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); lbStep(1); }
    });
    function readBase64(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || "").replace(/^data:[^,]*,/, ""));
        fr.onerror = () => reject(fr.error || new Error("read failed"));
        fr.readAsDataURL(file);
      });
    }
    async function uploadImage(postId, file, alt) {
      if (!/^image\\/(png|jpeg)$/.test(file.type)) return { ok: false, json: { error: file.name + ": only PNG or JPEG" } };
      if (file.size > MAX_IMAGE_BYTES) return { ok: false, json: { error: file.name + ": larger than 5 MB" } };
      const base64 = await readBase64(file);
      return call("/portal/api/admin/social/posts/" + encodeURIComponent(postId) + "/images", { method: "POST", body: JSON.stringify({ filename: file.name, base64, alt: alt || null }) });
    }
    const TONE = { draft: "info", approved: "ok", posting: "warn", posted: "ok", rejected: "", failed: "danger" };
    let state = null;
    function badge(text, tone) { return el("span", { class: "status-badge " + (tone || "") }, text); }
    function setStatus(t) { $("socStatus").textContent = t || ""; }
    function showError(t) { const e = $("socError"); e.textContent = t; e.classList.remove("hidden"); }
    function meta(box, length, max) {
      box.textContent = "";
      box.appendChild(el("span", { class: length > max ? "over" : "" }, length + " / " + max + " (links count 23)"));
    }
    function problemsList(ul, problems) {
      ul.textContent = "";
      for (const p of problems || []) ul.appendChild(el("li", {}, p.message));
    }
    let checkTimer = null;
    function liveCheck(text, metaBox, ul) {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(async () => {
        if (!text.trim()) { metaBox.textContent = ""; ul.textContent = ""; return; }
        const r = await call("/portal/api/admin/social/check", { method: "POST", body: JSON.stringify({ text }) });
        if (!r.ok) return;
        meta(metaBox, r.json.length, r.json.maxLength);
        problemsList(ul, r.json.problems);
      }, 300);
    }
    function renderSwitch() {
      const on = state.settings.enabled;
      $("socSwitchState").textContent = on ? (state.sending.ok ? "On" : "On (not sending: " + state.sending.reason + ")") : "Paused";
      $("socSwitch").textContent = on ? "Pause" : "Turn on";
      $("socSwitch").className = on ? "btn-secondary" : "primary";
      const c = state.channels;
      $("socChannels").textContent = "X: " + (c.x.configured ? "configured" : "not configured") +
        " · Nostr: " + (c.nostr.configured ? "configured (" + c.nostr.relays.length + " relays)" : c.nostr.invalid ? "NOSTR_BRAND_NSEC is invalid (skipped)" : "not configured (skipped)") +
        " · SOCIAL_POSTING_ENABLED: " + (c.sendEnabledEnv ? "1" : "not set");
    }
    function renderPost(p) {
      const box = el("div", { class: "soc-post", "data-id": p.id });
      const head = el("div", { class: "soc-post-head" });
      head.appendChild(badge(p.status, TONE[p.status]));
      head.appendChild(el("span", {}, KIND[p.kind] || p.kind));
      head.appendChild(el("span", { class: "mono" }, p.sourceKey.startsWith("manual:") ? "manual" : p.sourceKey));
      head.appendChild(el("span", {}, "updated " + fmtDate(p.updatedAtMs)));
      if (p.approvedBy) head.appendChild(el("span", {}, "approved by " + p.approvedBy));
      if (p.threadId) head.appendChild(el("span", {}, "thread post " + (p.threadPosition || "?")));
      head.appendChild(el("span", {}, p.scheduledAtLocal ? "sends " + p.scheduledAtLocal.replace("T", " ") + " (" + TZ_LABEL + ")" : "sends when approved"));
      box.appendChild(head);
      const editable = p.status === "draft" || p.status === "failed";
      const schedulable = editable || p.status === "approved";
      const ta = el("textarea", { maxlength: "2000", "aria-label": "Post text" });
      ta.value = p.text;
      if (!editable) ta.setAttribute("readonly", "");
      box.appendChild(ta);
      const m = el("div", { class: "soc-meta" }); meta(m, p.length, p.maxLength); box.appendChild(m);
      const ul = el("ul", { class: "soc-problems" }); problemsList(ul, p.problems); box.appendChild(ul);
      if (p.error) box.appendChild(el("div", { class: "soc-error" }, p.error));
      ta.addEventListener("input", () => liveCheck(ta.value, m, ul));
      // Images: thumbnails, remove, add (with alt text).
      const images = p.images || [];
      if (images.length) {
        const thumbs = el("div", { class: "soc-thumbs" });
        images.forEach((img, i) => {
          const t = el("div", { class: "soc-thumb" });
          const open = el("button", { type: "button", class: "soc-thumb-open", "aria-label": "View image " + (i + 1) + " larger" });
          open.appendChild(el("img", { src: img.url, alt: img.alt || img.filename, title: "Click to enlarge", loading: "lazy" }));
          open.addEventListener("click", () => openLightbox(images, i));
          t.appendChild(open);
          t.appendChild(el("span", {}, img.alt ? "Alt: " + img.alt : "No alt text"));
          if (editable) {
            const rm = el("button", { type: "button", class: "btn-secondary" }, "Remove");
            rm.addEventListener("click", () => act(p.id, "images/" + encodeURIComponent(img.id) + "/delete", {}, rm));
            t.appendChild(rm);
          }
          thumbs.appendChild(t);
        });
        box.appendChild(thumbs);
      }
      if (editable && images.length < 4) {
        const row = el("div", { class: "soc-row" });
        const file = el("input", { type: "file", accept: "image/png,image/jpeg", "aria-label": "Image" });
        const alt = el("input", { type: "text", maxlength: "1000", placeholder: "Alt text (optional)", "aria-label": "Alt text" });
        const add = el("button", { type: "button", class: "btn-secondary" }, "Add image");
        add.addEventListener("click", async () => {
          const f = file.files && file.files[0];
          if (!f) return;
          add.disabled = true;
          try {
            const r = await uploadImage(p.id, f, alt.value.trim());
            setStatus(r.ok ? "Image added." : "Image not added: " + ((r.json.problems || []).map((x) => x.message).join(" ") || r.json.error || r.status));
            await load();
          } finally { add.disabled = false; }
        });
        row.appendChild(el("label", {}, "Image (" + images.length + "/4)"));
        row.appendChild(file); row.appendChild(alt); row.appendChild(add);
        box.appendChild(row);
      }
      if (schedulable) {
        const row = el("div", { class: "soc-row" });
        const when = el("input", { type: "datetime-local", "aria-label": "Send time (" + TZ_LABEL + ")" });
        when.value = p.scheduledAtLocal || "";
        const setT = el("button", { type: "button", class: "btn-secondary" }, "Save time");
        setT.addEventListener("click", () => { if (when.value) act(p.id, "schedule", { scheduledAtLocal: when.value }, setT); });
        const clr = el("button", { type: "button", class: "btn-secondary" }, "Clear time");
        clr.addEventListener("click", () => act(p.id, "schedule", { scheduledAtLocal: null }, clr));
        row.appendChild(el("label", {}, "Send time (" + TZ_LABEL + ")" + (p.threadId ? ", whole thread" : "")));
        row.appendChild(when); row.appendChild(setT); row.appendChild(clr);
        box.appendChild(row);
      }
      if (editable) {
        const row = el("div", { class: "soc-row" });
        const th = el("input", { type: "text", maxlength: "100", placeholder: "none", "aria-label": "Thread" });
        th.value = p.threadId || "";
        const pos = el("input", { type: "number", min: "1", max: "1000", placeholder: "last", "aria-label": "Position" });
        if (p.threadPosition) pos.value = String(p.threadPosition);
        const setTh = el("button", { type: "button", class: "btn-secondary" }, "Save thread");
        setTh.addEventListener("click", () => act(p.id, "thread", { threadId: th.value.trim() || null, ...(pos.value ? { position: Number(pos.value) } : {}) }, setTh));
        row.appendChild(el("label", {}, "Thread")); row.appendChild(th);
        row.appendChild(el("label", {}, "Position")); row.appendChild(pos); row.appendChild(setTh);
        box.appendChild(row);
      }
      const actions = el("div", { class: "soc-actions" });
      if (editable) {
        const save = el("button", { type: "button", class: "btn-secondary" }, "Save edit");
        save.addEventListener("click", () => act(p.id, "edit", { text: ta.value }, save));
        const approve = el("button", { type: "button", class: "primary" }, p.threadId ? "Approve thread" : p.status === "failed" ? "Approve again" : "Approve");
        approve.addEventListener("click", () => {
          const later = p.scheduledAtLocal ? " at " + p.scheduledAtLocal.replace("T", " ") + " (" + TZ_LABEL + ")" : " now";
          const what = p.threadId ? "this whole thread" : "this";
          if (!confirm(state.sending.ok ? "Approve and post " + what + " to X" + (state.channels.nostr.configured ? " and Nostr" : "") + later + "?" : "Approve " + what + "? It is sent once posting is on.")) return;
          act(p.id, "approve", ta.value !== p.text ? { text: ta.value } : {}, approve);
        });
        actions.appendChild(save); actions.appendChild(approve);
      }
      if (p.status === "draft" || p.status === "failed" || p.status === "approved") {
        const reject = el("button", { type: "button", class: "danger" }, "Reject");
        reject.addEventListener("click", () => act(p.id, "reject", {}, reject));
        actions.appendChild(reject);
      }
      box.appendChild(actions);
      return box;
    }
    function renderRecent() {
      const body = $("socRecent");
      body.textContent = "";
      for (const p of state.recent) {
        const tr = el("tr");
        tr.appendChild(el("td", { class: "nowrap" }, fmtDate(p.postedAtMs || p.updatedAtMs)));
        const st = el("td"); st.appendChild(badge(p.status, TONE[p.status])); tr.appendChild(st);
        tr.appendChild(el("td", { class: "txt" }, p.text));
        const links = el("td");
        if (p.xUrl) { const a = el("a", { href: p.xUrl, target: "_blank", rel: "noopener noreferrer" }, "X post"); links.appendChild(a); }
        if (p.nostrUrl) { links.appendChild(el("br")); const a = el("a", { href: p.nostrUrl, target: "_blank", rel: "noopener noreferrer", title: p.nostrNoteId }, "Nostr note"); links.appendChild(a); }
        if (p.nostrNote) links.appendChild(el("div", { class: "muted" }, "Nostr: " + p.nostrNote));
        tr.appendChild(links);
        body.appendChild(tr);
      }
      if (!state.recent.length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "4" }, "Nothing posted yet.")); body.appendChild(tr); }
    }
    function render() {
      $("socError").classList.add("hidden");
      $("socBody").classList.remove("hidden");
      renderSwitch();
      const q = $("socQueue");
      q.textContent = "";
      // Threads together, in position order; single posts as they come.
      const groups = new Map();
      for (const p of state.queue) {
        const k = p.threadId ? "t:" + p.threadId : "p:" + p.id;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      }
      for (const [k, posts] of groups) {
        if (!k.startsWith("t:")) { q.appendChild(renderPost(posts[0])); continue; }
        posts.sort((a, b) => (a.threadPosition || 0) - (b.threadPosition || 0));
        const wrap = el("div", { class: "soc-thread" });
        const head = el("div", { class: "soc-thread-head" });
        head.appendChild(el("strong", {}, "Thread " + posts[0].threadId));
        head.appendChild(el("span", { class: "muted" }, posts.length + " post(s) waiting. Approving one approves them all; each next post replies to the one before it."));
        wrap.appendChild(head);
        for (const p of posts) wrap.appendChild(renderPost(p));
        q.appendChild(wrap);
      }
      if (!state.queue.length) q.appendChild(el("div", { class: "soc-empty" }, "No drafts waiting."));
      renderRecent();
    }
    async function load() {
      const r = await call("/portal/api/admin/social", { method: "GET", headers: {} });
      if (r.status === 401 || r.status === 403) { $("socDenied").classList.remove("hidden"); return; }
      if (!r.ok) { showError("Could not load social posts: " + (r.json.error || r.status)); return; }
      state = r.json;
      render();
    }
    async function act(id, action, body, btn) {
      btn.disabled = true;
      try {
        const r = await call("/portal/api/admin/social/posts/" + encodeURIComponent(id) + "/" + action, { method: "POST", body: JSON.stringify(body) });
        if (r.ok) {
          const p = r.json.post || {};
          setStatus(r.json.note || (p.status === "posted" ? "Posted." : p.status === "failed" ? "Not posted: " + (p.error || "failed") : "Saved: " + p.status + "."));
        } else {
          setStatus("Not done: " + ((r.json.problems || []).map((x) => x.message).join(" ") || r.json.error || r.status));
        }
        await load();
      } finally {
        btn.disabled = false;
      }
    }
    $("socSwitch").addEventListener("click", async () => {
      const on = !state.settings.enabled;
      if (on && !confirm("Turn on brand posting? Drafting starts, and approved posts are sent when SOCIAL_POSTING_ENABLED=1.")) return;
      const r = await call("/portal/api/admin/social/settings", { method: "POST", body: JSON.stringify({ enabled: on }) });
      setStatus(r.ok ? (on ? "Posting is on." : "Posting is paused.") : "Could not change: " + (r.json.error || r.status));
      await load();
    });
    $("socRun").addEventListener("click", async () => {
      const btn = $("socRun"); btn.disabled = true; setStatus("Drafting...");
      try {
        const r = await call("/portal/api/admin/social/run", { method: "POST", body: "{}" });
        setStatus(!r.ok ? "Failed: " + (r.json.error || r.status) : r.json.skipped ? "Skipped: " + r.json.skipped + "." : r.json.drafted + " new draft(s), " + r.json.sent + " sent.");
        await load();
      } finally { btn.disabled = false; }
    });
    $("socCompose").addEventListener("input", () => liveCheck($("socCompose").value, $("socComposeMeta"), $("socComposeProblems")));
    $("socComposeBtn").addEventListener("click", async () => {
      const text = $("socCompose").value;
      if (!text.trim()) return;
      const files = Array.from($("socComposeImages").files || []);
      if (files.length > 4) { setStatus("Not saved: at most 4 images."); return; }
      const body = { text };
      const thread = $("socComposeThread").value.trim();
      if (thread) body.threadId = thread;
      if (thread && $("socComposePos").value) body.position = Number($("socComposePos").value);
      if ($("socComposeWhen").value) body.scheduledAtLocal = $("socComposeWhen").value;
      const btn = $("socComposeBtn"); btn.disabled = true;
      try {
        const r = await call("/portal/api/admin/social/drafts", { method: "POST", body: JSON.stringify(body) });
        if (r.ok) {
          const failed = [];
          for (const f of files) {
            const u = await uploadImage(r.json.post.id, f, "");
            if (!u.ok) failed.push((u.json && u.json.error) || f.name);
          }
          for (const id of ["socCompose", "socComposeThread", "socComposePos", "socComposeWhen", "socComposeImages"]) $(id).value = "";
          $("socComposeMeta").textContent = ""; $("socComposeProblems").textContent = "";
          setStatus(failed.length ? "Draft saved; images not added: " + failed.join("; ") : "Draft saved.");
        } else setStatus("Not saved: " + (r.json.error || r.status));
        await load();
      } finally { btn.disabled = false; }
    });
    (async () => {
      const me = await requireAuth();
      revealSettingsAdminTab(me);
      const user = me.user || {};
      if (!(user.roles && user.roles.isSystemAdmin)) { $("socDenied").classList.remove("hidden"); return; }
      await load();
    })().catch((err) => showError("Could not load social posts: " + String(err.message || err)));
    `;
}

export function registerSettingsSocialPage(app: FastifyInstance): void {
  app.get("/portal/settings/social", async (_req, reply) => {
    return reply.type("text/html").send(settingsPage("social", "The brand account's posts.", socialPageContent(), socialPageScript()));
  });
}

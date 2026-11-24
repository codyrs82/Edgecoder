// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { CODE_IMAGES_MAX, CODE_IMAGES_TOTAL_MAX_BYTES, CODE_IMAGE_MAX_BYTES, CODE_IMAGE_TYPES } from "../../common/code-relay.js";

/**
 * Images in a web composer (the Code session and the Chat): paste (Cmd/Ctrl+V of an image), drag
 * and drop, and an attach button, with thumbnails and a remove (×) before sending.
 *
 * PNG, JPEG and WebP only, at most IMAGE_ATTACH_LIMITS.count per message and maxBytes each (a bigger
 * image is scaled down in a canvas first, then refused if it still doesn't fit). Images are read
 * into data: URLs (the portal's img-src allows data:, not blob:) and only a data URL of one of those
 * types, checked by pattern, is ever put in an <img>, through the src property. File names reach the
 * page only through escapeHtml. Plain browser JS (no inline handlers): the page includes
 * IMAGE_ATTACH_JS in its nonce'd script and IMAGE_ATTACH_CSS in its nonce'd style.
 */
export const IMAGE_ATTACH_LIMITS = {
  types: [...CODE_IMAGE_TYPES],
  count: CODE_IMAGES_MAX,
  maxBytes: CODE_IMAGE_MAX_BYTES,
  totalBytes: CODE_IMAGES_TOTAL_MAX_BYTES,
};

export const IMAGE_ATTACH_CSS = `
      .img-tray { display:flex; flex-wrap:wrap; gap:8px; }
      .img-tray:empty { display:none; }
      .img-thumb { position:relative; width:64px; height:64px; border-radius:var(--radius-sm); border:1px solid var(--card-border); background:var(--bg-elevated); overflow:hidden; flex:none; }
      .img-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
      .img-thumb .img-x { position:absolute; top:2px; right:2px; width:20px; height:20px; min-height:0; padding:0; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text); border:1px solid var(--card-border); }
      .img-note { font-size:11.5px; color:var(--muted); }
      .img-note:empty { display:none; }
      .img-attach { width:32px; height:32px; min-height:0; padding:0; display:inline-flex; align-items:center; justify-content:center; flex:none; background:transparent; border-color:transparent; color:var(--text-secondary); }
      .img-attach:hover { background:var(--bg-elevated); color:var(--text); }
      .img-attach[hidden] { display:none !important; }
      .img-drop { outline:2px dashed var(--brand); outline-offset:2px; }
      .msg-imgs { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
      .msg-imgs img { max-width:min(240px, 100%); max-height:180px; border-radius:var(--radius-sm); border:1px solid var(--card-border); display:block; }
      .msg-imgs-note { font-size:11.5px; color:var(--muted); margin-top:4px; }
`;

export const IMAGE_ATTACH_JS = String.raw`
    var IMAGE_ATTACH = ${JSON.stringify(IMAGE_ATTACH_LIMITS)};
    var IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
    function imgSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
    function imgReadDataUrl(blob) {
      return new Promise(function(res, rej) { var r = new FileReader(); r.onload = function() { res(String(r.result || "")); }; r.onerror = function() { rej(r.error); }; r.readAsDataURL(blob); });
    }
    /* A too-big image, scaled to at most 2560 px on its long side and re-encoded (WebP, else JPEG); null if that fails. */
    async function imgShrink(file) {
      try {
        if (typeof createImageBitmap !== "function") return null;
        var bmp = await createImageBitmap(file), scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        var enc = function(type) { return new Promise(function(res) { c.toBlob(function(b) { res(b); }, type, 0.88); }); };
        var out = await enc("image/webp");
        if (!out || out.type !== "image/webp") out = await enc("image/jpeg");
        return out && out.size <= IMAGE_ATTACH.maxBytes ? out : null;
      } catch (_e) { return null; }
    }
    /*
     * One composer's images. opts: { input (textarea), drop (element for drag and drop), tray (thumbnails),
     * button (attach), file (input type=file), note (element for the composer's note), onChange }.
     */
    function imageAttach(opts) {
      var items = [], seq = 0, enabled = true, why = "";
      function bytes() { return items.reduce(function(n, i) { return n + i.size; }, 0); }
      function say(msg) { if (typeof showToast === "function") showToast(msg, true); }
      function render() {
        opts.tray.innerHTML = items.map(function(i) {
          return '<div class="img-thumb" data-img="' + i.id + '"><img alt="' + escapeHtml(i.name) + '"><button type="button" class="img-x" data-img-x="' + i.id + '" aria-label="Remove ' + escapeHtml(i.name) + '">×</button></div>';
        }).join("");
        items.forEach(function(i) { var el = opts.tray.querySelector('[data-img="' + i.id + '"] img'); if (el && IMAGE_DATA_URL.test(i.dataUrl)) el.src = i.dataUrl; });
        if (opts.onChange) opts.onChange(items.slice());
      }
      async function add(files) {
        if (!enabled) { if (why) say(why); return; }
        for (var k = 0; k < files.length; k++) {
          var f = files[k];
          if (!f || !/^image\//.test(f.type || "")) continue;
          if (IMAGE_ATTACH.types.indexOf(f.type) < 0) { say("Only PNG, JPEG and WebP images can be attached."); continue; }
          if (items.length >= IMAGE_ATTACH.count) { say("Up to " + IMAGE_ATTACH.count + " images per message."); break; }
          var blob = f;
          if (f.size > IMAGE_ATTACH.maxBytes) {
            blob = await imgShrink(f);
            if (!blob) { say((f.name || "That image") + " is over " + imgSize(IMAGE_ATTACH.maxBytes) + " and couldn't be made smaller."); continue; }
          }
          if (bytes() + blob.size > IMAGE_ATTACH.totalBytes) { say("Images can be up to " + imgSize(IMAGE_ATTACH.totalBytes) + " per message."); break; }
          var url = await imgReadDataUrl(blob).catch(function() { return ""; });
          if (!IMAGE_DATA_URL.test(url)) { say("That image couldn't be read."); continue; }
          var type = url.slice(5, url.indexOf(";"));
          var ext = type === "image/jpeg" ? "jpg" : type.slice(6);
          var base = String(f.name || "").replace(/[\u0000-\u001f\u007f/\\]/g, "").replace(/\.[A-Za-z0-9]+$/, "").slice(0, 80) || "image";
          items.push({ id: "i" + (++seq), name: base + "." + ext, mediaType: type, size: blob.size, dataUrl: url });
        }
        render();
      }
      opts.tray.addEventListener("click", function(e) {
        var x = e.target.closest && e.target.closest("[data-img-x]");
        if (!x) return;
        items = items.filter(function(i) { return i.id !== x.getAttribute("data-img-x"); });
        render();
        if (opts.input) opts.input.focus();
      });
      if (opts.input) opts.input.addEventListener("paste", function(e) {
        var list = e.clipboardData && e.clipboardData.items ? Array.prototype.slice.call(e.clipboardData.items) : [];
        var files = list.filter(function(it) { return it.kind === "file" && /^image\//.test(it.type); }).map(function(it) { return it.getAsFile(); }).filter(Boolean);
        if (!files.length) return;
        if (!enabled) { add(files); return; }
        // A screenshot has no text: keep the paste to the image. Text and an image together: the text pastes too.
        if (!list.some(function(it) { return it.kind === "string" && it.type === "text/plain"; })) e.preventDefault();
        add(files);
      });
      if (opts.drop) {
        var hasFiles = function(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0; };
        opts.drop.addEventListener("dragover", function(e) { if (!hasFiles(e)) return; e.preventDefault(); if (enabled) opts.drop.classList.add("img-drop"); });
        opts.drop.addEventListener("dragleave", function() { opts.drop.classList.remove("img-drop"); });
        opts.drop.addEventListener("drop", function(e) {
          opts.drop.classList.remove("img-drop");
          if (!hasFiles(e)) return;
          // Never let the browser open a dropped file in place of the page.
          e.preventDefault();
          add(Array.prototype.slice.call(e.dataTransfer.files || []));
        });
      }
      if (opts.button && opts.file) {
        opts.button.addEventListener("click", function() { if (enabled) opts.file.click(); });
        opts.file.addEventListener("change", function() { add(Array.prototype.slice.call(opts.file.files || [])); opts.file.value = ""; });
      }
      return {
        items: function() { return items.slice(); },
        count: function() { return items.length; },
        clear: function() { items = []; render(); },
        /** For sending: [{ name, mediaType, data }] (base64 without the data: prefix). */
        payload: function() { return items.map(function(i) { return { name: i.name, mediaType: i.mediaType, data: i.dataUrl.slice(i.dataUrl.indexOf(",") + 1) }; }); },
        /** Off: the button is disabled and a pasted or dropped image is refused with the reason. */
        setEnabled: function(on, reason) {
          enabled = !!on;
          why = enabled ? "" : reason || "";
          if (opts.button) { opts.button.disabled = !enabled; opts.button.title = enabled ? "Attach images (or paste or drop them)" : why; }
        },
      };
    }
    /* Sent images under a message: <img> elements with checked data URLs (set through src), and an optional note. */
    function imageAttachShow(container, images, note) {
      if (!container || !images || !images.length) return;
      var box = document.createElement("div");
      box.className = "msg-imgs";
      images.forEach(function(i) {
        if (!IMAGE_DATA_URL.test(i.dataUrl)) return;
        var img = document.createElement("img");
        img.alt = i.name;
        img.src = i.dataUrl;
        box.appendChild(img);
      });
      container.appendChild(box);
      if (note) { var n = document.createElement("div"); n.className = "msg-imgs-note"; n.textContent = note; container.appendChild(n); }
    }
`;

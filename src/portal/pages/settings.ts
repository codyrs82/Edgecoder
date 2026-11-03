// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { registerSettingsComputePage } from "./settings-compute.js";
import { registerSettingsOpsPages } from "./settings-ops.js";
import { LEGACY_SETTINGS_REDIRECTS, SETTINGS_HELPERS_SCRIPT, redirectKeepingQuery, settingRow, settingsPage } from "./settings-shell.js";

/**
 * Settings (/portal/settings): General, Profile, Usage and Connect your tools, one section at a
 * time by #hash, all searchable from the sub-navigation's search box. Plan & usage and Install
 * agent (account.ts), Compute (settings-compute.ts), Nodes and Admin (settings-ops.ts) are their
 * own pages in the same frame (settings-shell.ts).
 */
const section = (key: string, title: string, lead: string, body: string) =>
  `<section class="set-section" id="sec-${key}" data-section="${key}"><h2 class="set-title">${title}</h2><p class="set-lead">${lead}</p>${body}</section>`;
const card = (rows: string) => `<div class="set-card">${rows}</div>`;
const group = (label: string) => `<div class="set-group">${label}</div>`;

const GENERAL = section(
  "general",
  "General",
  "How the portal looks on this account.",
  card(
    settingRow(
      "Theme",
      "Applies to every page of the portal, on every device you sign in from.",
      `<select id="themeSelect" aria-label="Theme"><option value="warm">Graphite (default)</option><option value="midnight">Midnight</option><option value="emerald">Evergreen</option></select>`,
      { keywords: "theme appearance colour color dark" }
    )
  )
);

const PROFILE = section(
  "profile",
  "Profile",
  "How you appear in the portal, and how you sign in.",
  card(
    settingRow("Avatar", "Your initial, from your display name or email.", `<span class="set-avatar" id="profileAvatarLarge" aria-hidden="true"></span>`, { keywords: "avatar picture photo initial" }) +
      settingRow(
        "Display name",
        "Shown at the bottom of the sidebar. Leave empty to use your email name.",
        `<input id="displayNameInput" maxlength="80" placeholder="Your name" aria-label="Display name" /><button class="primary" id="saveProfileBtn">Save</button>`,
        { keywords: "name display profile" }
      ) +
      settingRow("Email", "The address you sign in with.", `<span class="set-value" id="profileEmail"></span><span id="profileEmailBadge"></span>`, { keywords: "email address verified" }) +
      settingRow("User ID", "Your account is <code id=\"profileAccountId\"></code> on the network.", `<span class="set-value" id="profileUserId"></span>`, { keywords: "user id account" })
  ) +
    group("Sign-in") +
    card(
      settingRow("Passkey", "Enroll a passkey for passwordless sign-in on future visits.", `<button class="primary" id="passkeyEnrollBtn">Enroll passkey</button>`, { keywords: "passkey security login password webauthn" }) +
        settingRow(
          "Connected sign-in",
          "Connect a Google, Microsoft or GitHub account so you can sign in to this account with it.",
          ["google", "microsoft", "github"]
            .map((p) => `<button type="button" data-oauth-connect="${p}">Connect ${p === "github" ? "GitHub" : p[0].toUpperCase() + p.slice(1)}</button>`)
            .join(" "),
          { keywords: "google microsoft github sso oauth connect link sign-in" }
        )
    )
);

const USAGE = section(
  "usage",
  "Usage",
  "You pay for compute in cSats (1 cSat = 1 sat). Chats, tools and reservations spend them; your machines earn sats.",
  card(
    settingRow("cSats balance", "What you can spend on network compute.", `<span class="set-big" id="usageBalance">—</span><a class="btn primary" href="/portal/settings/plan">Buy cSats</a>`, { keywords: "balance credits csats plan buy wallet" }) +
      settingRow("Earned", "Sats your machines have earned running jobs for others.", `<span class="set-value" id="usageEarned">—</span>`, { keywords: "earned earnings sats payout" }) +
      settingRow("Prices", "Per second of compute on the base tier of each class.", `<span class="set-value" id="usagePrices">—</span>`, { keywords: "price rate cost per second class" })
  ) +
    group("Recent activity") +
    card(
      `<div class="set-row wide" data-keywords="recent activity history usage spend transactions"><table><thead><tr><th>When</th><th>What</th><th class="num">cSats</th></tr></thead><tbody id="usageRecent"><tr><td colspan="3" class="muted">Loading…</td></tr></tbody></table></div>`
    )
);

const TOOLS = section(
  "tools",
  "Connect your tools",
  "Use EdgeCoder models from Cursor, Claude Code or any OpenAI client, from anywhere. Requests run on the network and are paid from your cSats.",
  group("API keys") +
    card(
      settingRow("Create a key", "Name it after the tool or machine that will use it.", `<input id="newKeyName" maxlength="60" placeholder="e.g. Cursor on laptop" aria-label="Key name" /><button class="primary" id="createKeyBtn">Create key</button>`, { keywords: "api key create token" }) +
        `<div id="newKeyBox" class="hidden set-row wide"><strong>Copy this key now. It won't be shown again.</strong><div class="row"><code id="newKeyValue" style="word-break:break-all;"></code><button id="copyKeyBtn">Copy</button></div></div>` +
        `<div class="set-row wide" data-keywords="api keys revoke list"><table class="table"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody id="keysBody"><tr><td colspan="5" class="muted">Loading...</td></tr></tbody></table></div>`
    ) +
    group("Instructions") +
    card(
      settingRow(
        "Base URL and models",
        `Base URL <code><span class="portal-origin"></span>/v1</code>. Models: <code>network/&lt;model&gt;</code> (any machine), <code>network/&lt;model&gt;@gpu</code> (one class: cpu, apple, gpu, gpu.dc), <code>mine/&lt;model&gt;</code> (your own machines, free), <code>reserved/&lt;reservation id&gt;/&lt;model&gt;</code> (a machine you reserved). <a href="/portal/settings/compute">Prices by class are under Compute.</a>`,
        "",
        { keywords: "base url models openai endpoint" }
      ) +
        settingRow(
          "Cursor",
          `Settings → Models → API keys: turn on "OpenAI API key", paste the key, turn on "Override OpenAI Base URL" with <code><span class="portal-origin"></span>/v1</code>, then add a custom model such as <code>network/qwen2.5-coder:32b@gpu</code>.`,
          "",
          { keywords: "cursor ide" }
        ) +
        `<div class="set-row wide" data-keywords="claude code anthropic"><div class="set-text"><div class="set-label">Claude Code</div><div class="set-desc">Point it at the portal with your key:</div><pre>export ANTHROPIC_BASE_URL=<span class="portal-origin"></span>
export ANTHROPIC_AUTH_TOKEN=&lt;your key&gt;
export ANTHROPIC_MODEL=network/qwen3.5:9b
export ANTHROPIC_SMALL_FAST_MODEL=network/qwen3.5:9b
claude</pre></div></div>` +
        settingRow("Any OpenAI client", `Base URL <code><span class="portal-origin"></span>/v1</code>, the key as the API key.`, "", { keywords: "openai client sdk" })
    )
);

const SCRIPT = SETTINGS_HELPERS_SCRIPT + `
    function b64urlToArrayBuffer(base64url) {
      const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    function arrayBufferToB64url(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
    }

    /* ── Sections by #hash, and search ── */
    const SECTIONS = ["general", "profile", "usage", "tools"];
    // Sections that moved to their own page under /portal/settings/ (old #hash links still land there).
    const MOVED = { plan: "/portal/settings/plan", compute: "/portal/settings/compute", install: "/portal/settings/install", nodes: "/portal/settings/nodes", admin: "/portal/settings/admin" };
    let currentSection = "general";
    function sectionFromHash() { const h = location.hash.replace(/^#/, ""); return SECTIONS.includes(h) ? h : "general"; }
    (function() { const h = location.hash.replace(/^#/, ""); if (MOVED[h]) location.replace(MOVED[h]); })();
    function showSection(key) {
      currentSection = key;
      for (const s of document.querySelectorAll(".set-section")) s.classList.toggle("hidden", s.dataset.section !== key);
      for (const a of document.querySelectorAll(".settings-link")) {
        a.classList.remove("dim");
        if (a.dataset.section === key) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      }
      document.getElementById("settingsNoMatch").classList.add("hidden");
      for (const r of document.querySelectorAll(".set-row, .set-card, .set-group")) r.classList.remove("search-hidden");
    }
    window.onSettingsSearch = function(raw) {
      const q = String(raw || "").trim().toLowerCase();
      if (!q) { showSection(currentSection); return; }
      let any = false;
      for (const s of document.querySelectorAll(".set-section")) {
        let hits = 0;
        for (const r of s.querySelectorAll(".set-row, [data-keywords]:not(.set-row)")) {
          const text = ((r.querySelector(".set-text") || r).textContent + " " + (r.dataset.keywords || "")).toLowerCase();
          const hit = text.includes(q) || s.querySelector(".set-title").textContent.toLowerCase().includes(q);
          r.classList.toggle("search-hidden", !hit);
          if (hit) hits++;
        }
        for (const c of s.querySelectorAll(".set-card")) c.classList.toggle("search-hidden", !c.querySelector(".set-row:not(.search-hidden):not(.hidden), [data-keywords]:not(.search-hidden)"));
        for (const g of s.querySelectorAll(".set-group")) g.classList.add("search-hidden");
        s.classList.toggle("hidden", hits === 0);
        const link = document.querySelector('.settings-link[data-section="' + s.dataset.section + '"]');
        if (link) { link.classList.toggle("dim", hits === 0); link.removeAttribute("aria-current"); }
        if (hits) any = true;
      }
      document.getElementById("settingsNoMatch").classList.toggle("hidden", any);
    };
    window.addEventListener("hashchange", () => {
      const moved = MOVED[location.hash.replace(/^#/, "")];
      if (moved) { location.href = moved; return; }
      const input = document.getElementById("settingsSearch");
      if (input.value) input.value = "";
      showSection(sectionFromHash());
      window.scrollTo(0, 0);
    });

    /* ── Profile and general ── */
    let me = null;
    async function bootstrapSettings() {
      me = await requireAuth();
      revealSettingsAdminTab(me);
      const user = me.user || {};
      document.getElementById("themeSelect").value = user.uiTheme || "warm";
      document.getElementById("displayNameInput").value = user.displayName || "";
      document.getElementById("profileEmail").textContent = user.email || "";
      document.getElementById("profileEmailBadge").innerHTML = user.emailVerified ? statusBadge("Verified", "ok") : statusBadge("Unverified", "warn");
      document.getElementById("profileUserId").textContent = user.userId || "";
      document.getElementById("profileAccountId").textContent = "acct-" + (user.userId || "");
      renderAvatar();
      for (const e of document.querySelectorAll(".portal-origin")) e.textContent = location.origin;
      loadKeys();
      loadUsage();
    }
    function renderAvatar() {
      const user = (me && me.user) || {};
      const name = document.getElementById("displayNameInput").value.trim() || String(user.email || "").split("@")[0];
      document.getElementById("profileAvatarLarge").textContent = (name || "?").charAt(0);
    }
    document.getElementById("displayNameInput").addEventListener("input", renderAvatar);
    document.getElementById("saveProfileBtn").addEventListener("click", async () => {
      try {
        const displayName = document.getElementById("displayNameInput").value.trim();
        await api("/me/profile", { method: "POST", body: JSON.stringify({ displayName }) });
        showToast("Profile saved.");
        loadTopTicker();
      } catch (err) {
        showToast("Could not save: " + String(err.message || err), true);
      }
    });
    document.getElementById("themeSelect").addEventListener("change", async (e) => {
      const theme = e.target.value;
      applyTheme(theme);
      try { await api("/me/theme", { method: "POST", body: JSON.stringify({ theme }) }); showToast("Theme updated."); }
      catch (err) { showToast("Could not save theme: " + String(err.message || err), true); }
    });

    /* ── Plan & usage ── */
    function reasonLabel(reason) {
      const r = String(reason || "").split(":")[0].replace(/_/g, " ");
      return r ? r.charAt(0).toUpperCase() + r.slice(1) : "Activity";
    }
    async function loadUsage() {
      const body = document.getElementById("usageRecent");
      const r = await call("/portal/api/compute/summary");
      if (!r.ok || !r.json.connected) {
        document.getElementById("usageBalance").textContent = "Unavailable";
        body.innerHTML = '<tr><td colspan="3" class="muted">The network is unreachable right now.</td></tr>';
        return;
      }
      const s = r.json;
      document.getElementById("usageBalance").textContent = fmtNum(s.cSats, Math.abs(s.cSats) >= 100 ? 0 : 2) + " cSats";
      document.getElementById("usageEarned").textContent = fmtNum(s.earnedSats || 0, 0) + " sats";
      const prices = Object.entries(s.classes || {}).map(([c, v]) => classLabel(c) + " " + fmtRate(v.cSatsPerSecondBaseTier) + "/s");
      document.getElementById("usagePrices").textContent = prices.length ? prices.join(" · ") : "—";
      body.textContent = "";
      if (!(s.recent || []).length) { body.innerHTML = '<tr><td colspan="3" class="muted">No activity yet.</td></tr>'; return; }
      for (const t of s.recent) {
        const tr = el("tr");
        tr.appendChild(el("td", {}, fmtDate(t.atMs)));
        tr.appendChild(el("td", {}, reasonLabel(t.reason)));
        const spend = t.type === "spend";
        tr.appendChild(el("td", { class: "num " + (spend ? "neg" : "pos") }, (spend ? "−" : "+") + fmtNum(Math.abs(t.cSats), 3)));
        body.appendChild(tr);
      }
    }

    /* ── Connect your tools: API keys ── */
    async function loadKeys() {
      const body = document.getElementById("keysBody");
      try {
        const res = await api("/portal/api/keys");
        body.textContent = "";
        if (!res.keys.length) { body.innerHTML = '<tr><td colspan="5" class="muted">No keys yet.</td></tr>'; return; }
        for (const k of res.keys) {
          const tr = document.createElement("tr");
          for (const v of [k.name, k.prefix + "…", fmtDate(k.createdAtMs), fmtDate(k.lastUsedMs)]) {
            const td = document.createElement("td"); td.textContent = v; tr.appendChild(td);
          }
          const td = document.createElement("td");
          const btn = document.createElement("button"); btn.textContent = "Revoke"; btn.className = "sm";
          btn.addEventListener("click", async () => {
            if (!confirm("Revoke " + k.name + "? Tools using it stop working.")) return;
            try { await api("/portal/api/keys/" + encodeURIComponent(k.keyId), { method: "DELETE" }); showToast("Key revoked."); loadKeys(); }
            catch (err) { showToast("Could not revoke: " + String(err.message || err), true); }
          });
          td.appendChild(btn); tr.appendChild(td); body.appendChild(tr);
        }
      } catch (err) {
        body.innerHTML = '<tr><td colspan="5" class="muted">Could not load keys.</td></tr>';
      }
    }
    document.getElementById("createKeyBtn").addEventListener("click", async () => {
      const name = document.getElementById("newKeyName").value.trim();
      if (!name) { showToast("Name the key first.", true); return; }
      try {
        const res = await api("/portal/api/keys", { method: "POST", body: JSON.stringify({ name }) });
        document.getElementById("newKeyValue").textContent = res.key;
        document.getElementById("newKeyBox").classList.remove("hidden");
        document.getElementById("newKeyName").value = "";
        loadKeys();
      } catch (err) {
        showToast("Could not create key: " + String(err.message || err), true);
      }
    });
    document.getElementById("copyKeyBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(document.getElementById("newKeyValue").textContent); showToast("Copied."); } catch { showToast("Copy failed; select the key and copy it.", true); }
    });

    /* ── Passkey ── */
    document.getElementById("passkeyEnrollBtn").addEventListener("click", async () => {
      if (!window.PublicKeyCredential) {
        showToast("Passkeys are not supported in this browser.", true);
        return;
      }
      try {
        await requireAuth();
        const payload = await api("/auth/passkey/register/options", { method: "POST", body: JSON.stringify({}) });
        const challengeId = payload.challengeId;
        const options = payload.options;
        options.challenge = b64urlToArrayBuffer(options.challenge);
        options.user.id = b64urlToArrayBuffer(options.user.id);
        options.excludeCredentials = (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
        const credential = await navigator.credentials.create({ publicKey: options });
        const response = credential.response;
        await api("/auth/passkey/register/verify", {
          method: "POST",
          body: JSON.stringify({
            challengeId,
            response: {
              id: credential.id,
              rawId: arrayBufferToB64url(credential.rawId),
              type: credential.type,
              response: {
                clientDataJSON: arrayBufferToB64url(response.clientDataJSON),
                attestationObject: arrayBufferToB64url(response.attestationObject),
                transports: response.getTransports ? response.getTransports() : []
              }
            }
          })
        });
        showToast("Passkey enrolled successfully.");
      } catch (err) {
        showToast("Passkey enrollment failed: " + String(err.message || err), true);
      }
    });

    /* ── Connected sign-in (OAuth connect while signed in) ── */
    document.querySelectorAll("[data-oauth-connect]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const res = await api("/auth/oauth/" + btn.getAttribute("data-oauth-connect") + "/connect", { method: "POST", body: JSON.stringify({}) });
          window.location.href = res.authorizeUrl;
        } catch (err) {
          showToast("Could not start: " + String(err.message || err), true);
        }
      });
    });
    if (new URLSearchParams(location.search).get("connected")) showToast("Sign-in method connected.");

    showSection(sectionFromHash());
    (function() {
      const q = new URLSearchParams(location.search).get("q");
      if (q) { const input = document.getElementById("settingsSearch"); input.value = q; window.onSettingsSearch(q); }
    })();
    bootstrapSettings().catch((err) => showToast("Could not load settings: " + String(err.message || err), true));
`;

export function registerSettingsPages(app: FastifyInstance): void {
  app.get("/portal/settings", async (_req, reply) => {
    const content = `<style>.search-hidden { display: none !important; }</style>${GENERAL}${PROFILE}${USAGE}${TOOLS}<div id="settingsNoMatch" class="hidden">No settings match your search.</div>`;
    return reply.type("text/html").send(settingsPage("general", "Your account, plan, compute and connected tools.", content, SCRIPT));
  });
  registerSettingsComputePage(app);
  registerSettingsOpsPages(app);
  // The old top-level pages (Wallet, Market, Install agent, Nodes, Coordinator ops) live in Settings now.
  for (const [from, to] of Object.entries(LEGACY_SETTINGS_REDIRECTS)) app.get(from, redirectKeepingQuery(to));
}

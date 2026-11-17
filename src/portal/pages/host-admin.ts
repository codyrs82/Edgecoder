// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * One-click host approval for system admins, wherever they see an account or a machine
 * (Settings > Admin user and node rows, Settings > Nodes, Settings > Network agents).
 *
 * Client script for the page shell (needs api, showToast, statusBadge and escapeHtml from
 * layout.ts). It reads the host list from GET /portal/api/admin/host-requests (admin only: for
 * anyone else it stays disabled and renders nothing) and approves or revokes with
 * POST /portal/api/admin/hosts and /portal/api/admin/hosts/revoke, after a confirm, with a toast.
 *
 *   loadHostDirectory()            fetch the list (or setHostDirectory(data) from a response already loaded)
 *   hostBadge(email)               "Host" / "Own work only"
 *   hostButton(email, label)       "Approve host" (label) or "Revoke host"; nothing for allowlisted emails
 *   onHostDirectoryChange(fn)      re-render after an approve or revoke
 */
export const HOST_ADMIN_JS = `
    const hostAdmin = { enabled: false, required: true, hosts: new Set(), allowlist: new Set(), listeners: [] };
    function hostKey(email) { return String(email || "").trim().toLowerCase(); }
    function setHostDirectory(data) {
      hostAdmin.enabled = true;
      hostAdmin.required = !(data && data.required === false);
      hostAdmin.allowlist = new Set(((data && data.allowlist) || []).map(hostKey));
      hostAdmin.hosts = new Set(((data && data.hosts) || []).map(function(h) { return hostKey(h.email); }));
    }
    async function loadHostDirectory() {
      try { setHostDirectory(await api("/portal/api/admin/host-requests", { method: "GET", headers: {} })); }
      catch (err) { hostAdmin.enabled = false; }
      return hostAdmin.enabled;
    }
    function isHostEmail(email) {
      const e = hostKey(email);
      return !hostAdmin.required || hostAdmin.allowlist.has(e) || hostAdmin.hosts.has(e);
    }
    function hostBadge(email) {
      if (!hostAdmin.enabled || !hostKey(email)) return "";
      return isHostEmail(email) ? statusBadge("Host", "ok") : statusBadge("Own work only", "warn");
    }
    function hostButton(email, approveLabel) {
      const e = hostKey(email);
      if (!hostAdmin.enabled || !e || !hostAdmin.required || hostAdmin.allowlist.has(e)) return "";
      const attr = encodeURIComponent(e).replace(/'/g, "%27");
      return hostAdmin.hosts.has(e)
        ? "<button class='hostToggleBtn' data-host-email='" + attr + "' data-host-action='revoke'>Revoke host</button>"
        : "<button class='hostToggleBtn primary' data-host-email='" + attr + "' data-host-action='approve'>" + escapeHtml(approveLabel || "Approve host") + "</button>";
    }
    function onHostDirectoryChange(fn) { hostAdmin.listeners.push(fn); }
    async function toggleHost(email, action) {
      const approve = action === "approve";
      if (!confirm(approve ? "Approve " + email + " as a host? Their machines will take other people's work." : "Revoke host approval for " + email + "? Their machines will run only their own work.")) return false;
      try {
        await api(approve ? "/portal/api/admin/hosts" : "/portal/api/admin/hosts/revoke", { method: "POST", body: JSON.stringify(approve ? { email: email, note: "approved from the admin list" } : { email: email }) });
        showToast((approve ? "Approved host: " : "Revoked host: ") + email);
      } catch (err) {
        showToast((approve ? "Approve host failed: " : "Revoke host failed: ") + String(err.message || err), true);
        return false;
      }
      await loadHostDirectory();
      hostAdmin.listeners.forEach(function(fn) { try { fn(); } catch (e) {} });
      return true;
    }
    document.addEventListener("click", function(event) {
      const btn = event.target && event.target.closest ? event.target.closest(".hostToggleBtn") : null;
      if (!btn) return;
      event.preventDefault();
      toggleHost(decodeURIComponent(btn.getAttribute("data-host-email") || ""), btn.getAttribute("data-host-action"));
    });
`;

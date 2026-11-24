// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The "Traffic from X" panel on Settings > Social posts (system admins): the last 14 days of campaign
 * visits and sign-ups (GET /portal/api/admin/growth, src/portal/growth.ts), each campaign linked to
 * the post that carries its /x/<campaign> link when one is known. The script runs inside the social
 * page's script and uses its helpers ($, el, call).
 */
export function trafficPanelHtml(): string {
  return `
      <h3 class="set-group" id="traffic">Traffic from X</h3>
      <p class="muted">Visits from tagged links (the <code>/x/&lt;campaign&gt;</code> short links and ads with <code>utm_*</code> tags), counted once per visitor per campaign per day, and sign-ups credited to the campaign that first brought the visitor (30 days). America/Chicago days. Robots and accounts on <code>SIGNUP_ALERT_IGNORE</code> are left out.</p>
      <div class="muted" id="trafficSummary" role="status"></div>
      <div class="set-card soc-recent"><div class="soc-table">
        <table><thead><tr><th>Day</th><th>Campaign</th><th>Medium</th><th>Content</th><th>Visits</th><th>Sign-ups</th></tr></thead><tbody id="trafficRows"></tbody></table>
      </div></div>`;
}

export const TRAFFIC_PANEL_SCRIPT = `
    async function loadTraffic() {
      const body = $("trafficRows");
      const r = await call("/portal/api/admin/growth", { method: "GET" });
      body.textContent = "";
      if (!r.ok) { $("trafficSummary").textContent = "Could not load traffic: " + (r.json.error || r.status); return; }
      const j = r.json;
      const t = j.totals || {};
      $("trafficSummary").textContent = (t.visits || 0) + " campaign visits and " + (t.campaignSignups || 0) + " campaign sign-ups in the last " + (j.days || []).length + " days; " + (t.signups || 0) + " sign-ups in all." + (j.alerts && j.alerts.email ? "" : " Sign-up alert email is off (ALERT_EMAILS or Resend not set).");
      const rows = j.rows || [];
      if (!rows.length) {
        const tr = el("tr"); const td = el("td", { colspan: "6", class: "muted" }, "No campaign visits yet."); tr.appendChild(td); body.appendChild(tr);
      }
      for (const row of rows) {
        const tr = el("tr");
        tr.appendChild(el("td", {}, row.day));
        const c = el("td");
        const name = row.campaign || "(no campaign)";
        if (row.post && row.post.xUrl) { const a = el("a", { href: row.post.xUrl, target: "_blank", rel: "noopener", title: row.post.snippet || "" }, name); c.appendChild(a); }
        else { c.textContent = name; if (row.post) c.title = row.post.snippet + " (" + row.post.status + ")"; }
        tr.appendChild(c);
        tr.appendChild(el("td", {}, (row.source || "?") + " / " + (row.medium || "?")));
        tr.appendChild(el("td", {}, row.content || ""));
        tr.appendChild(el("td", {}, String(row.visits)));
        tr.appendChild(el("td", {}, String(row.signups)));
        body.appendChild(tr);
      }
      const total = el("tr");
      total.appendChild(el("td", {}, "Total"));
      for (let i = 0; i < 3; i++) total.appendChild(el("td"));
      total.appendChild(el("td", {}, String(t.visits || 0)));
      total.appendChild(el("td", {}, String(t.campaignSignups || 0)));
      body.appendChild(total);
    }
`;

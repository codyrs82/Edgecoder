import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { networkPageScript } from "../../src/portal/pages/settings-network.js";
import { fakeDocument } from "./fixtures/fake-dom.js";

/** Settings > Network's Alerts card: shell, and what the script renders from /portal/api/admin/alerts. */
describe("Settings > Network Alerts card", () => {
  it("is in the page with its test button, tables and API paths", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const html = (await app.inject({ url: "/portal/settings/network" })).body;
    for (const id of ["alerts", "alertTestBtn", "alertSources", "alertStatus", "alertsBody", "alertHistoryBody"]) expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain("Send test alert");
    for (const path of ["/portal/api/admin/alerts", "/portal/api/admin/alerts/ack", "/portal/api/admin/alerts/test"]) expect(html).toContain(path);
  });

  it("renders active alerts with Acknowledge, acknowledged ones without, channel status and history", () => {
    const { document, byId } = fakeDocument(() => undefined);
    const window: Record<string, unknown> = { addEventListener: () => undefined };
    new Function("document", "window", "requireAuth", "revealSettingsAdminTab", networkPageScript())(document, window, () => new Promise(() => undefined), () => undefined);
    const render = window.__renderAlerts as (json: unknown) => void;
    const now = Date.now();
    render({
      coordinatorAdminToken: true,
      sources: [
        { origin: "portal", ok: true, reporter: "portal", channels: ["email", "webhook:ntfy"], enabled: true },
        { origin: "https://seed-eu", ok: false, reporter: "seed-eu", channels: [], enabled: false, error: "coordinator_unreachable" },
        { origin: "https://seed-ord", ok: true, reporter: "coordinator seed-ord", channels: [], enabled: true }
      ],
      active: [
        { origin: "portal", reporter: "portal", source: "portal", key: "coordinator_down:seed-eu", severity: "critical", title: "Coordinator seed-eu is down or unhealthy", summary: "3 failed checks", firstSeenMs: now - 120_000, acknowledgedAtMs: null },
        { origin: "https://seed-ord", reporter: "coordinator seed-ord", source: "coord-ord", key: "ln_low_outbound", severity: "warning", title: "Lightning outbound liquidity low", summary: "50,000 sats", firstSeenMs: now - 3_600_000, acknowledgedAtMs: now, acknowledgedBy: "root@example.com" }
      ],
      history: [{ origin: "portal", reporter: "portal", key: "coordinator_down:seed-eu", kind: "notified", title: "Coordinator seed-eu is down or unhealthy", summary: "", atMs: now - 60_000 }]
    });
    expect(byId.get("alerts")!.classList.contains("hidden")).toBe(false);
    const rows = byId.get("alertsBody")!.children;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Coordinator seed-eu is down or unhealthy");
    expect(rows[0]!.textContent).toContain("Acknowledge");
    expect(rows[1]!.textContent).toContain("Acknowledged by root@example.com");
    expect(byId.get("alertSources")!.textContent).toBe("Notification channels. portal: email, webhook:ntfy · seed-eu: not answering (coordinator_unreachable) · coordinator seed-ord: no channel set");
    expect(byId.get("alertHistoryBody")!.children[0]!.textContent).toContain("Notified");
    render({ sources: [], active: [], history: [] });
    expect(byId.get("alertsBody")!.textContent).toBe("No active alerts.");
  });
});

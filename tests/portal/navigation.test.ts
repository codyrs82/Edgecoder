import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";

// The portal is laid out like the desktop app: the sidebar holds New chat, Search, a short primary
// list and recent chats; everything about the account and the economy lives in Settings, reached
// from the avatar menu or the gear.
async function page(url: string): Promise<string> {
  const app = Fastify();
  registerPortalPages(app);
  const res = await app.inject({ url, headers: { "user-agent": "Mozilla/5.0 (Macintosh)" } });
  await app.close();
  expect(res.statusCode, url).toBe(200);
  return res.body;
}

function sidebar(html: string): string {
  return html.slice(html.indexOf('<nav class="sidebar-nav"'), html.indexOf("</nav>", html.indexOf('<nav class="sidebar-nav"')));
}

function accountMenu(html: string): string {
  const start = html.indexOf('id="accountMenu"');
  return html.slice(start, html.indexOf('id="profileRow"', start));
}

describe("portal navigation like the desktop app", () => {
  it("keeps the sidebar to New chat, Search, Chat, Overview, Reviews and recent chats", async () => {
    for (const url of ["/portal/dashboard", "/portal/settings", "/portal/reviews"]) {
      const nav = sidebar(await page(url));
      expect(nav, url).toContain('id="newChatBtn" href="/portal/chat?new=1"');
      expect(nav, url).toContain('id="sidebarSearchBtn"');
      expect(nav, url).toContain('id="convSearch"');
      expect(nav, url).toContain('id="convList"');
      for (const href of ["/portal/chat", "/portal/dashboard", "/portal/reviews"]) expect(nav, `${url} ${href}`).toContain(`href="${href}"`);
      expect(nav, url).toContain("<span class=\"nav-label\">Overview</span>");
      // Moved out of the sidebar into Settings.
      for (const gone of ["/portal/market", "/portal/wallet", "/portal/download", "/portal/settings", "Documentation", "nav-group-label\">Economy"]) {
        expect(nav, `${url} ${gone}`).not.toContain(gone);
      }
    }
  });

  it("on the chat page New chat is a button the chat drives, and the old inner conversation sidebar is gone", async () => {
    const html = await page("/portal/chat");
    expect(sidebar(html)).toContain('<button type="button" class="nav-link nav-action" id="newChatBtn">');
    expect(html).not.toContain('id="convSidebar"');
    expect(html.match(/id="convList"/g)).toHaveLength(1);
    expect(html.match(/id="newChatBtn"/g)).toHaveLength(1);
    expect(html).toContain("sidebarConversationsHtml(filtered, activeConvId");
    // Links from other pages open a chat (?c=) or start one (?new=1).
    expect(html).toContain('params.get("c")');
  });

  it("puts name, cSats and a Settings gear in the avatar row, and account items in the popup", async () => {
    const html = await page("/portal/dashboard");
    expect(html).toContain('id="profileAvatar"');
    expect(html).toContain('id="profileName"');
    expect(html).toContain('id="topTickerCredits"');
    expect(html).toMatch(/<a class="profile-gear" id="profileGear" href="\/portal\/settings"/);
    const menu = accountMenu(html);
    expect(menu).toContain('id="accountMenuEmail"');
    const expected: Array<[string, string]> = [
      ["Profile", "/portal/settings#profile"],
      ["Plan &amp; usage", "/portal/settings/plan"],
      ["Usage", "/portal/settings#usage"],
      ["Compute", "/portal/settings/compute"],
      ["Connect your tools", "/portal/settings#tools"],
      ["Install agent", "/portal/settings/install"],
      ["Settings", "/portal/settings"],
      ["Admin", "/portal/settings/admin"]
    ];
    for (const [label, href] of expected) expect(menu, label).toMatch(new RegExp(`href="${href.replace(/[/#]/g, "\\$&")}"[^>]*>.*?<span>${label}</span>`));
    expect(menu).toMatch(/target="_blank" rel="noreferrer">.*?<span>Docs<\/span>/);
    expect(menu).toContain('id="logoutBtn"');
    // Labels appear in the desktop's order.
    const order = ["Profile", "Plan &amp; usage", "Usage", "Compute", "Connect your tools", "Install agent", "Settings", "Admin", "Docs", "Log out"].map((l) => menu.indexOf(`<span>${l}</span>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("hides admin-only items for everyone until /me says the user is a system admin", async () => {
    for (const url of ["/portal/dashboard", "/portal/settings", "/portal/settings/compute"]) {
      const html = await page(url);
      const adminLinks = html.match(/<a [^>]*href="\/portal\/settings\/admin"[^>]*>/g) ?? [];
      expect(adminLinks.length, url).toBeGreaterThan(0);
      for (const a of adminLinks) {
        expect(a, url).toContain("data-admin-only");
        expect(a, url).toMatch(/ hidden|class="[^"]*\bhidden\b/);
      }
      expect(html, url).toContain('querySelectorAll("[data-admin-only]")');
      expect(html, url).toContain("user.roles && user.roles.isSystemAdmin");
    }
  });

  it("lists every Settings section, with Admin hidden for non-admins", async () => {
    const html = await page("/portal/settings");
    const nav = html.slice(html.indexOf('<nav class="settings-links"'), html.indexOf("</nav>", html.indexOf('<nav class="settings-links"')));
    const sections: Array<[string, string]> = [
      ["general", "/portal/settings#general"],
      ["profile", "/portal/settings#profile"],
      ["plan", "/portal/settings/plan"],
      ["usage", "/portal/settings#usage"],
      ["compute", "/portal/settings/compute"],
      ["tools", "/portal/settings#tools"],
      ["nodes", "/portal/settings/nodes"],
      ["install", "/portal/settings/install"],
      ["admin", "/portal/settings/admin"]
    ];
    for (const [key, href] of sections) expect(nav, key).toMatch(new RegExp(`href="${href.replace(/[/#]/g, "\\$&")}"[^>]*data-section="${key}"`));
    expect(nav).toMatch(/class="settings-link hidden" href="\/portal\/settings\/admin"/);
  });

  it("redirects every old page to its Settings section, keeping the query string", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const expected: Record<string, string> = {
      "/portal/wallet": "/portal/settings/plan",
      "/portal/wallet?topup=1": "/portal/settings/plan?topup=1",
      "/portal/market": "/portal/settings/compute",
      "/portal/download": "/portal/settings/install",
      "/portal/download?token=t-1": "/portal/settings/install?token=t-1",
      "/portal/nodes": "/portal/settings/nodes",
      "/portal/coordinator-ops": "/portal/settings/admin"
    };
    for (const [url, location] of Object.entries(expected)) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe(location);
    }
    await app.close();
  });

  it("uses no inline event handlers in the shell or the moved pages", async () => {
    for (const url of ["/portal/dashboard", "/portal/chat", "/portal/settings", "/portal/settings/plan", "/portal/settings/compute", "/portal/settings/install"]) {
      const html = await page(url);
      expect(html, url).not.toMatch(/<[^>]+\son(click|change|input|submit|load)="/);
    }
  });
});

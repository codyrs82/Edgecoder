import vm from "node:vm";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { CLIENT_ESCAPE_JS } from "../../src/portal/pages/escape.js";
import { CLIENT_SAFE_MARKDOWN_JS } from "../../src/portal/pages/safe-markdown.js";
import { CODE_COMMON_JS } from "../../src/portal/pages/code-common.js";
import { CODE_DIFF_JS } from "../../src/portal/pages/code-diff.js";

/*
 * The web Code page (pages/code.ts): the shell renders at /portal/code and at a session's deep link
 * with no user data in it, its script parses, the sidebar links it next to Chat, and the browser
 * helpers escape everything a Mac sends (markdown, diffs, notes).
 */
async function page(url: string) {
  const app = Fastify();
  registerPortalPages(app);
  const res = await app.inject({ url });
  await app.close();
  return res;
}
const scripts = (html: string) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1])).map((m) => m[2]);

function helpers(): vm.Context {
  const ctx = vm.createContext({});
  vm.runInContext(CLIENT_ESCAPE_JS + CLIENT_SAFE_MARKDOWN_JS + CODE_COMMON_JS + CODE_DIFF_JS, ctx);
  return ctx;
}

describe("the Code page", () => {
  it("renders the list and the session shell at both URLs; every inline script parses", async () => {
    for (const url of ["/portal/code", "/portal/code/mac-1/11111111-1111-4111-8111-111111111111"]) {
      const res = await page(url);
      expect(res.statusCode, url).toBe(200);
      const html = res.body;
      for (const id of ["codeList", "codeMachines", "codeRefresh", "cnDialog", "cnProject", "cnMode", "codeSession", "csTitle", "csChip", "csMeta", "csMode", "csStop", "csUndo", "csNote", "csScroll", "csMessages", "csLive", "csOlder", "csInput", "csSend"]) {
        expect(html, `${url} ${id}`).toContain(`id="${id}"`);
      }
      // The same relay routes as the phone, and nothing from the URL is echoed into the page.
      expect(html).toContain('"/portal/api/code/machines"');
      expect(html).toContain('"/portal/api/code/" + encodeURIComponent(agentId) + "/commands"');
      expect(html).not.toContain("11111111-1111-4111-8111-111111111111");
      expect(html).toContain("Code from your phone");
      for (const s of scripts(html)) expect(() => new vm.Script(s), url).not.toThrow();
    }
  });

  it("is in the sidebar next to Chat, marked current on its own page", async () => {
    const dash = (await page("/portal/dashboard")).body;
    const nav = dash.slice(dash.indexOf('<nav class="sidebar-nav"'), dash.indexOf("</nav>", dash.indexOf('<nav class="sidebar-nav"')));
    expect(nav).toContain('href="/portal/code" title="Code"');
    expect(nav.indexOf('href="/portal/chat"')).toBeLessThan(nav.indexOf('href="/portal/code"'));
    expect(nav.indexOf('href="/portal/code"')).toBeLessThan(nav.indexOf('href="/portal/dashboard"'));
    const own = (await page("/portal/code")).body;
    expect(own).toContain('class="nav-link active" href="/portal/code" title="Code" aria-current="page"');
  });

  it("never offers Always allow and keeps Auto on the Mac", async () => {
    const html = (await page("/portal/code")).body;
    expect(html).not.toMatch(/data-approve-always|always:\s*true/);
    expect(html).toContain("Always-allow rules are set on the Mac.");
    expect(html).toContain("Auto (set on the Mac)");
    // Full access is shown, never offered as a choice the web can send.
    expect(html).toContain("Full access (set on the Mac)");
    expect(html).not.toMatch(/v === "full"/);
  });
});

describe("the Code page's browser helpers", () => {
  it("markdown escapes HTML from the Mac and keeps code blocks as text", () => {
    const ctx = helpers();
    const html = vm.runInContext(`renderMarkdown("<img src=x onerror=alert(1)> **bold**\\n\\n\\u0060\\u0060\\u0060js\\n<script>alert(1)</script>\\n\\u0060\\u0060\\u0060")`, ctx);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>");
  });

  it("diffs a file by line, with context, and escapes every line", () => {
    const ctx = helpers();
    ctx.file = { path: "<project>/a.ts", before: "one\ntwo\nthree\n<b>", after: "one\n2\nthree\n<b>\nfour", cut: false };
    const d = vm.runInContext("codeDiffHtml(file)", ctx);
    expect(d.what).toBe("+2 −1");
    expect(d.html).toContain('<span class="dl del">- two</span>');
    expect(d.html).toContain('<span class="dl add">+ 2</span>');
    expect(d.html).toContain('<span class="dl add">+ four</span>');
    expect(d.html).toContain('<span class="dl ctx">  &lt;b&gt;</span>');
    expect(d.html).not.toContain("<b>");
    expect(vm.runInContext(`codeDiffHtml({ path: "n", before: null, after: "x" }).what`, ctx)).toBe("new file");
    expect(vm.runInContext(`codeDiffHtml({ path: "n", before: "x", after: null }).what`, ctx)).toBe("deleted");
    const changes = vm.runInContext(`codeChangesHtml({ items: [{ path: "<i>p</i>", before: "a", after: "b" }], total: 3 })`, ctx);
    expect(changes).toContain("&lt;i&gt;p&lt;/i&gt;");
    expect(changes).toContain("2 more files changed");
  });

  it("says plainly why a Mac can't be driven, with how to turn Code from your phone on", () => {
    const ctx = helpers();
    const note = (m: unknown) => {
      ctx.m = m;
      return vm.runInContext("codeMachineNote(m)", ctx);
    };
    const base = { name: "MAW-MB-02", online: true, controls: "on", updatedAtMs: Date.now() };
    expect(note(base)).toBeNull();
    expect(note({ ...base, controls: "off" })).toContain("Code from your phone is off on MAW-MB-02");
    expect(note({ ...base, controls: "off" })).toContain("Settings, Code from your phone, and choose On");
    expect(note({ ...base, controls: "view" })).toContain("View only");
    expect(note({ ...base, online: false })).toContain("is offline");
    expect(note({ ...base, online: false, controls: "off" })).toContain("offline, or Code from your phone is off");
    expect(note(null)).toContain("isn't one of yours");
    expect(vm.runInContext(`codeErrorText(codeErr("relay_off"))`, ctx)).toContain("Code from your phone is off");
    expect(vm.runInContext(`codeErrorText(codeErr("agent_not_connected"))`, ctx)).toContain("offline");
  });
});

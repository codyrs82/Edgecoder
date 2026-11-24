import vm from "node:vm";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { CLIENT_ESCAPE_JS } from "../../src/portal/pages/escape.js";
import { CLIENT_SAFE_MARKDOWN_JS } from "../../src/portal/pages/safe-markdown.js";
import { CODE_COMMON_JS } from "../../src/portal/pages/code-common.js";
import { CODE_DIFF_JS } from "../../src/portal/pages/code-diff.js";
import { sidebarModeJs } from "../../src/portal/pages/sidebar-mode.js";

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

  it("is reached by the Chat / Code switch at the top of the sidebar, above New chat", async () => {
    const dash = (await page("/portal/dashboard")).body;
    const nav = dash.slice(dash.indexOf('<nav class="sidebar-nav"'), dash.indexOf("</nav>", dash.indexOf('<nav class="sidebar-nav"')));
    expect(nav).toContain('<div class="mode-switch" role="group" aria-label="Chat or Code">');
    expect(nav).toContain('<a class="mode-tab" href="/portal/chat" data-mode-tab="chat">');
    expect(nav).toContain('<a class="mode-tab" href="/portal/code" data-mode-tab="code">');
    expect(nav.indexOf('class="mode-switch"')).toBeLessThan(nav.indexOf('id="newChatBtn"'));
    // No separate Chat or Code rows any more: the switch is the way in.
    expect(nav).not.toContain('title="Code"');
    expect(nav).not.toContain('title="Chat"');
    // Other pages start in Chat mode and pick up the remembered mode in the browser.
    expect(dash).toContain('<aside class="sidebar" id="topbarNav" data-mode="chat">');
    expect(dash).toContain('var fixed = null, mode = fixed;');
    const own = (await page("/portal/code/mac-1/s-1")).body;
    expect(own).toContain('<aside class="sidebar" id="topbarNav" data-mode="code">');
    expect(own).toContain('href="/portal/code" data-mode-tab="code" aria-current="page"');
    expect(own).toContain('id="newSessionBtn" href="/portal/code"');
    expect(own).toContain('id="codeNavList"');
    expect(own).toContain('var fixed = "code", mode = fixed;');
    const chat = (await page("/portal/chat")).body;
    expect(chat).toContain('<aside class="sidebar" id="topbarNav" data-mode="chat">');
    expect(chat).toContain('href="/portal/chat" data-mode-tab="chat" aria-current="page"');
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

describe("the sidebar's Code mode list", () => {
  function sidebarCtx(stored: string | null): { ctx: vm.Context; store: Map<string, string> } {
    const store = new Map<string, string>(stored ? [["edgecoder-sidebar-mode", stored]] : []);
    const ctx = vm.createContext({
      document: { getElementById: () => null, querySelectorAll: () => [], hidden: false },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      location: { pathname: "/portal/dashboard" },
      setInterval: () => 0,
      fetch: () => Promise.reject(new Error("no network")),
    });
    vm.runInContext(CLIENT_ESCAPE_JS, ctx);
    return { ctx, store };
  }
  const machines = [
    {
      agentId: "mac-1", name: "Studio <Mac>", online: true, controls: "on",
      projects: [{ projectId: "p1", name: "edgecoder", parent: "~/src" }, { projectId: "p2", name: "site", parent: "~/src" }],
      sessions: [
        { sessionId: "s-old", projectId: "p1", title: "Old work", status: "idle", updatedAtMs: 1000 },
        { sessionId: "s-new", projectId: "p2", title: "<b>New</b> work", status: "waiting", updatedAtMs: 3000 },
        { sessionId: "s-mid", projectId: "p1", title: "Mid work", status: "running", updatedAtMs: 2000 },
      ],
    },
    { agentId: "mac-2", name: "Laptop", online: false, controls: "off", projects: [], sessions: [{ sessionId: "hidden", projectId: "p9", title: "Not shared", status: "idle", updatedAtMs: 9000 }] },
  ];

  it("groups sessions by project, newest first, each with the remote-computer icon and its Mac; escapes what the Mac sends", () => {
    const { ctx } = sidebarCtx(null);
    vm.runInContext(sidebarModeJs("code"), ctx);
    ctx.machines = machines;
    const html: string = vm.runInContext(`codeNavHtml(machines, "", "/portal/code/mac-1/s-mid")`, ctx);
    expect(html.indexOf(">site<")).toBeLessThan(html.indexOf(">edgecoder<"));
    expect(html.indexOf("Mid work")).toBeLessThan(html.indexOf("Old work"));
    expect(html).not.toContain("Not shared");
    expect(html).not.toContain("<b>New</b>");
    expect(html).toContain("&lt;b&gt;New&lt;/b&gt; work");
    expect(html).toContain("Studio &lt;Mac&gt;");
    expect(html).toContain('<span class="waiting">Waiting for you</span>');
    expect(html).toContain('href="/portal/code/mac-1/s-mid" aria-current="page"');
    expect(html.match(/<rect x="2" y="3" width="20" height="14"/g)).toHaveLength(3);
    // Search matches the title, the project or the Mac.
    const site: string = vm.runInContext(`codeNavHtml(machines, "site", "")`, ctx);
    expect(site).toContain("&lt;b&gt;New");
    expect(site).not.toContain("Old work");
    expect(vm.runInContext(`codeNavHtml(machines, "studio", "")`, ctx)).toContain("Old work");
    expect(vm.runInContext(`codeNavHtml(machines, "nothing like it", "")`, ctx)).toContain("No matching sessions");
  });

  it("asks you to turn on Code from your phone when no Mac shares its sessions", () => {
    const { ctx } = sidebarCtx(null);
    vm.runInContext(sidebarModeJs("code"), ctx);
    expect(vm.runInContext(`codeNavHtml([], "", "")`, ctx)).toContain("Turn on <strong>Code from your phone</strong> in the EdgeCoder app on your Mac");
    ctx.off = [machines[1]];
    expect(vm.runInContext(`codeNavHtml(off, "", "")`, ctx)).toContain("Code from your phone");
  });

  it("remembers the mode from the Chat and Code pages and reuses it elsewhere; storage errors are harmless", () => {
    const a = sidebarCtx(null);
    vm.runInContext(sidebarModeJs("code"), a.ctx);
    expect(a.store.get("edgecoder-sidebar-mode")).toBe("code");
    const b = sidebarCtx("code");
    expect(vm.runInContext(sidebarModeJs(null) + ";sidebarMode", b.ctx)).toBe("code");
    const c = sidebarCtx("weird");
    expect(vm.runInContext(sidebarModeJs(null) + ";sidebarMode", c.ctx)).toBe("chat");
    const d = sidebarCtx(null);
    d.ctx.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(vm.runInContext(sidebarModeJs("chat") + ";sidebarMode", d.ctx)).toBe("chat");
    expect(vm.runInContext(sidebarModeJs(null) + ";sidebarMode", d.ctx)).toBe("chat");
  });
});

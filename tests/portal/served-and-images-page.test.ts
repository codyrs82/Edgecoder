import vm from "node:vm";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { CLIENT_BOT_HELPERS_JS } from "../../src/portal/pages/bot-helpers.js";
import { CLIENT_ESCAPE_JS } from "../../src/portal/pages/escape.js";
import { IMAGE_ATTACH_JS } from "../../src/portal/pages/image-attach.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";

/*
 * The web bot page's "where it ran" line and the image composer's pieces, run as the browser would
 * run them: every value escaped, only checked data: URLs in an <img>, through its src property.
 */
function ctx(extra: Record<string, unknown> = {}) {
  const c = vm.createContext({ ...extra });
  vm.runInContext(CLIENT_ESCAPE_JS + CLIENT_BOT_HELPERS_JS + IMAGE_ATTACH_JS, c);
  return c;
}

describe("bot replies say where they ran", () => {
  it("model · machine · place · cost, and a run's Ran on without the cost", () => {
    const c = ctx();
    c.s = { model: "qwen3-coder:30b", machine: "Datacenter GPU 2×A16", place: "Frankfurt", calls: 2, cSats: 3.4 };
    expect(vm.runInContext("botServedText(s, true)", c)).toBe("qwen3-coder:30b · Datacenter GPU 2×A16 · Frankfurt · 2 calls · 3.4 cSats");
    expect(vm.runInContext("botRanOn({ where: 'Network · best fit', served: s })", c)).toBe("qwen3-coder:30b · Datacenter GPU 2×A16 · Frankfurt");
    // An older Mac sends no served line: today's text.
    expect(vm.runInContext("botRanOn({ where: 'Network · best fit' })", c)).toBe("Network · best fit");
    expect(vm.runInContext("botServedHtml({ role: 'assistant' }, '')", c)).toBe("");
    expect(vm.runInContext("botServedText({ model: 'm', calls: 1, cSats: 0 }, true)", c)).toBe("m · free");
    expect(vm.runInContext("botServedText({ model: 'claude-x', calls: 1, cSats: 0, usd: 0.02 }, true)", c)).toBe("claude-x · $0.02");
  });

  it("escapes what the Mac sent", () => {
    const c = ctx();
    const html = vm.runInContext(`botServedHtml({ role: "assistant", served: { model: "<img src=x onerror=alert(1)>", machine: "\\"><b>", calls: 1, cSats: 1 } }, "")`, c) as string;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
  });
});

describe("image composer", () => {
  it("only PNG, JPEG and WebP data URLs pass the check that guards every <img>", () => {
    const c = ctx();
    expect(vm.runInContext(`IMAGE_DATA_URL.test("data:image/png;base64,iVBORw0KGgo=")`, c)).toBe(true);
    expect(vm.runInContext(`IMAGE_DATA_URL.test("data:image/webp;base64,UklGRg==")`, c)).toBe(true);
    for (const bad of ["data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGI+", "javascript:alert(1)", 'data:image/png;base64,AA" onerror="x', "https://evil/x.png"]) {
      expect(vm.runInContext(`IMAGE_DATA_URL.test(${JSON.stringify(bad)})`, c), bad).toBe(false);
    }
    expect(vm.runInContext("IMAGE_ATTACH", c)).toMatchObject({ types: ["image/png", "image/jpeg", "image/webp"], count: 4, maxBytes: 5 * 1024 * 1024 });
  });

  it("the Code session and Chat composers have paste, drop and an attach button; their scripts parse", async () => {
    const app = Fastify();
    registerPortalPages(app);
    await app.ready();
    for (const [url, ids] of [["/portal/code/a/11111111-1111-4111-8111-111111111111", ["csAttach", "csFile", "csImgs"]], ["/portal/chat", ["chatAttach", "chatFile", "chatImgs", "chatImgNote"]]] as const) {
      const html = (await app.inject({ url })).body;
      for (const id of ids) expect(html, `${url} #${id}`).toContain(`id="${id}"`);
      expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
      for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(m[1]), url).not.toThrow();
    }
    expect((await app.inject({ url: "/portal/chat" })).body).toContain("This model can't read images.");
    await app.close();
  });
});

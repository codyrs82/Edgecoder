import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialConfig } from "../../src/social/config.js";
import { registerSocialRoutes } from "../../src/portal/social.js";
import { registerSettingsSocialPage, socialPageScript } from "../../src/portal/pages/settings-social.js";
import { SocialService } from "../../src/social/service.js";
import { MemorySocialStore } from "../../src/social/store.js";

/** Settings > Social posts: system admins only; approve -> post goes through the X client. */
describe("portal social admin routes", () => {
  const SECRETS = { consumerKey: "ck-secret-value-1", consumerSecret: "cs-secret-value-2", token: "tok-secret-value-3", tokenSecret: "ts-secret-value-4" };
  let user: { userId: string; email: string } | null;
  let isAdmin: boolean;
  let fetchMock: ReturnType<typeof vi.fn>;
  let store: MemorySocialStore;
  let app: FastifyInstance;

  const build = (config: Partial<SocialConfig> = {}) => {
    const svc = new SocialService({
      store,
      config: { sendEnabled: true, x: SECRETS, nostrSecret: null, relays: ["wss://relay.example"], tickMs: 60_000, docsSitemapUrl: "https://docs.edgecoder.io/sitemap.xml", ...config }
    });
    const a = Fastify();
    registerSocialRoutes(a, { service: svc, getCurrentUser: async () => user, buildAccessContext: async () => ({ isSystemAdmin: isAdmin }) });
    return a;
  };

  beforeEach(() => {
    user = { userId: "u-root", email: "root@example.com" };
    isAdmin = true;
    store = new MemorySocialStore();
    // The X client's default fetch is the global one: every outbound call lands here.
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: "1860000000000000001", text: "x" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    app = build();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  const post = (url: string, payload: unknown = {}) => app.inject({ method: "POST", url, payload: payload as object });

  it("refuses anonymous and non-admin sessions on every route", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/portal/api/admin/social"],
      ["POST", "/portal/api/admin/social/settings"],
      ["POST", "/portal/api/admin/social/check"],
      ["POST", "/portal/api/admin/social/drafts"],
      ["POST", "/portal/api/admin/social/posts/00000000-0000-4000-8000-000000000000/edit"],
      ["POST", "/portal/api/admin/social/posts/00000000-0000-4000-8000-000000000000/approve"],
      ["POST", "/portal/api/admin/social/posts/00000000-0000-4000-8000-000000000000/reject"],
      ["POST", "/portal/api/admin/social/run"]
    ];
    user = null;
    for (const [method, url] of routes) expect((await app.inject({ method: method as "GET", url, payload: method === "POST" ? {} : undefined })).statusCode).toBe(401);
    user = { userId: "u", email: "u@example.com" };
    isAdmin = false;
    for (const [method, url] of routes) expect((await app.inject({ method: method as "GET", url, payload: method === "POST" ? {} : undefined })).statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts paused and shows configured status as booleans only", async () => {
    const r = await app.inject({ url: "/portal/api/admin/social" });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.settings.enabled).toBe(false);
    expect(j.sending).toEqual({ ok: false, reason: "paused" });
    expect(j.channels).toEqual({ sendEnabledEnv: true, x: { configured: true }, nostr: { configured: false, invalid: false, relays: ["wss://relay.example"] } });
    for (const v of Object.values(SECRETS)) expect(r.body).not.toContain(v);
  });

  it("a paused system never calls fetch, even when a post is approved or the job runs", async () => {
    const d = await post("/portal/api/admin/social/drafts", { text: "Hello from EdgeCoder" });
    expect(d.statusCode).toBe(200);
    const id = d.json().post.id;
    const a = await post(`/portal/api/admin/social/posts/${id}/approve`);
    expect(a.statusCode).toBe(200);
    expect(a.json().post.status).toBe("approved");
    expect(a.json().note).toMatch(/paused/);
    expect((await post("/portal/api/admin/social/run")).json()).toMatchObject({ skipped: "paused" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("approve -> post calls the X client once and records the tweet", async () => {
    expect((await post("/portal/api/admin/social/settings", { enabled: true })).json().sending).toEqual({ ok: true, reason: null });
    const d = await post("/portal/api/admin/social/drafts", { text: "Draft text" });
    const id = d.json().post.id;
    const a = await post(`/portal/api/admin/social/posts/${id}/approve`, { text: "Edited before approving" });
    expect(a.statusCode).toBe(200);
    expect(a.json().post).toMatchObject({ status: "posted", text: "Edited before approving", xTweetId: "1860000000000000001", xUrl: "https://x.com/i/web/status/1860000000000000001", nostrNote: "skipped: NOSTR_BRAND_NSEC not set" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.x.com/2/tweets");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Edited before approving" });
    expect(init.headers.authorization).toMatch(/^OAuth oauth_consumer_key="ck-secret-value-1", oauth_nonce="[0-9a-f]+", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="tok-secret-value-3", oauth_version="1.0"$/);
    const list = await app.inject({ url: "/portal/api/admin/social" });
    expect(list.json().recent.map((p: { id: string }) => p.id)).toEqual([id]);
    expect(list.body).not.toContain("cs-secret-value-2");
    expect(list.body).not.toContain("ts-secret-value-4");
  });

  it("refuses to approve a draft that breaks a rule (422) and checks text", async () => {
    await post("/portal/api/admin/social/settings", { enabled: true });
    const d = await post("/portal/api/admin/social/drafts", { text: "Earn passive income on your iPhone" });
    const a = await post(`/portal/api/admin/social/posts/${d.json().post.id}/approve`);
    expect(a.statusCode).toBe(422);
    expect(a.json().problems.map((p: { code: string }) => p.code).sort()).toEqual(["ios_earning", "passive_income"]);
    const c = await post("/portal/api/admin/social/check", { text: "thanks @someone" });
    expect(c.json().problems.map((p: { code: string }) => p.code)).toEqual(["mention"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates ids and bodies", async () => {
    expect((await post("/portal/api/admin/social/posts/not-a-uuid/approve")).statusCode).toBe(400);
    expect((await post("/portal/api/admin/social/settings", { enabled: "yes" })).statusCode).toBe(400);
    expect((await post("/portal/api/admin/social/posts/00000000-0000-4000-8000-000000000000/approve")).statusCode).toBe(404);
  });

  it("the env switch keeps an enabled system from sending", async () => {
    await app.close();
    app = build({ sendEnabled: false });
    await post("/portal/api/admin/social/settings", { enabled: true });
    const d = await post("/portal/api/admin/social/drafts", { text: "Hello" });
    const a = await post(`/portal/api/admin/social/posts/${d.json().post.id}/approve`);
    expect(a.json().post.status).toBe("approved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the Settings > Social posts page shell with no data", async () => {
    const page = Fastify();
    registerSettingsSocialPage(page);
    const html = (await page.inject({ url: "/portal/settings/social" })).body;
    expect(html).toMatch(/class="settings-link" href="\/portal\/settings\/social" data-admin-only data-section="social" aria-current="page"/);
    for (const id of ["socSwitch", "socChannels", "socCompose", "socQueue", "socRecent"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("/portal/api/admin/social");
    expect(() => new Function(socialPageScript())).not.toThrow();
    await page.close();
  });
});

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GROWTH_SCHEMA_SQL, MemoryGrowthStore } from "../../src/growth/store.js";
import type { Email } from "../../src/growth/report.js";
import { digestEmail } from "../../src/growth/report.js";
import { SIGNUP_ALERTS_PER_HOUR, SIGNUP_BATCH_DELAY_MS, setupPortalGrowth } from "../../src/portal/growth.js";
import { registerSettingsSocialPage, socialPageScript } from "../../src/portal/pages/settings-social.js";
import { shortLinkTarget } from "../../src/portal/short-links.js";
import type { SocialPost } from "../../src/social/store.js";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
// 2026-11-23 07:30 in Chicago (CST, UTC-6): before the 8:00 digest.
const T0 = Date.UTC(2026, 10, 23, 13, 30);

function post(id: string, text: string, status: SocialPost["status"], xTweetId: string | null = null): SocialPost {
  return {
    id, sourceKey: id, kind: "manual", text, status, createdAtMs: T0 - 86_400_000, updatedAtMs: T0 - 86_400_000, approvedBy: null, approvedAtMs: null,
    postedAtMs: status === "posted" ? T0 - 86_400_000 : null, dedupeHash: null, xTweetId, nostrEventId: null, nostrNote: null, error: null,
    threadId: null, threadPosition: null, scheduledAtMs: null, replyToTweetId: null
  };
}

describe("portal growth signals", () => {
  let app: FastifyInstance;
  let store: MemoryGrowthStore;
  let sent: Email[];
  let now: number;
  let user: { userId: string; email: string } | null;
  let isAdmin: boolean;
  let growth: ReturnType<typeof setupPortalGrowth>;

  const build = (send: ((e: Email) => Promise<void>) | null = async (e) => void sent.push(e)) => {
    const a = Fastify();
    growth = setupPortalGrowth(a, {
      pool: null,
      portalUrl: "https://edgecoder.io/",
      getCurrentUser: async () => user,
      buildAccessContext: async () => ({ isSystemAdmin: isAdmin }),
      store,
      config: { ignore: ["@sixthirty.ai", "owner@example.com"] },
      send,
      socialPosts: async () => [post("p1", "Chat on the web: edgecoder.io/x/web-chat", "posted", "1860000000000000001"), post("p2", "draft edgecoder.io/x/web-chat", "draft")],
      now: () => now
    });
    a.get("/", async (_req, reply) => reply.type("text/html").send("<!doctype html><p>home</p>"));
    a.get("/reserves", async (_req, reply) => reply.type("text/html").header("cache-control", "public, max-age=60").send("<p>reserves</p>"));
    a.get("/reserves.json", async () => ({ ok: true }));
    a.get<{ Params: { campaign: string } }>("/x/:campaign", async (req, reply) => {
      const to = shortLinkTarget(req.params.campaign);
      if (!to) return reply.code(404).send("Not found");
      return reply.header("cache-control", "no-store").redirect(to, 302);
    });
    return a;
  };

  beforeEach(() => {
    store = new MemoryGrowthStore();
    sent = [];
    now = T0;
    user = { userId: "admin", email: "admin@example.com" };
    isAdmin = true;
    app = build();
  });
  afterEach(async () => {
    await app.close();
  });

  const get = (url: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") => app.inject({ method, url, headers: { "user-agent": BROWSER, ...headers } });
  const cookieOf = (r: { headers: Record<string, unknown> }) => {
    const sc = r.headers["set-cookie"];
    const list = Array.isArray(sc) ? sc : sc ? [String(sc)] : [];
    const c = list.find((x) => x.startsWith("ec_utm="));
    return c ? c.split(";")[0]! : null;
  };
  const visits = () => [...store.daily.values()].reduce((n, r) => n + r.visits, 0);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("counts a tagged page visit once per visitor per day and sets the first-party cookie", async () => {
    const r = await get("/?utm_source=x&utm_medium=paid&utm_campaign=launch&utm_content=video-1");
    await flush();
    expect(r.statusCode).toBe(200);
    const cookie = cookieOf(r);
    expect(cookie).toBeTruthy();
    const raw = String(r.headers["set-cookie"]);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect([...store.daily.values()]).toEqual([{ day: "2026-11-23", source: "x", medium: "paid", campaign: "launch", content: "video-1", visits: 1, signups: 0 }]);
    // Reloads with the cookie do not count; a new visitor does.
    await get("/?utm_source=x&utm_medium=paid&utm_campaign=launch&utm_content=video-1", { cookie: cookie! });
    await get("/?utm_source=x&utm_medium=paid&utm_campaign=launch&utm_content=video-1");
    await flush();
    expect(visits()).toBe(2);
  });

  it("counts the /x short link once, not again on the page it redirects to", async () => {
    const r = await get("/x/reserves-sats");
    expect(r.statusCode).toBe(302);
    const cookie = cookieOf(r)!;
    expect(cookie).toBeTruthy();
    await get(String(r.headers.location), { cookie });
    await flush();
    expect([...store.daily.values()]).toEqual([{ day: "2026-11-23", source: "x", medium: "social", campaign: "reserves-sats", content: "", visits: 1, signups: 0 }]);
    // A public, cacheable page keeps its caching when nothing is set.
    const again = await get(String(r.headers.location), { cookie });
    expect(again.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("ignores HEAD, robots, untagged pages, JSON and 404s", async () => {
    await get("/?utm_source=x&utm_campaign=a", {}, "HEAD");
    await get("/?utm_source=x&utm_campaign=a", { "user-agent": "Twitterbot/1.0" });
    await get("/");
    await get("/reserves.json?utm_source=x&utm_campaign=a");
    await get("/x/BAD!");
    await flush();
    expect(visits()).toBe(0);
  });

  it("never breaks a page on a bad cookie or a failing store", async () => {
    store.addVisit = async () => {
      throw new Error("db down");
    };
    const r = await get("/?utm_source=x&utm_campaign=a", { cookie: "ec_utm=%E0%A4%A" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("home");
  });

  it("credits a sign-up to the first-touch campaign and alerts with the details", async () => {
    const r = await get("/x/web-chat");
    const cookie = cookieOf(r)!;
    now = T0 + 5 * 60_000;
    await growth.handleSignup({ userId: "u1", email: "jane@example.org", method: "google", cookieHeader: `other=1; ${cookie}` });
    expect(store.signups.get("u1")).toMatchObject({ method: "google", first: { source: "x", medium: "social", campaign: "web-chat", content: "", atMs: T0 }, alertState: "sent" });
    expect([...store.daily.values()][0]).toMatchObject({ campaign: "web-chat", visits: 1, signups: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("New EdgeCoder sign-up: jane@example.org");
    expect(sent[0]!.text).toContain("Signed up with: Google");
    expect(sent[0]!.text).toContain("Time: Nov 23, 2026, 7:35 AM CST");
    expect(sent[0]!.text).toContain("Campaign: x / social / web-chat");
    expect(sent[0]!.text).toContain("Post: https://x.com/i/web/status/1860000000000000001");
    expect(sent[0]!.text).toContain("Admin: https://edgecoder.io/portal/settings/admin?user=jane%40example.org");
    expect(sent[0]!.html).not.toContain("<script");
  });

  it("records an untagged sign-up without a campaign; ignored addresses never alert or count", async () => {
    await growth.handleSignup({ userId: "u2", email: "bob@example.org", method: "email", cookieHeader: undefined });
    expect(sent[0]!.text).toContain("Campaign: none (direct or untagged)");
    const r = await get("/?utm_source=x&utm_campaign=launch");
    await growth.handleSignup({ userId: "u3", email: "Cody+test@SixThirty.ai", method: "email", cookieHeader: cookieOf(r)! });
    await growth.handleSignup({ userId: "u4", email: "owner@example.com", method: "github", cookieHeader: undefined });
    expect(sent).toHaveLength(1);
    expect(store.signups.get("u3")?.alertState).toBe("ignored");
    expect([...store.daily.values()][0]).toMatchObject({ campaign: "launch", signups: 0 });
    // Recorded once only.
    await growth.handleSignup({ userId: "u2", email: "bob@example.org", method: "email", cookieHeader: undefined });
    expect(sent).toHaveLength(1);
  });

  it("onSignup never throws or waits, even when sending fails", async () => {
    await app.close();
    app = build(async () => {
      throw new Error("resend down");
    });
    expect(() => growth.onSignup({ userId: "u5", email: "x@example.org", method: "email", cookieHeader: undefined })).not.toThrow();
    await flush();
    expect(store.signups.has("u5")).toBe(true);
  });

  it("sends at most 10 single alerts an hour and batches the rest into one message", async () => {
    for (let i = 0; i < SIGNUP_ALERTS_PER_HOUR + 4; i++) {
      now = T0 + i * 1000;
      await growth.handleSignup({ userId: `b${i}`, email: `user${i}@example.org`, method: "email", cookieHeader: undefined });
    }
    expect(sent).toHaveLength(SIGNUP_ALERTS_PER_HOUR);
    // Held alerts wait for the batch delay, then go as one message.
    expect((await growth.tick()).batched).toBe(0);
    now = T0 + SIGNUP_BATCH_DELAY_MS + 15_000;
    expect((await growth.tick()).batched).toBe(4);
    expect(sent).toHaveLength(SIGNUP_ALERTS_PER_HOUR + 1);
    const batch = sent[sent.length - 1]!;
    expect(batch.subject).toBe("EdgeCoder: 4 more new sign-ups");
    for (let i = SIGNUP_ALERTS_PER_HOUR; i < SIGNUP_ALERTS_PER_HOUR + 4; i++) expect(batch.text).toContain(`user${i}@example.org`);
    expect((await growth.tick()).batched).toBe(0);
    // An hour after the first alerts, single alerts resume.
    now = T0 + 3_700_000;
    await growth.handleSignup({ userId: "late", email: "late@example.org", method: "email", cookieHeader: undefined });
    expect(sent[sent.length - 1]!.subject).toBe("New EdgeCoder sign-up: late@example.org");
  });

  it("sends the daily digest once, at 8:00 Chicago, for yesterday", async () => {
    // Yesterday: a visit and a sign-up from web-chat, an ignored sign-up.
    now = T0 - 86_400_000;
    const r = await get("/x/web-chat");
    await growth.handleSignup({ userId: "d1", email: "dana@example.org", method: "email", cookieHeader: cookieOf(r)! });
    await growth.handleSignup({ userId: "d2", email: "cody@sixthirty.ai", method: "email", cookieHeader: undefined });
    sent = [];
    now = T0; // 7:30
    expect((await growth.tick()).digest).toBeNull();
    now = T0 + 31 * 60_000; // 8:01
    expect((await growth.tick()).digest).toBe("2026-11-22");
    expect((await growth.tick()).digest).toBeNull();
    expect(sent).toHaveLength(1);
    const d = sent[0]!;
    expect(d.subject).toBe("EdgeCoder daily 2026-11-22: 1 visit from campaigns, 1 sign-up");
    expect(d.text).toContain("web-chat · x/social · 1 visits · 1 sign-ups · https://x.com/i/web/status/1860000000000000001");
    expect(d.text).toContain("New sign-ups: 1 (plus 1 from ignored accounts)");
    expect(d.text).toContain("dana@example.org");
    expect(d.text).not.toContain("cody@sixthirty.ai");
    expect(d.html).toContain("https://edgecoder.io/portal/settings/social#traffic");
  });

  it("keeps an empty digest to one line", () => {
    const e = digestEmail({ day: "2026-11-22", rows: [], signups: [], isIgnored: () => false, posts: new Map(), panelUrl: "https://edgecoder.io/x" });
    expect(e.text).toBe("2026-11-22: no campaign visits and no new sign-ups.");
    expect(e.text.split("\n")).toHaveLength(1);
  });

  it("does nothing by mail when alert email is not configured", async () => {
    await app.close();
    app = build(null);
    await growth.handleSignup({ userId: "n1", email: "n@example.org", method: "email", cookieHeader: undefined });
    now = T0 + 3_600_000;
    expect(await growth.tick()).toEqual({ batched: 0, digest: null });
    expect(store.signups.get("n1")?.alertState).toBe("off");
  });

  it("the admin API is system-admin only and lists 14 days with the post of each campaign", async () => {
    user = null;
    expect((await get("/portal/api/admin/growth")).statusCode).toBe(401);
    user = { userId: "u", email: "u@example.com" };
    isAdmin = false;
    expect((await get("/portal/api/admin/growth")).statusCode).toBe(403);
    isAdmin = true;
    const r1 = await get("/x/web-chat");
    await get("/?utm_source=x&utm_medium=paid&utm_campaign=launch&utm_content=v1");
    await growth.handleSignup({ userId: "a1", email: "a@example.org", method: "email", cookieHeader: cookieOf(r1)! });
    const r = await get("/portal/api/admin/growth");
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const j = r.json();
    expect(j.days).toHaveLength(14);
    expect(j.days[0]).toBe("2026-11-23");
    expect(j.totals).toEqual({ visits: 2, campaignSignups: 1, signups: 1 });
    const web = j.rows.find((x: { campaign: string }) => x.campaign === "web-chat");
    expect(web.post).toMatchObject({ id: "p1", status: "posted", xUrl: "https://x.com/i/web/status/1860000000000000001" });
    expect(j.rows.find((x: { campaign: string }) => x.campaign === "launch").post).toBeNull();
    // The admin API itself is never counted and sets no cookie.
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("the Traffic from X panel renders on the social page and its script parses", async () => {
    const a = Fastify();
    registerSettingsSocialPage(a);
    const r = await a.inject({ url: "/portal/settings/social" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="traffic"');
    expect(r.body).toContain('id="trafficRows"');
    expect(socialPageScript()).toContain("/portal/api/admin/growth");
    expect(() => new Function(socialPageScript())).not.toThrow();
    await a.close();
  });

  it("creates its tables in code (no migration), tied to portal_users", () => {
    expect(GROWTH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS growth_utm_daily");
    expect(GROWTH_SCHEMA_SQL).toContain("REFERENCES portal_users (user_id) ON DELETE CASCADE");
    expect(GROWTH_SCHEMA_SQL).not.toMatch(/\b(ip|user_agent)\b/i);
  });
});

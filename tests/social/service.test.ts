import { describe, expect, it, vi } from "vitest";
import type { SocialConfig } from "../../src/social/config.js";
import { socialConfigFromEnv } from "../../src/social/config.js";
import { DUPLICATE_WINDOW_MS, SocialService, STUCK_POSTING_MS } from "../../src/social/service.js";
import { MemorySocialStore } from "../../src/social/store.js";
import type { FetchLike } from "../../src/social/x-client.js";

const X = { consumerKey: "ck", consumerSecret: "cs", token: "t", tokenSecret: "ts" };
const NSEC_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";

function harness(o: { config?: Partial<SocialConfig>; enabled?: boolean; xStatus?: number; sources?: ConstructorParameters<typeof SocialService>[0]["sources"] } = {}) {
  const clock = { now: Date.UTC(2026, 10, 23, 12) };
  const store = new MemorySocialStore();
  const calls: Array<{ url: string; body: string | undefined; auth: string }> = [];
  let nextId = 1000;
  const fetch: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, body: init.body as string | undefined, auth: init.headers.authorization ?? "" });
    const status = o.xStatus ?? 201;
    return { status, text: async () => (status === 201 ? JSON.stringify({ data: { id: String(nextId++), text: "x" } }) : JSON.stringify({ title: "Forbidden", detail: "duplicate content" })) };
  });
  const nostr = vi.fn(async () => ({ ok: true as const, eventId: "ab".repeat(32), relaysOk: 2, relays: 3 }));
  const config: SocialConfig = { sendEnabled: true, x: X, nostrSecret: NSEC_HEX, relays: ["wss://r1", "wss://r2", "wss://r3"], tickMs: 60_000, docsSitemapUrl: "https://docs.edgecoder.io/sitemap.xml", siteUrl: "https://edgecoder.io/", ...o.config };
  const svc = new SocialService({ store, config, fetch, publishNostr: nostr, now: () => clock.now, sources: o.sources });
  const ready = o.enabled === false ? Promise.resolve() : svc.setEnabled(true, "root@example.com").then(() => undefined);
  return { svc, store, calls, fetch, nostr, clock, ready };
}

describe("social config", () => {
  it("needs exactly SOCIAL_POSTING_ENABLED=1 and all four X values", () => {
    expect(socialConfigFromEnv({}).sendEnabled).toBe(false);
    expect(socialConfigFromEnv({ SOCIAL_POSTING_ENABLED: "true" }).sendEnabled).toBe(false);
    expect(socialConfigFromEnv({ SOCIAL_POSTING_ENABLED: "1" }).sendEnabled).toBe(true);
    expect(socialConfigFromEnv({ X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c" }).x).toBeNull();
    expect(socialConfigFromEnv({ X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_TOKEN_SECRET: "d" }).x).not.toBeNull();
    expect(socialConfigFromEnv({}).relays).toEqual(["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]);
    expect(socialConfigFromEnv({ SOCIAL_NOSTR_RELAYS: "wss://a, http://b ,wss://a" }).relays).toEqual(["wss://a"]);
  });
});

describe("approval state machine", () => {
  it("draft -> approved -> posted, with X and Nostr", async () => {
    const h = harness();
    await h.ready;
    const c = await h.svc.compose("@someone Hello from EdgeCoder https://edgecoder.io/?utm_source=x&utm_medium=social&utm_campaign=manual");
    expect(c.ok && c.post.text.startsWith("Hello")).toBe(true);
    const id = c.ok ? c.post.id : "";
    const r = await h.svc.approve(id, "root@example.com");
    expect(r.ok && r.post.status).toBe("posted");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe("https://api.x.com/2/tweets");
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({ text: expect.stringMatching(/^Hello from EdgeCoder/) });
    expect(h.calls[0]!.auth).toMatch(/^OAuth .*oauth_signature_method="HMAC-SHA1"/);
    expect(h.nostr).toHaveBeenCalledTimes(1);
    expect((h.nostr.mock.calls[0] as unknown[])[0]).toContain("utm_source=nostr");
    const post = await h.store.get(id);
    expect(post).toMatchObject({ status: "posted", xTweetId: "1000", nostrEventId: "ab".repeat(32), nostrNote: "posted to 2 of 3 relays", approvedBy: "root@example.com" });
    // Posted is final.
    expect((await h.svc.approve(id, "root@example.com")).ok).toBe(false);
    expect((await h.svc.edit(id, "changed")).ok).toBe(false);
    expect((await h.svc.reject(id)).ok).toBe(false);
  });

  it("refuses a draft that breaks a rule until it is edited", async () => {
    const h = harness();
    await h.ready;
    const c = await h.svc.compose("EdgeCoder is open source!");
    const id = c.ok ? c.post.id : "";
    const r = await h.svc.approve(id, "root");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems?.map((p) => p.code)).toEqual(["open_source"]);
    expect((await h.store.get(id))!.status).toBe("draft");
    expect(h.calls).toHaveLength(0);
    // Editing in the approve call is checked too.
    expect((await h.svc.approve(id, "root", "As good as GPT-4, now.")).ok).toBe(false);
    const ok = await h.svc.approve(id, "root", "EdgeCoder is source-available.");
    expect(ok.ok && ok.post.status).toBe("posted");
  });

  it("rejects drafts and approved posts; rejected is final", async () => {
    const h = harness({ config: { sendEnabled: false } });
    await h.ready;
    const a = await h.svc.compose("one");
    const b = await h.svc.compose("two");
    const aid = a.ok ? a.post.id : "";
    const bid = b.ok ? b.post.id : "";
    expect((await h.svc.reject(aid)).ok).toBe(true);
    expect((await h.svc.approve(aid, "root")).ok).toBe(false);
    const approved = await h.svc.approve(bid, "root");
    expect(approved.ok && approved.post.status).toBe("approved");
    expect(approved.ok && approved.note).toMatch(/SOCIAL_POSTING_ENABLED/);
    expect((await h.svc.reject(bid)).ok).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("an X failure fails the post (no Nostr); edit returns it to draft; approve retries", async () => {
    const h = harness({ xStatus: 403 });
    await h.ready;
    const c = await h.svc.compose("Hello world");
    const id = c.ok ? c.post.id : "";
    const r = await h.svc.approve(id, "root");
    expect(r.ok && r.post.status).toBe("failed");
    expect(r.ok && r.post.error).toBe("x_http_403: Forbidden: duplicate content");
    expect(h.nostr).not.toHaveBeenCalled();
    expect((await h.svc.edit(id, "Hello again")).ok && (await h.store.get(id))!.status).toBe("draft");
  });

  it("skips Nostr without NOSTR_BRAND_NSEC and still posts to X", async () => {
    const h = harness({ config: { nostrSecret: null } });
    await h.ready;
    const c = await h.svc.compose("Hello world");
    const r = await h.svc.approve(c.ok ? c.post.id : "", "root");
    expect(r.ok && r.post).toMatchObject({ status: "posted", xTweetId: "1000", nostrEventId: null, nostrNote: "skipped: NOSTR_BRAND_NSEC not set" });
    expect(h.nostr).not.toHaveBeenCalled();
  });

  it("fails without X credentials", async () => {
    const h = harness({ config: { x: null } });
    await h.ready;
    const c = await h.svc.compose("Hello world");
    const r = await h.svc.approve(c.ok ? c.post.id : "", "root");
    expect(r.ok && r.post.status).toBe("failed");
    expect(h.calls).toHaveLength(0);
  });

  it("marks a post stuck in posting as failed", async () => {
    const h = harness();
    await h.ready;
    const p = (await h.store.insertDraft({ sourceKey: "manual:x", kind: "manual", text: "stuck" }, h.clock.now))!;
    await h.store.transition(p.id, ["draft"], { status: "posting" }, h.clock.now);
    expect(await h.svc.recoverStuck()).toBe(0);
    h.clock.now += STUCK_POSTING_MS;
    expect(await h.svc.recoverStuck()).toBe(1);
    expect((await h.store.get(p.id))!.status).toBe("failed");
  });
});

describe("duplicates", () => {
  it("drafts are deduped by source key", async () => {
    const h = harness();
    expect(await h.svc.addDraft({ sourceKey: "release:desktop:1.2.3", kind: "release", text: "a" })).not.toBeNull();
    expect(await h.svc.addDraft({ sourceKey: "release:desktop:1.2.3", kind: "release", text: "b" })).toBeNull();
  });

  it("refuses text posted in the last 90 days (normalized), allows it after", async () => {
    const h = harness();
    await h.ready;
    const a = await h.svc.compose("Hello   World https://edgecoder.io/?utm_source=x");
    expect((await h.svc.approve(a.ok ? a.post.id : "", "root")).ok).toBe(true);
    const b = await h.svc.compose("hello world https://edgecoder.io/?utm_source=nostr");
    const bid = b.ok ? b.post.id : "";
    const refused = await h.svc.approve(bid, "root");
    expect(!refused.ok && refused.problems?.map((p) => p.code)).toEqual(["duplicate"]);
    h.clock.now += DUPLICATE_WINDOW_MS + 1;
    const ok = await h.svc.approve(bid, "root");
    expect(ok.ok && ok.post.status).toBe("posted");
    expect(h.calls).toHaveLength(2);
  });
});

describe("pause switch", () => {
  it("starts paused: approving queues, nothing is sent, the job does nothing", async () => {
    const releases = vi.fn(async () => []);
    const h = harness({ enabled: false, sources: { releases } });
    expect((await h.svc.settings()).enabled).toBe(false);
    expect(await h.svc.canSend()).toEqual({ ok: false, reason: "paused" });
    const c = await h.svc.compose("Hello world");
    const r = await h.svc.approve(c.ok ? c.post.id : "", "root");
    expect(r.ok && r.post.status).toBe("approved");
    expect(await h.svc.tick()).toEqual({ skipped: "paused", drafted: 0, sent: 0 });
    expect(await h.svc.sendApproved()).toBe(0);
    expect(releases).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.nostr).not.toHaveBeenCalled();
    // Turning it on sends the approved post at the next run.
    await h.svc.setEnabled(true, "root");
    expect((await h.svc.tick()).sent).toBe(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("the env switch alone also blocks sending", async () => {
    const h = harness({ config: { sendEnabled: false } });
    await h.ready;
    const c = await h.svc.compose("Hello world");
    await h.svc.approve(c.ok ? c.post.id : "", "root");
    expect((await h.svc.tick()).sent).toBe(0);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("drafting job", () => {
  it("baselines releases and docs on the first run, then drafts what is new", async () => {
    let listing: unknown[] = [{ tag_name: "desktop-v1.4.53", body: "" }, { tag_name: "agent-v1.2.2", body: "" }];
    let sitemap = "<urlset><url><loc>https://docs.edgecoder.io/guides/a/</loc></url></urlset>";
    const fetchText = vi.fn(async (url: string) => (url.endsWith("sitemap.xml") ? sitemap : "<title>Run a host | Docs</title>"));
    const network = vi.fn(async () => ({ agents: [{ connected: true, blacklisted: false, userId: "u1" }], series: { points: [{ atMs: Date.UTC(2026, 10, 23, 11), completed: 5 }] } }));
    const h = harness({ config: { sendEnabled: false }, sources: { releases: async () => listing, fetchText, network } });
    await h.ready;
    const first = await h.svc.tick();
    expect(first.drafted).toBe(1); // the weekly report only
    expect((await h.svc.queue()).map((p) => p.sourceKey)).toEqual(["weekly:2026-W48"]);
    listing = [...listing, { tag_name: "desktop-v1.4.54", body: "Faster downloads" }, { tag_name: "agent-v1.2.1", body: "" }];
    sitemap = sitemap.replace("</urlset>", "<url><loc>https://docs.edgecoder.io/guides/run-a-host/</loc></url></urlset>");
    const second = await h.svc.tick();
    expect(second.drafted).toBe(2);
    const keys = (await h.svc.queue()).map((p) => p.sourceKey).sort();
    expect(keys).toEqual(["docs:/guides/run-a-host", "release:desktop:1.4.54", "weekly:2026-W48"]);
    expect((await h.svc.tick()).drafted).toBe(0);
    // The weekly sources are asked once per week, not every run.
    expect(network).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

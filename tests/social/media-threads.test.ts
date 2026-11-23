import { describe, expect, it, vi } from "vitest";
import type { SocialConfig } from "../../src/social/config.js";
import { chicagoLocalToUtcMs, parseSchedule, utcMsToChicagoLocal, validateImage } from "../../src/social/media.js";
import { SocialService } from "../../src/social/service.js";
import { MemorySocialStore } from "../../src/social/store.js";
import { oauthBaseString, oauthSign, percentEncode, uploadMedia, X_MEDIA_METADATA_URL, X_MEDIA_UPLOAD_URL, X_TWEETS_URL, type FetchLike } from "../../src/social/x-client.js";

const X = { consumerKey: "ck", consumerSecret: "cs", token: "t", tokenSecret: "ts" };
// A 1x1 PNG and the start of a JPEG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]).toString("base64");
const GIF_B64 = Buffer.from("GIF89a....").toString("base64");

type Call = { url: string; body: string | Uint8Array | undefined; headers: Record<string, string> };

/** A mock X: media upload ids 7001.., tweet ids 9001..; `failTweet` makes the n-th tweet (1-based) fail. */
function harness(o: { config?: Partial<SocialConfig>; enabled?: boolean; failTweet?: number } = {}) {
  const clock = { now: Date.UTC(2026, 10, 23, 18) };
  const store = new MemorySocialStore();
  const calls: Call[] = [];
  let media = 7001;
  let tweet = 9001;
  let tweets = 0;
  const fetch: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (url === X_MEDIA_UPLOAD_URL) return { status: 200, text: async () => JSON.stringify({ data: { id: String(media++), media_key: "3_x" } }) };
    if (url === X_MEDIA_METADATA_URL) return { status: 200, text: async () => JSON.stringify({ data: { id: "x" } }) };
    tweets++;
    if (o.failTweet === tweets) return { status: 503, text: async () => JSON.stringify({ title: "Service Unavailable" }) };
    return { status: 201, text: async () => JSON.stringify({ data: { id: String(tweet++), text: "x" } }) };
  });
  const nostr = vi.fn(async () => ({ ok: true as const, eventId: "ab".repeat(32), relaysOk: 1, relays: 1 }));
  const config: SocialConfig = { sendEnabled: true, x: X, nostrSecret: null, relays: ["wss://r1"], tickMs: 900_000, docsSitemapUrl: null, siteUrl: null, ...o.config };
  const svc = new SocialService({ store, config, fetch, publishNostr: nostr, now: () => clock.now });
  const ready = o.enabled === false ? Promise.resolve() : svc.setEnabled(true, "root@example.com").then(() => undefined);
  const tweetBodies = () => calls.filter((c) => c.url === X_TWEETS_URL).map((c) => JSON.parse(String(c.body)));
  return { svc, store, calls, fetch, nostr, clock, ready, tweetBodies };
}

const idOf = (r: { ok: boolean; post?: { id: string } | null }) => r.post!.id;

describe("X media upload signing", () => {
  it("signs the multipart upload with the oauth_* params only (body fields excluded from the base string)", async () => {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body, headers: init.headers });
      return { status: 200, text: async () => JSON.stringify({ data: { id: "7001" } }) };
    };
    const bytes = new Uint8Array(Buffer.from(PNG_B64, "base64"));
    const r = await uploadMedia({ filename: "a.png", contentType: "image/png", bytes }, X, { fetch, nonce: "abc123", timestampSec: 1_800_000_000 });
    expect(r).toEqual({ ok: true, id: "7001" });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.x.com/2/media/upload");
    expect(c.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const body = Buffer.from(c.body as Uint8Array).toString("latin1");
    expect(body).toContain('name="media_category"\r\n\r\ntweet_image');
    expect(body).toContain('name="media"; filename="a.png"\r\nContent-Type: image/png');
    // The header is exactly the signature over the oauth_* params alone.
    const expected = oauthSign({ method: "POST", url: X_MEDIA_UPLOAD_URL, creds: X, nonce: "abc123", timestampSec: 1_800_000_000 });
    expect(c.headers.authorization).toBe(expected.header);
    expect(expected.baseString).not.toContain("media_category");
    expect(expected.baseString).toBe(
      oauthBaseString("POST", X_MEDIA_UPLOAD_URL, [
        ["oauth_consumer_key", "ck"],
        ["oauth_nonce", "abc123"],
        ["oauth_signature_method", "HMAC-SHA1"],
        ["oauth_timestamp", "1800000000"],
        ["oauth_token", "t"],
        ["oauth_version", "1.0"]
      ])
    );
    // Signing the form fields would give a different signature (what X would reject).
    const withBody = oauthSign({ method: "POST", url: X_MEDIA_UPLOAD_URL, creds: X, nonce: "abc123", timestampSec: 1_800_000_000, bodyParams: { media_category: "tweet_image" } });
    expect(withBody.signature).not.toBe(expected.signature);
    expect(c.headers.authorization).toContain(`oauth_signature="${percentEncode(expected.signature)}"`);
  });
});

describe("images", () => {
  it("validates type from the bytes, size and alt text", () => {
    expect(validateImage({ filename: "a.png", base64: PNG_B64 }).ok).toBe(true);
    const j = validateImage({ filename: "../../etc/b.jpg", base64: `data:image/jpeg;base64,${JPEG_B64}`, alt: "A chart" });
    expect(j.ok && j.image).toMatchObject({ filename: "b.jpg", contentType: "image/jpeg", alt: "A chart" });
    expect(validateImage({ filename: "a.png", base64: GIF_B64 })).toEqual({ ok: false, error: "image_type_not_png_or_jpeg" });
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    Buffer.from(PNG_B64, "base64").copy(big);
    expect(validateImage({ filename: "a.png", base64: big.toString("base64") })).toEqual({ ok: false, error: "image_too_large" });
    const alt = validateImage({ filename: "a.png", base64: PNG_B64, alt: "Our open source app" });
    expect(!alt.ok && alt.problems?.map((p) => p.code)).toEqual(["open_source"]);
  });

  it("uploads each image, sets alt text, then posts the tweet with media_ids", async () => {
    const h = harness();
    await h.ready;
    const c = await h.svc.compose("Two screenshots of the new release");
    const id = idOf(c);
    expect((await h.svc.addImage(id, { filename: "one.png", base64: PNG_B64, alt: "The queue" })).ok).toBe(true);
    expect((await h.svc.addImage(id, { filename: "two.jpg", base64: JPEG_B64 })).ok).toBe(true);
    const r = await h.svc.approve(id, "root");
    expect(r.ok && r.post).toMatchObject({ status: "posted", xTweetId: "9001" });
    expect(h.calls.map((x) => x.url)).toEqual([X_MEDIA_UPLOAD_URL, X_MEDIA_METADATA_URL, X_MEDIA_UPLOAD_URL, X_TWEETS_URL]);
    expect(JSON.parse(String(h.calls[1]!.body))).toEqual({ id: "7001", metadata: { alt_text: { text: "The queue" } } });
    expect(h.tweetBodies()).toEqual([{ text: "Two screenshots of the new release", media: { media_ids: ["7001", "7002"] } }]);
    for (const call of h.calls) expect(call.headers.authorization).toMatch(/^OAuth .*oauth_signature_method="HMAC-SHA1"/);
  });

  it("allows at most 4 images, only while the post is editable", async () => {
    const h = harness({ config: { sendEnabled: false } });
    await h.ready;
    const id = idOf(await h.svc.compose("Hello"));
    for (let i = 0; i < 4; i++) expect((await h.svc.addImage(id, { filename: `${i}.png`, base64: PNG_B64 })).ok).toBe(true);
    expect(await h.svc.addImage(id, { filename: "5.png", base64: PNG_B64 })).toEqual({ ok: false, error: "too_many_images" });
    await h.svc.approve(id, "root");
    expect(await h.svc.addImage(id, { filename: "x.png", base64: PNG_B64 })).toEqual({ ok: false, error: "not_editable" });
  });

  it("an image upload failure fails the post without tweeting", async () => {
    const h = harness();
    await h.ready;
    (h.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ status: 400, text: async () => JSON.stringify({ title: "Invalid Request" }) }));
    const id = idOf(await h.svc.compose("Hello"));
    await h.svc.addImage(id, { filename: "a.png", base64: PNG_B64 });
    const r = await h.svc.approve(id, "root");
    expect(r.ok && r.post.status).toBe("failed");
    expect(r.ok && r.post.error).toMatch(/^image 1 \(a\.png\): x_http_400/);
    expect(h.tweetBodies()).toEqual([]);
  });
});

describe("threads", () => {
  async function thread(h: ReturnType<typeof harness>, texts: string[], key = "launch") {
    const ids: string[] = [];
    for (const t of texts) ids.push(idOf(await h.svc.compose(t, { threadId: key })));
    return ids;
  }

  it("approving one post approves the thread; each next post replies only to our previous post", async () => {
    const h = harness();
    await h.ready;
    const ids = await thread(h, ["First", "Second", "Third"]);
    expect((await h.store.get(ids[2]!))!.threadPosition).toBe(3);
    const r = await h.svc.approve(ids[1]!, "root");
    expect(r.ok).toBe(true);
    expect(h.tweetBodies()).toEqual([
      { text: "First" },
      { text: "Second", reply: { in_reply_to_tweet_id: "9001" } },
      { text: "Third", reply: { in_reply_to_tweet_id: "9002" } }
    ]);
    const posts = await Promise.all(ids.map((id) => h.store.get(id)));
    expect(posts.map((p) => [p!.status, p!.xTweetId, p!.replyToTweetId])).toEqual([
      ["posted", "9001", null],
      ["posted", "9002", "9001"],
      ["posted", "9003", "9002"]
    ]);
    // Nostr: sequential plain notes, one per post (skipped here: no key).
    expect(posts.every((p) => p!.nostrNote === "skipped: NOSTR_BRAND_NSEC not set")).toBe(true);
  });

  it("stops at a failed post, marks the rest failed, records what posted, and resumes on retry", async () => {
    const h = harness({ failTweet: 2 });
    await h.ready;
    const ids = await thread(h, ["One", "Two", "Three"]);
    await h.svc.approve(ids[0]!, "root");
    const [a, b, c] = await Promise.all(ids.map((id) => h.store.get(id)));
    expect(a).toMatchObject({ status: "posted", xTweetId: "9001" });
    expect(b).toMatchObject({ status: "failed", xTweetId: null });
    expect(b!.error).toMatch(/x_http_503/);
    expect(c).toMatchObject({ status: "failed", xTweetId: null });
    expect(c!.error).toMatch(/post 2 of this thread failed.*Posted: 1\./);
    expect(h.tweetBodies()).toHaveLength(2);
    // Retry: the rest goes out, replying to the post this system recorded for position 1.
    const retry = await h.svc.approve(ids[1]!, "root");
    expect(retry.ok).toBe(true);
    const bodies = h.tweetBodies();
    expect(bodies.slice(2)).toEqual([
      { text: "Two", reply: { in_reply_to_tweet_id: "9001" } },
      { text: "Three", reply: { in_reply_to_tweet_id: "9002" } }
    ]);
    // Every reply target is an id X returned to us for this thread.
    const ours = new Set((await Promise.all(ids.map((id) => h.store.get(id)))).map((p) => p!.xTweetId));
    for (const body of bodies) if (body.reply) expect(ours.has(body.reply.in_reply_to_tweet_id)).toBe(true);
  });

  it("a rule problem in any post approves none of the thread", async () => {
    const h = harness();
    await h.ready;
    const ids = await thread(h, ["Fine", "Thanks @someone", "Fine too"]);
    const r = await h.svc.approve(ids[0]!, "root");
    expect(!r.ok && r.problems?.map((p) => p.message)).toEqual([expect.stringMatching(/^Post 2: Contains an @mention/)]);
    expect((await Promise.all(ids.map((id) => h.store.get(id)))).map((p) => p!.status)).toEqual(["draft", "draft", "draft"]);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses repeated text inside a thread", async () => {
    const h = harness();
    await h.ready;
    const ids = await thread(h, ["Same", "same"]);
    const r = await h.svc.approve(ids[0]!, "root");
    expect(!r.ok && r.problems?.map((p) => p.code)).toEqual(["duplicate"]);
  });

  it("the X client refuses a reply target that is not a tweet id", async () => {
    const { postTweet } = await import("../../src/social/x-client.js");
    const fetch = vi.fn();
    expect(await postTweet("x", X, { fetch, inReplyToOwnTweetId: "someone" })).toEqual({ ok: false, error: "invalid reply target" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("send times", () => {
  it("America/Chicago conversions follow DST", () => {
    expect(chicagoLocalToUtcMs("2026-12-01T09:30")).toBe(Date.UTC(2026, 11, 1, 15, 30));
    expect(chicagoLocalToUtcMs("2026-07-01T09:30")).toBe(Date.UTC(2026, 6, 1, 14, 30));
    expect(utcMsToChicagoLocal(Date.UTC(2026, 11, 1, 15, 30))).toBe("2026-12-01T09:30");
    expect(chicagoLocalToUtcMs("2026-02-30T09:30")).toBeNull();
    expect(parseSchedule({ scheduledAt: "2026-12-01T15:30:00Z" })).toEqual({ ok: true, ms: Date.UTC(2026, 11, 1, 15, 30) });
    expect(parseSchedule({ scheduledAt: "2026-12-01T15:30:00" }).ok).toBe(false);
    expect(parseSchedule({ scheduledAt: null })).toEqual({ ok: true, ms: null });
    expect(parseSchedule({})).toEqual({ ok: true, ms: undefined });
  });

  it("an approved post waits for its time, then the minute check sends it", async () => {
    const h = harness();
    await h.ready;
    const id = idOf(await h.svc.compose("Scheduled hello", { scheduledAtMs: h.clock.now + 3_600_000 }));
    const r = await h.svc.approve(id, "root");
    expect(r.ok && r.post.status).toBe("approved");
    expect(r.ok && r.note).toMatch(/Scheduled/);
    expect(await h.svc.sendDue()).toBe(0);
    h.clock.now += 3_599_000;
    expect(await h.svc.sendDue()).toBe(0);
    expect(h.fetch).not.toHaveBeenCalled();
    h.clock.now += 1_000;
    expect(await h.svc.sendDue()).toBe(1);
    expect((await h.store.get(id))!.status).toBe("posted");
  });

  it("the time can be changed or cleared before it sends; a thread moves together", async () => {
    const h = harness();
    await h.ready;
    const a = idOf(await h.svc.compose("A", { threadId: "t", scheduledAtMs: h.clock.now + 86_400_000 }));
    const b = idOf(await h.svc.compose("B", { threadId: "t" }));
    await h.svc.approve(a, "root");
    expect(await h.svc.sendDue()).toBe(0);
    expect((await h.svc.setSchedule(b, h.clock.now + 60_000)).ok).toBe(true);
    expect((await h.store.get(a))!.scheduledAtMs).toBe(h.clock.now + 60_000);
    expect(await h.svc.sendDue()).toBe(0);
    expect((await h.svc.setSchedule(a, null)).ok).toBe(true);
    expect(await h.svc.sendDue()).toBe(2);
    expect((await h.svc.setSchedule(a, h.clock.now)).ok).toBe(false);
  });
});

describe("bulk import", () => {
  const plan = () => [
    { text: "Thread start", threadKey: "launch", position: 1, scheduledAtMs: Date.UTC(2026, 11, 1, 15), images: [{ filename: "hero.png", base64: PNG_B64, alt: "Hero" }] },
    { text: "Thread end", threadKey: "launch", position: 2 },
    { text: "Single", key: "single-1" }
  ];

  it("creates drafts (never approved) and does not duplicate on re-import", async () => {
    const h = harness();
    await h.ready;
    const first = await h.svc.importPosts(plan());
    expect(first.created.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(first.errors).toEqual([]);
    const posts = await Promise.all(first.created.map((c) => h.store.get(c.id)));
    expect(posts.map((p) => [p!.status, p!.kind, p!.threadId, p!.threadPosition])).toEqual([
      ["draft", "import", "launch", 1],
      ["draft", "import", "launch", 2],
      ["draft", "import", null, null]
    ]);
    expect(posts[0]!.scheduledAtMs).toBe(Date.UTC(2026, 11, 1, 15));
    expect(posts[2]!.sourceKey).toBe("import:single-1");
    expect(await h.store.listImages([posts[0]!.id])).toHaveLength(1);
    const again = await h.svc.importPosts(plan());
    expect(again.created).toEqual([]);
    expect(again.existing.map((e) => e.id)).toEqual(first.created.map((c) => c.id));
    expect(h.store.posts.size).toBe(3);
    expect(h.store.images.size).toBe(1);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("an item with a bad image creates nothing; rule problems are reported but still drafted", async () => {
    const h = harness();
    const r = await h.svc.importPosts([
      { text: "Bad image", images: [{ filename: "a.gif", base64: GIF_B64 }] },
      { text: "EdgeCoder is open source" }
    ]);
    expect(r.errors).toEqual([{ index: 0, error: "image 1: image_type_not_png_or_jpeg" }]);
    expect(r.created.map((c) => [c.index, c.problems.map((p) => p.code)])).toEqual([[1, ["open_source"]]]);
    expect(h.store.posts.size).toBe(1);
  });
});

describe("paused", () => {
  it("a paused system sends nothing: not on approve, not on the minute check, not on the drafting run", async () => {
    const h = harness({ enabled: false });
    const imported = await h.svc.importPosts([{ text: "One", threadKey: "t", position: 1 }, { text: "Two", threadKey: "t", position: 2 }, { text: "Solo" }]);
    for (const c of imported.created) await h.svc.approve(c.id, "root");
    const id = idOf(await h.svc.compose("With image"));
    await h.svc.addImage(id, { filename: "a.png", base64: PNG_B64 });
    await h.svc.approve(id, "root");
    expect(await h.svc.sendDue()).toBe(0);
    expect(await h.svc.sendThread("t")).toEqual({ posted: 0, failed: 0 });
    expect(await h.svc.tick()).toEqual({ skipped: "paused", drafted: 0, sent: 0 });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.nostr).not.toHaveBeenCalled();
    expect((await h.store.list(["approved"], 10)).length).toBe(4);
  });
});

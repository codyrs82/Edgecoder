import pg from "pg";
import { describe, expect, it } from "vitest";
import { validateImage } from "../../src/social/media.js";
import { PostgresSocialStore } from "../../src/social/store.js";

const PG_URL = process.env.TEST_DATABASE_URL;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The social store's SQL (images as bytea, threads, due query) against real Postgres. */
describe.skipIf(!PG_URL)("PostgresSocialStore against real Postgres", () => {
  it("stores images (at most 4), threads, send times and compare-and-set transitions", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    try {
      const store = new PostgresSocialStore(pool);
      const tag = `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      const a = (await store.insertDraft({ sourceKey: `test:${tag}:a`, kind: "import", text: "A", threadId: tag, threadPosition: 1, scheduledAtMs: now + 60_000 }, now))!;
      const b = (await store.insertDraft({ sourceKey: `test:${tag}:b`, kind: "import", text: "B", threadId: tag, threadPosition: 2 }, now))!;
      expect(await store.insertDraft({ sourceKey: `test:${tag}:a`, kind: "import", text: "dup" }, now)).toBeNull();
      expect((await store.getBySourceKey(`test:${tag}:b`))!.id).toBe(b.id);
      expect((await store.threadPosts(tag)).map((p) => p.id)).toEqual([a.id, b.id]);
      expect(a.scheduledAtMs).toBe(now + 60_000);

      const img = validateImage({ filename: "a.png", base64: PNG_B64, alt: "Alt" });
      if (!img.ok) throw new Error("bad fixture");
      const added = [];
      for (let i = 0; i < 5; i++) added.push(await store.addImage(a.id, img.image, now));
      expect(added.slice(0, 4).map((r) => (r === "full" ? r : r.position))).toEqual([0, 1, 2, 3]);
      expect(added[4]).toBe("full");
      const listed = await store.listImages([a.id, b.id]);
      expect(listed).toHaveLength(4);
      const full = await store.postImages(a.id);
      expect(Buffer.from(full[0]!.bytes).equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
      expect(full[0]).toMatchObject({ contentType: "image/png", alt: "Alt", filename: "a.png" });
      const first = listed[0]!;
      expect(await store.deleteImage(b.id, first.id)).toBe(false);
      expect(await store.deleteImage(a.id, first.id)).toBe(true);
      expect(await store.getImage(first.id)).toBeNull();

      await store.transition(a.id, ["draft"], { status: "approved", approvedAtMs: now }, now);
      await store.transition(b.id, ["draft"], { status: "approved", approvedAtMs: now }, now);
      const dueNow = (await store.listDue(now, 500)).map((p) => p.id);
      expect(dueNow).toContain(b.id);
      expect(dueNow).not.toContain(a.id);
      expect((await store.listDue(now + 60_000, 500)).map((p) => p.id)).toContain(a.id);
      expect((await store.transition(a.id, ["approved"], { scheduledAtMs: null, replyToTweetId: "123" }, now))!).toMatchObject({ scheduledAtMs: null, replyToTweetId: "123" });
      expect(await store.transition(a.id, ["draft"], { status: "posting" }, now)).toBeNull();
      await pool.query(`DELETE FROM social_posts WHERE source_key LIKE $1`, [`test:${tag}:%`]);
    } finally {
      await pool.end();
    }
  });
});

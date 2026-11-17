import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PortalStore } from "../../src/portal/store.js";
import { compactReplyUsage, REPLY_USAGE_MAX_BYTES, REPLY_USAGE_MAX_CALLS } from "../../src/portal/reply-usage.js";
import { servedLine } from "../../src/common/served.js";

const served = { label: "m1", own: false, computeClass: "datacenter", tier: null, hardware: "Datacenter GPU", gpu: "2× NVIDIA A16", region: null, city: "Chicago", country: "US", promptTokens: 2400, outputTokens: 312, promptMs: 8100, genMs: 6500 };
const usage = { cSats: 3.4, where: "Network", calls: [{ cSats: 3.4, where: "Network", model: "qwen3-coder:30b", served }] };

/** A pool that records queries and keeps portal_messages rows in memory. */
function fakePool() {
  const rows: Record<string, unknown>[] = [];
  const texts: string[] = [];
  return {
    texts,
    rows,
    async query(text: string, params: unknown[] = []) {
      texts.push(text);
      if (text.startsWith("INSERT INTO portal_messages")) {
        const [message_id, conversation_id, role, content, tokens_used, credits_spent, created_at_ms, usage_meta] = params;
        rows.push({ message_id, conversation_id, role, content, tokens_used, credits_spent, created_at_ms, usage_meta: usage_meta == null ? null : JSON.parse(usage_meta as string) });
      }
      if (text.includes("FROM portal_messages")) return { rows };
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("compactReplyUsage (what is stored with a reply)", () => {
  it("keeps the footer's fields and drops anything else", () => {
    const u = compactReplyUsage({ ...usage, prompt: "secret", calls: [{ ...usage.calls[0], apiKey: "sk-x", served: { ...served, token: "t" } }] });
    expect(JSON.stringify(u)).not.toMatch(/secret|sk-x|"token"/);
    expect(servedLine(u!.calls)).toBe(servedLine(usage.calls));
  });
  it("stores at most 20 calls and stays under 4 KB", () => {
    const many = { cSats: 50, where: "Network", calls: Array.from({ length: 60 }, (_, i) => ({ cSats: 1, model: `m-${i}-${"x".repeat(150)}`, served: { ...served, hardware: "h".repeat(190) } })) };
    const u = compactReplyUsage(many)!;
    expect(u.calls.length).toBeLessThanOrEqual(REPLY_USAGE_MAX_CALLS);
    expect(Buffer.byteLength(JSON.stringify(u))).toBeLessThanOrEqual(REPLY_USAGE_MAX_BYTES);
    expect(u.cSats).toBe(50);
    expect(u.calls.at(-1)!.model).toMatch(/^m-59-/);
  });
  it("is undefined for nothing usable", () => {
    expect(compactReplyUsage(undefined)).toBeUndefined();
    expect(compactReplyUsage("x")).toBeUndefined();
  });
});

describe("portal_messages.usage_meta", () => {
  it("migrate adds the nullable JSONB column idempotently", async () => {
    const pool = fakePool();
    await new PortalStore(pool as never).migrate();
    expect(pool.texts.join("\n")).toContain("ALTER TABLE portal_messages ADD COLUMN IF NOT EXISTS usage_meta JSONB");
  });
  it("saves the reply's usage and returns it when the chat loads; older rows have none", async () => {
    const pool = fakePool();
    const store = new PortalStore(pool as never);
    await store.addMessage({ messageId: "a", conversationId: "c", role: "user", content: "hi", usageMeta: usage });
    await store.addMessage({ messageId: "b", conversationId: "c", role: "assistant", content: "yo", creditsSpent: 3, usageMeta: usage });
    pool.rows.push({ message_id: "old", conversation_id: "c", role: "assistant", content: "old", tokens_used: 0, credits_spent: 2, created_at_ms: 1, usage_meta: null });
    const msgs = await store.getConversationMessages("c", 50);
    expect(msgs[0].usageMeta).toBeUndefined();
    expect(msgs[1].usageMeta).toEqual(usage);
    expect(msgs[2].usageMeta).toBeUndefined();
    expect(msgs[2].creditsSpent).toBe(2);
  });
});

// Real Postgres (CI's service, or a local one via TEST_DATABASE_URL).
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("usage_meta against real Postgres", () => {
  it("applies on an existing table without the column and on a migrated one, then round-trips", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      const store = new PortalStore(pool);
      await store.migrate();
      await pool.query(`ALTER TABLE portal_messages DROP COLUMN IF EXISTS usage_meta`); // an existing DB from before
      await store.migrate();
      await store.migrate(); // idempotent
      const conv = `conv-${randomUUID()}`;
      await store.createConversation({ conversationId: conv, userId: `u-${randomUUID()}`, title: "t" });
      await store.addMessage({ messageId: randomUUID(), conversationId: conv, role: "assistant", content: "yo", usageMeta: usage });
      expect((await store.getConversationMessages(conv, 10))[0].usageMeta).toEqual(usage);
      await store.deleteConversation(conv);
    } finally {
      await pool.end();
    }
  });
});

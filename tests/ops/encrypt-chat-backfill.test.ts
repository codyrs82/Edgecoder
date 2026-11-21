import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ChatCipher, messageAad, titleAad } from "../../src/portal/chat-crypto.js";
// @ts-expect-error plain ESM script without type declarations
import * as script from "../../scripts/ops/encrypt-chat-backfill.mjs";

const { backfill, parseArgs, planBatch, TARGETS } = script as any;
const KEY = randomBytes(32);
const cipher = new ChatCipher(KEY, () => undefined);

/** An in-memory db adapter with the same contract as pgAdapter. */
function memoryDb() {
  const tables: Record<string, Array<{ id: string; conversationId: string; value: string }>> = {
    portal_messages: [],
    portal_conversations: []
  };
  let updates = 0;
  return {
    tables,
    get updates() {
      return updates;
    },
    async countPlain(t: any) {
      return tables[t.table].filter((r) => !r.value.startsWith("enc:")).length;
    },
    async fetchPlain(t: any, afterId: string, limit: number) {
      return tables[t.table]
        .filter((r) => !r.value.startsWith("enc:") && r.id > afterId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async update(t: any, id: string, oldValue: string, newValue: string) {
      const row = tables[t.table].find((r) => r.id === id && r.value === oldValue);
      if (!row) return false;
      row.value = newValue;
      updates += 1;
      return true;
    }
  };
}

function seed() {
  const db = memoryDb();
  for (let i = 0; i < 7; i++) db.tables.portal_messages.push({ id: `m${i}`, conversationId: i < 4 ? "c1" : "c2", value: `message ${i}` });
  const already = cipher.seal("already sealed", messageAad("c1", "m9"));
  db.tables.portal_messages.push({ id: "m9", conversationId: "c1", value: already });
  db.tables.portal_conversations.push({ id: "c1", conversationId: "c1", value: "First" }, { id: "c2", conversationId: "c2", value: "Second" });
  return { db, already };
}

describe("encrypt-chat-backfill", () => {
  it("--dry-run only counts", async () => {
    const { db } = seed();
    const r = await backfill({ db, key: null, dryRun: true, batchSize: 3 });
    expect(r.messages.plaintext).toBe(7);
    expect(r.titles.plaintext).toBe(2);
    expect(db.updates).toBe(0);
    expect(db.tables.portal_messages[0].value).toBe("message 0");
  });

  it("seals every plaintext row in batches, bound to its row, so the portal reads it back", async () => {
    const { db, already } = seed();
    const r = await backfill({ db, key: KEY, batchSize: 3 });
    expect(r.messages).toEqual({ plaintext: 7, sealed: 7, skipped: 0 });
    expect(r.titles).toEqual({ plaintext: 2, sealed: 2, skipped: 0 });
    for (const row of db.tables.portal_messages) {
      expect(row.value).toMatch(/^enc:v1:/);
      expect(cipher.open(row.value, messageAad(row.conversationId, row.id))).toMatch(/^(message \d|already sealed)$/);
    }
    expect(db.tables.portal_messages.find((m) => m.id === "m9")!.value).toBe(already);
    expect(cipher.open(db.tables.portal_conversations[1].value, titleAad("c2"))).toBe("Second");
  });

  it("is idempotent: a second run changes nothing", async () => {
    const { db } = seed();
    await backfill({ db, key: KEY, batchSize: 3 });
    const snapshot = JSON.stringify(db.tables);
    const updates = db.updates;
    const again = await backfill({ db, key: KEY, batchSize: 3 });
    expect(again.messages).toEqual({ plaintext: 0, sealed: 0, skipped: 0 });
    expect(again.titles).toEqual({ plaintext: 0, sealed: 0, skipped: 0 });
    expect(db.updates).toBe(updates);
    expect(JSON.stringify(db.tables)).toBe(snapshot);
  });

  it("planBatch skips sealed rows; a row changed since it was read is skipped, not clobbered", async () => {
    expect(planBatch(TARGETS.messages, [{ id: "a", conversationId: "c", value: "enc:v1:xyz" }], KEY)).toEqual([]);
    const { db } = seed();
    const realUpdate = db.update.bind(db);
    db.update = async (t: any, id: string, oldValue: string, newValue: string) => {
      if (id === "m1") db.tables.portal_messages[1].value = "edited meanwhile";
      return realUpdate(t, id, oldValue, newValue);
    };
    const r = await backfill({ db, key: KEY, batchSize: 100 });
    expect(r.messages.skipped).toBe(1);
    expect(db.tables.portal_messages[1].value).toBe("edited meanwhile");
  });

  it("refuses to write without a key, and parses its arguments", async () => {
    await expect(backfill({ db: memoryDb(), key: null })).rejects.toThrow(/PORTAL_CHAT_KEY/);
    expect(parseArgs([])).toEqual({ dryRun: false, batchSize: 500, help: false });
    expect(parseArgs(["--dry-run", "--batch-size=50"])).toEqual({ dryRun: true, batchSize: 50, help: false });
    expect(() => parseArgs(["--batch-size=0"])).toThrow();
    expect(() => parseArgs(["--force"])).toThrow(/unknown/);
  });
});

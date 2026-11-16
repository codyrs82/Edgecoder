import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { isEncryptedJson, parseQueueDataKey, QueueDataCodec } from "../../src/db/queue-data-codec.js";
import { PostgresStore } from "../../src/db/postgres.js";

const subtask = { id: "sub-1", taskId: "t-1", kind: "inference", input: "user secret prompt", snapshotRef: "", projectMeta: { projectId: "p", resourceClass: "cpu", priority: 50 } };

describe("queue data encryption at rest", () => {
  const key = randomBytes(32);
  const codec = new QueueDataCodec([key]);

  test("payloads and outputs are stored encrypted and read back", () => {
    const stored = codec.encodeJson(subtask, "queue_tasks:sub-1");
    expect(stored).not.toContain("user secret prompt");
    expect(isEncryptedJson(JSON.parse(stored))).toBe(true);
    expect(codec.decodeJson(JSON.parse(stored), "queue_tasks:sub-1")).toEqual(subtask);
    const out = codec.encodeText("model answer", "queue_results:sub-1");
    expect(out.startsWith("enc:v1:")).toBe(true);
    expect(out).not.toContain("model answer");
    expect(codec.decodeText(out, "queue_results:sub-1")).toBe("model answer");
  });

  test("old plaintext rows still read", () => {
    expect(codec.decodeJson(subtask, "queue_tasks:sub-1")).toEqual(subtask);
    expect(codec.decodeJson(JSON.stringify(subtask), "queue_tasks:sub-1")).toEqual(subtask);
    expect(codec.decodeText("plain output", "queue_results:sub-1")).toBe("plain output");
  });

  test("a value moved to another row, or read with another key, does not open", () => {
    const stored = JSON.parse(codec.encodeJson(subtask, "queue_tasks:sub-1"));
    expect(() => codec.decodeJson(stored, "queue_tasks:sub-2")).toThrow();
    expect(() => new QueueDataCodec([randomBytes(32)]).decodeJson(stored, "queue_tasks:sub-1")).toThrow(/queue_data_key_unknown/);
  });

  test("moving from the PEM-derived key to QUEUE_DATA_KEY keeps old rows readable", () => {
    const pem = createPeerKeys("coord-data").privateKeyPem;
    const old = QueueDataCodec.fromEnv({ COORDINATOR_PRIVATE_KEY_PEM: pem });
    const stored = JSON.parse(old.encodeJson(subtask, "queue_tasks:sub-1"));
    const next = QueueDataCodec.fromEnv({ COORDINATOR_PRIVATE_KEY_PEM: pem, QUEUE_DATA_KEY: key.toString("hex") });
    expect(next.decodeJson(stored, "queue_tasks:sub-1")).toEqual(subtask);
    // New writes use QUEUE_DATA_KEY.
    expect(codec.decodeJson(JSON.parse(next.encodeJson(subtask, "queue_tasks:sub-1")), "queue_tasks:sub-1")).toEqual(subtask);
  });

  test("no key: plaintext, as before", () => {
    const off = QueueDataCodec.fromEnv({});
    expect(off.enabled).toBe(false);
    expect(JSON.parse(off.encodeJson(subtask, "x"))).toEqual(subtask);
    expect(off.encodeText("a", "x")).toBe("a");
  });

  test("QUEUE_DATA_KEY must be 32 bytes", () => {
    expect(parseQueueDataKey(key.toString("base64")).equals(key)).toBe(true);
    expect(() => parseQueueDataKey("tooshort")).toThrow(/32 bytes/);
  });
});

/** Records the SQL and parameters PostgresStore sends, with canned rows. */
function fakePool(rows: (sql: string) => unknown[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); const r = rows(sql); return { rows: r, rowCount: r.length }; } } as any
  };
}

describe("PostgresStore writes queue data encrypted", () => {
  const codec = new QueueDataCodec([randomBytes(32)]);

  test("persistSubtask and persistResult send ciphertext; listUnfinishedSubtasks reads both forms", async () => {
    const { pool, calls } = fakePool();
    const store = new PostgresStore(pool, codec);
    await store.persistSubtask(subtask as any);
    await store.persistResult({ subtaskId: "sub-1", taskId: "t-1", agentId: "a", ok: true, output: "model answer", durationMs: 1 });
    const sent = JSON.stringify(calls.map((c) => c.params));
    expect(sent).not.toContain("user secret prompt");
    expect(sent).not.toContain("model answer");

    const encrypted = JSON.parse(calls[0].params[2] as string);
    const reader = new PostgresStore(fakePool((sql) => (sql.includes("FROM queue_tasks q") ? [
      { subtask_id: "sub-1", payload_json: encrypted, claimed_by: null, claimed_at_ms: null, attempts: 0 },
      { subtask_id: "sub-old", payload_json: { ...subtask, id: "sub-old" }, claimed_by: "a", claimed_at_ms: "5", attempts: 1 },
      { subtask_id: "sub-foreign", payload_json: JSON.parse(new QueueDataCodec([randomBytes(32)]).encodeJson(subtask, "queue_tasks:sub-foreign")), claimed_by: null, claimed_at_ms: null, attempts: 0 }
    ] : [])).pool, codec);
    const rows = await reader.listUnfinishedSubtasks(["sub-1", "sub-old", "sub-foreign"]);
    expect(rows.map((r) => r.subtask.id)).toEqual(["sub-1", "sub-old"]);
    expect(rows[0].subtask.input).toBe("user secret prompt");
  });

  test("retention sweep deletes in batches until a short batch", async () => {
    let n = 0;
    const { pool, calls } = fakePool((sql) => (sql.includes("DELETE FROM queue_results") ? [{ n: n++ === 0 ? 2 : 1 }] : []));
    const removed = await new PostgresStore(pool, codec).sweepQueueRetention(1_000, 2);
    expect(removed).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].params).toEqual([1_000, 2]);
    expect(calls[0].sql).toMatch(/DELETE FROM queue_tasks/);
  });
});

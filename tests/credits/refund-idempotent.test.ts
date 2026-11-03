import { describe, expect, it } from "vitest";
import { CreditEngine } from "../../src/credits/engine.js";
import { creditEngine, grantCreditsIdempotent, refundTxId } from "../../src/credits/store.js";

// #160: a task-submit refund must be paid exactly once even when the first attempt threw
// after (or before) the write, so the tx id is derived from the task id and re-used.
describe("refund idempotency (#160)", () => {
  it("refundTxId is deterministic per task and distinct across tasks", () => {
    expect(refundTxId("task-a")).toBe(refundTxId("task-a"));
    expect(refundTxId("task-a")).not.toBe(refundTxId("task-b"));
    expect(refundTxId("task-a")).toMatch(/^task_submit_refund:[0-9a-f]{32}$/);
  });

  it("CreditEngine.addIfAbsent records a tx once and returns the existing one on replay", () => {
    const engine = new CreditEngine();
    const tx = { txId: "t1", accountId: "acct", type: "earn" as const, credits: 1, reason: "task_submit_refund:x", timestampMs: 1 };
    engine.addIfAbsent(tx);
    engine.addIfAbsent({ ...tx, timestampMs: 2 });
    expect(engine.balance("acct")).toBe(1);
    expect(engine.history("acct")).toHaveLength(1);
  });

  it("grantCreditsIdempotent with the same tx id does not double-credit (in-memory store)", async () => {
    const account = `acct-${Date.now()}`;
    const before = creditEngine.balance(account);
    const txId = refundTxId(`task-${Date.now()}`);
    await grantCreditsIdempotent(account, 1, "task_submit_refund:t", txId);
    await grantCreditsIdempotent(account, 1, "task_submit_refund:t", txId);
    expect(creditEngine.balance(account) - before).toBe(1);
  });

  it("rejects zero/negative/invalid amounts and empty tx ids", async () => {
    expect(await grantCreditsIdempotent("a", 0, "r", "t")).toBeNull();
    await expect(grantCreditsIdempotent("a", -1, "r", "t")).rejects.toThrow();
    await expect(grantCreditsIdempotent("a", 1, "r", " ")).rejects.toThrow(/invalid_tx_id/);
  });
});

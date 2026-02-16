import { QueueEventRecord } from "../common/types.js";
import { CreditEngine } from "./engine.js";

export function reconcileCreditsFromLedger(
  engine: CreditEngine,
  records: QueueEventRecord[]
): { reconciled: number } {
  let reconciled = 0;
  for (const record of records) {
    if (record.eventType === "task_complete") {
      // Minimal reconciliation hook. Real implementation would map execution proofs to reports.
      engine.balance(record.actorId);
      reconciled += 1;
    }
  }
  return { reconciled };
}

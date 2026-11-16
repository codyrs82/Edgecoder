import { AlertManager } from "../../src/alerting/manager.js";
import { MemoryAlertStore, type AlertStore } from "../../src/alerting/store.js";
import type { AlertChannel, AlertNotification } from "../../src/alerting/types.js";

/** A fake clock, a recording channel and a manager on a memory store. */
export function harness(o: { store?: AlertStore; sourceId?: string; renotifyMs?: number; rateLimitMs?: number; startMs?: number; failChannel?: boolean } = {}) {
  const clock = { now: o.startMs ?? Date.UTC(2026, 10, 16, 12, 0, 0) };
  const sent: AlertNotification[] = [];
  const channel: AlertChannel = {
    name: "recorder",
    async send(n) {
      if (o.failChannel) throw new Error("smtp down");
      sent.push(n);
    }
  };
  const store = o.store ?? new MemoryAlertStore();
  const manager = new AlertManager({
    store,
    channels: [channel],
    sourceId: o.sourceId ?? "portal",
    reporter: o.sourceId ?? "portal",
    portalUrl: "https://portal.example.test",
    rateLimitMs: o.rateLimitMs ?? 15 * 60_000,
    renotifyMs: o.renotifyMs ?? 4 * 3_600_000,
    now: () => clock.now
  });
  const advance = (ms: number) => {
    clock.now += ms;
  };
  const kinds = () => sent.map((n) => `${n.kind}:${n.alert.key}`);
  return { clock, sent, store, manager, advance, kinds };
}

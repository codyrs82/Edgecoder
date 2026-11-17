import { AccountSecurity, type AccountSecurityConfig, type AccountSecurityStore } from "../../../src/portal/account-security.js";
import { QueueDataCodec } from "../../../src/db/queue-data-codec.js";

/** portal_onboarding keyed rows in memory, with the same optimistic version check as the SQL. */
export function memoryKeyedRows() {
  const rows = new Map<string, { json: string; version: number }>();
  const store: AccountSecurityStore & { conflicts: number } = {
    conflicts: 0,
    async getKeyedRow(key) {
      const r = rows.get(key);
      return r ? { state: JSON.parse(r.json), version: r.version } : null;
    },
    async compareAndSetKeyedRow(key, expected, state, nowMs) {
      const r = rows.get(key);
      if ((expected === null && r) || (expected !== null && (!r || r.version !== expected))) {
        store.conflicts++;
        return null;
      }
      const version = expected === null ? nowMs : Math.max(nowMs, expected + 1);
      rows.set(key, { json: JSON.stringify(state), version });
      return version;
    },
    async listKeyedRows(prefix) {
      return [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, r]) => ({ key, state: JSON.parse(r.json), version: r.version }));
    }
  };
  return { store, rows };
}

export const HOUR = 60 * 60 * 1000;
export const TEST_2FA_KEY = Buffer.alloc(32, 7);

/** An AccountSecurity on a memory store with a settable clock (defaults: 24 h / 1 h cooling-off, 30 min links, 10 min step-up, 7 day admin grace). */
export function testSecurity(over: Partial<AccountSecurityConfig> = {}) {
  const kv = memoryKeyedRows();
  const clock = { now: Date.UTC(2026, 10, 17, 12, 0, 0) };
  const security = new AccountSecurity({
    store: kv.store,
    codec: new QueueDataCodec([TEST_2FA_KEY]),
    now: () => clock.now,
    cooldownMs: 24 * HOUR,
    firstCooldownMs: 1 * HOUR,
    confirmTtlMs: 30 * 60 * 1000,
    stepUpTtlMs: 10 * 60 * 1000,
    adminGraceMs: 7 * 24 * HOUR,
    ...over
  });
  return { security, kv, clock };
}

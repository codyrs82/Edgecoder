import { describe, expect, it } from "vitest";
import { RETAINED_USER_COLUMNS, USER_DELETE_PLAN, emailHash } from "../../src/portal/account-admin.js";
import { PortalStore } from "../../src/portal/store.js";

/*
 * PortalStore.deleteUserAccount against an in-memory pool that runs the handful of statement
 * shapes the delete uses, and a check that the delete plan covers every user-identifying column
 * PortalStore.migrate() creates (so a table added later cannot be forgotten).
 */

type Row = Record<string, unknown>;
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

function memoryPool(tables: Map<string, Row[]>) {
  const log: string[] = [];
  let snapshot: Map<string, Row[]> | null = null;
  const rows = (t: string) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };
  const remove = (t: string, pred: (r: Row) => boolean) => {
    const before = rows(t);
    const kept = before.filter((r) => !pred(r));
    tables.set(t, kept);
    return { rows: [], rowCount: before.length - kept.length };
  };
  const query = async (raw: string, params: unknown[] = []) => {
    const sql = norm(raw);
    log.push(sql);
    let m: RegExpMatchArray | null;
    if (sql === "BEGIN") {
      snapshot = new Map([...tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") return (snapshot = null), { rows: [], rowCount: 0 };
    if (sql === "ROLLBACK") {
      if (snapshot) for (const [k, v] of snapshot) tables.set(k, v);
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if ((m = sql.match(/^DELETE FROM (\w+) WHERE (\w+) IN \(SELECT (\w+) FROM (\w+) WHERE user_id = \$1\)$/))) {
      const [, t, c, vc, vt] = m;
      const ids = new Set(rows(vt!).filter((r) => r.user_id === params[0]).map((r) => r[vc!]));
      return remove(t!, (r) => ids.has(r[c!]));
    }
    if ((m = sql.match(/^DELETE FROM (\w+) WHERE lower\((\w+)\) = \$1$/))) return remove(m[1]!, (r) => String(r[m![2]!] ?? "").toLowerCase() === params[0]);
    if ((m = sql.match(/^DELETE FROM (\w+) WHERE (\w+) = \$1$/))) return remove(m[1]!, (r) => r[m![2]!] === params[0]);
    if (sql.startsWith("UPDATE portal_api_keys SET revoked_at_ms = $2 WHERE user_id = $1 AND revoked_at_ms IS NULL")) {
      const hit = rows("portal_api_keys").filter((r) => r.user_id === params[0] && r.revoked_at_ms == null);
      for (const r of hit) r.revoked_at_ms = params[1];
      return { rows: [], rowCount: hit.length };
    }
    if (sql.startsWith("SELECT email, role FROM portal_users WHERE user_id = $1")) {
      return { rows: rows("portal_users").filter((r) => r.user_id === params[0]), rowCount: 0 };
    }
    if (sql.startsWith("SELECT COUNT(*) AS n FROM portal_node_enrollments WHERE owner_user_id = $1")) {
      return { rows: [{ n: rows("portal_node_enrollments").filter((r) => r.owner_user_id === params[0]).length }], rowCount: 1 };
    }
    if ((m = sql.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES/))) {
      const cols = m[2]!.split(",").map((c) => c.trim());
      const values = sql.match(/VALUES \(([^)]+)\)/)![1]!.split(",").map((v) => v.trim());
      const row: Row = {};
      cols.forEach((c, i) => (row[c] = values[i]!.startsWith("$") ? params[Number(values[i]!.slice(1)) - 1] : values[i] === "NULL" ? null : values[i]));
      rows(m[1]!).push(row);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`memoryPool: unhandled SQL: ${sql}`);
  };
  return { pool: { query, connect: async () => ({ query, release: () => undefined }) }, log };
}

/** A row in every table the plan touches, for each of two users (plus the given extras for the target). */
function seed(extra: (tables: Map<string, Row[]>) => void = () => undefined) {
  const tables = new Map<string, Row[]>();
  const add = (t: string, r: Row) => (tables.get(t) ?? tables.set(t, []).get(t)!).push(r);
  for (const [uid, email] of [["u-gone", "codyrs82+ecagent3@gmail.com"], ["u-keep", "keep@example.com"]] as const) {
    for (const step of USER_DELETE_PLAN) {
      if (step.table === "portal_users") add("portal_users", { user_id: uid, email, role: "user" });
      else if ("via" in step) {
        if (step.table === "portal_agent_challenges") add(step.table, { public_key: `pk-${uid}` });
        if (step.table === "portal_messages") add(step.table, { conversation_id: `conv-${uid}` });
      } else if (step.table === "portal_agent_identities") add(step.table, { user_id: uid, public_key: `pk-${uid}` });
      else if (step.table === "portal_conversations") add(step.table, { user_id: uid, conversation_id: `conv-${uid}` });
      else if (step.table === "portal_node_enrollments") continue; // a machine would block the delete
      else if (step.by === "email") add(step.table, { [step.column]: email.toUpperCase(), user_id: null });
      else add(step.table, { [step.column]: `${step.keyPrefix ?? ""}${uid}` });
    }
  }
  add("portal_node_enrollments", { owner_user_id: "u-keep", node_id: "n1" });
  extra(tables);
  return tables;
}

const input = (over: Partial<Parameters<PortalStore["deleteUserAccount"]>[0]> = {}) => ({
  userId: "u-gone",
  email: "codyrs82+ecagent3@gmail.com",
  accountKind: "person",
  actorUserId: "u-admin",
  actorEmail: "admin@example.com",
  reason: "abandoned test sign-up",
  force: true,
  balances: { cSats: 0, pendingMsat: 0, complete: true, coordinators: 2 },
  ...over
});

const mentions = (r: Row, uid: string, email: string) =>
  Object.values(r).some((v) => v === uid || v === `pk-${uid}` || v === `acctsec:${uid}` || v === `conv-${uid}` || (typeof v === "string" && v.toLowerCase() === email.toLowerCase()));

describe("PortalStore.deleteUserAccount", () => {
  it("removes the account's rows from every table, leaves other accounts alone, and writes tombstone and audit", async () => {
    const tables = seed((t) => {
      // The real case: 3 sessions, 2 API keys.
      t.get("portal_sessions")!.push({ user_id: "u-gone" }, { user_id: "u-gone" });
      t.get("portal_api_keys")!.push({ user_id: "u-gone", revoked_at_ms: null });
    });
    const { pool, log } = memoryPool(tables);
    const store = new PortalStore(pool as never);
    const r = await store.deleteUserAccount(input());
    expect(r.deleted).toBe(true);
    if (!r.deleted) return;

    for (const [table, rows] of tables) {
      if (table === "portal_deleted_accounts" || table === "portal_admin_audit") continue;
      expect(rows.filter((row) => mentions(row, "u-gone", "codyrs82+ecagent3@gmail.com")), table).toEqual([]);
    }
    // The other account keeps a row in every table.
    for (const step of USER_DELETE_PLAN) if (step.table !== "portal_node_enrollments") expect(tables.get(step.table)!.some((row) => mentions(row, "u-keep", "keep@example.com")), step.table).toBe(true);

    expect(r.counts.portal_sessions).toBe(3);
    expect(r.counts.portal_api_keys).toBe(2);
    expect(r.counts.portal_users).toBe(1);
    expect(r.counts.portal_messages).toBe(1);
    expect(r.counts.portal_agent_challenges).toBe(1);
    expect(r.counts.portal_passkey_challenges).toBe(2); // one by user id, one by email
    // Hosting by request is keyed by email (matched case-insensitively); the approval goes with the account.
    expect(r.counts.portal_host_requests).toBe(1);
    expect(r.counts.portal_host_approvals).toBe(1);

    // Access is cut before the transaction starts.
    const begin = log.indexOf("BEGIN");
    expect(log.findIndex((s) => s.startsWith("DELETE FROM portal_sessions"))).toBeLessThan(begin);
    expect(log.findIndex((s) => s.startsWith("UPDATE portal_api_keys"))).toBeLessThan(begin);
    expect(log.at(-1)).toBe("COMMIT");

    const [tomb] = tables.get("portal_deleted_accounts")!;
    expect(tomb).toMatchObject({ user_id: "u-gone", email_hash: emailHash("CodyRS82+ecagent3@gmail.com"), deleted_by: "u-admin" });
    expect(JSON.stringify(tomb)).not.toContain("ecagent3@");
    const [audit] = tables.get("portal_admin_audit")!;
    expect(audit).toMatchObject({ action: "account.delete", actor_user_id: "u-admin", target_user_id: "u-gone", target_email_hint: "co…@gmail.com" });
    const detail = JSON.parse(String(audit!.detail));
    expect(detail.counts).toEqual(r.counts);
    expect(detail.apiKeysRevoked).toBe(2);
    expect(detail.force).toBe(true);
  });

  it("rolls back when a machine is enrolled by the time the row is locked", async () => {
    const tables = seed((t) => t.get("portal_node_enrollments")!.push({ owner_user_id: "u-gone", node_id: "late" }));
    const store = new PortalStore(memoryPool(tables).pool as never);
    const r = await store.deleteUserAccount(input());
    expect(r).toMatchObject({ deleted: false, error: "has_machines" });
    expect(tables.get("portal_users")!.some((u) => u.user_id === "u-gone")).toBe(true);
    expect(tables.get("portal_admin_audit") ?? []).toEqual([]);
  });

  it("refuses an admin inside the transaction", async () => {
    const tables = seed((t) => (t.get("portal_users")!.find((u) => u.user_id === "u-gone")!.role = "admin"));
    const r = await new PortalStore(memoryPool(tables).pool as never).deleteUserAccount(input());
    expect(r).toMatchObject({ deleted: false, error: "cannot_delete_admin" });
    expect(tables.get("portal_users")!.length).toBe(2);
  });
});

/** Every column created by migrate(), by table, from the SQL it runs. */
async function migratedColumns(): Promise<Map<string, Set<string>>> {
  const statements: string[] = [];
  const query = async (sql: string) => (statements.push(sql), { rows: [], rowCount: 0 });
  await new PortalStore({ query, connect: async () => ({ query, release: () => undefined }) } as never).migrate();
  const tables = new Map<string, Set<string>>();
  const text = statements.join(";\n");
  for (const m of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)) {
    // The column list: up to the parenthesis that closes the one after the table name.
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; depth > 0; i++) depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
    const body = text.slice(start, i - 1);
    const parts: string[] = [];
    let d = 0;
    let cur = "";
    for (const ch of body) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) (parts.push(cur), (cur = ""));
      else cur += ch;
    }
    parts.push(cur);
    const cols = tables.get(m[1]!) ?? new Set<string>();
    for (const p of parts) {
      const name = p.trim().split(/\s+/)[0]!;
      if (name && !/^(PRIMARY|UNIQUE|CHECK|CONSTRAINT|FOREIGN)$/i.test(name)) cols.add(name);
    }
    tables.set(m[1]!, cols);
  }
  for (const m of text.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)) tables.get(m[1]!)?.add(m[2]!);
  return tables;
}

// Columns that identify an account. A table added later (e.g. #306's security-research
// entitlements) with such a column fails the test below until it is in the plan or retained.
const USER_COLUMN = /(^|_)user_id$|(^|_)email$|email_snapshot|email_hash|email_hint|^account_id$|_by$/;

describe("the delete plan covers the schema", () => {
  it("every user, email or account column created by migrate() is deleted on, or retained with a reason", async () => {
    const tables = await migratedColumns();
    expect(tables.size).toBeGreaterThan(20);
    const planned = new Set(USER_DELETE_PLAN.map((s) => `${s.table}.${s.column}`));
    const missing: string[] = [];
    for (const [table, cols] of tables) {
      for (const col of cols) {
        if (!USER_COLUMN.test(col)) continue;
        const key = `${table}.${col}`;
        if (!planned.has(key) && !RETAINED_USER_COLUMNS[key]) missing.push(key);
      }
    }
    expect(missing, "add these to USER_DELETE_PLAN or RETAINED_USER_COLUMNS in src/portal/account-admin.ts").toEqual([]);
  });

  it("names only tables and columns that exist", async () => {
    const tables = await migratedColumns();
    for (const s of USER_DELETE_PLAN) {
      expect(tables.get(s.table)?.has(s.column), `${s.table}.${s.column}`).toBe(true);
      if ("via" in s) expect(tables.get(s.via.table)?.has(s.via.column), `${s.via.table}.${s.via.column}`).toBe(true);
    }
    for (const key of Object.keys(RETAINED_USER_COLUMNS)) {
      const [t, c] = key.split(".");
      expect(tables.get(t!)?.has(c!), key).toBe(true);
    }
  });

  it("deletes portal_users last", () => {
    expect(USER_DELETE_PLAN.at(-1)).toEqual({ table: "portal_users", column: "user_id", by: "userId" });
  });
});

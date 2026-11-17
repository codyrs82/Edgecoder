import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import * as ops from "../../scripts/ops/accounts.mjs";

const {
  assertSelectOnly, PORTAL_QUERIES, LEDGER_QUERIES, parseArgs, applyFilters, matchesFilter, mergeAccounts,
  formatAccount, formatReport, redact, buildRemoteProgram, flyArgs, parseRemoteOutput, collect, utcDayStartMs
} = ops as any;

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

describe("assertSelectOnly", () => {
  it("accepts every built-in query", () => {
    for (const sql of [...Object.values(PORTAL_QUERIES), ...Object.values(LEDGER_QUERIES)]) expect(assertSelectOnly(sql)).toBe(true);
    expect(assertSelectOnly("WITH x AS (SELECT 1 AS n) SELECT n FROM x;")).toBe(true);
    expect(assertSelectOnly("SELECT updated_at_ms, created_at_ms, revoked_at_ms FROM t WHERE s = 'DELETE me'")).toBe(true);
  });

  it.each([
    ["INSERT INTO t VALUES (1)", /SELECT/],
    ["UPDATE portal_users SET role = 'admin'", /SELECT/],
    ["DELETE FROM credit_transactions", /SELECT/],
    ["DROP TABLE portal_users", /SELECT/],
    ["CREATE TABLE x (a int)", /SELECT/],
    ["ALTER TABLE portal_users ADD COLUMN x int", /SELECT/],
    ["TRUNCATE credit_transactions", /SELECT/],
    ["GRANT ALL ON portal_users TO public", /SELECT/],
    ["SELECT 1; DELETE FROM portal_users", /one statement/],
    ["SELECT 1; SELECT 2", /one statement/],
    ["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", /DELETE/],
    ["WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u", /UPDATE/],
    ["SELECT * INTO backup FROM portal_users", /INTO/],
    ["SELECT * FROM portal_users FOR UPDATE", /UPDATE|lock/],
    ["SELECT * FROM portal_users FOR SHARE", /lock/],
    ["SELECT pg_sleep(10)", /pg_sleep/],
    ["SELECT set_config('default_transaction_read_only', 'off', false)", /set_config|SET/],
    ["SELECT nextval('s')", /nextval/],
    ["SELECT 1 /* ; */ ; DROP TABLE t", /one statement/],
    ["SELECT $$ ; DROP TABLE t $$", /dollar/],
    ["SELECT E'\\'; DROP TABLE t; --'", /backslash/],
    ["", /empty/],
    ["COPY portal_users TO '/tmp/x'", /SELECT/],
    ["EXPLAIN ANALYZE DELETE FROM t", /SELECT/]
  ])("rejects %s", (sql, why) => {
    expect(() => assertSelectOnly(sql)).toThrow(why);
  });

  it("refuses to build a remote program around a write", () => {
    expect(() => buildRemoteProgram({ dbEnv: "DATABASE_URL", queries: { x: { sql: "DELETE FROM t" } } })).toThrow(/sql_guard/);
  });

  it("ships the guard inside the remote program, read-only connection, GET only", () => {
    const prog = buildRemoteProgram({ dbEnv: "DATABASE_URL", queries: { x: { sql: "SELECT 1" } }, adminNetwork: true });
    expect(prog).toContain("const assertSelectOnly =");
    expect(prog).toContain("default_transaction_read_only=on");
    expect(prog).toContain('method: "GET"');
    expect(() => new Function("require", prog)).not.toThrow();
  });
});

describe("parseArgs", () => {
  it("parses a filter and flags", () => {
    expect(parseArgs([])).toEqual({ filter: null, online: false, withMachines: false, json: false, help: false });
    expect(parseArgs(["proton", "--online", "--with-machines", "--json"])).toEqual({ filter: "proton", online: true, withMachines: true, json: true, help: false });
    expect(parseArgs(["--help"]).help).toBe(true);
  });
  it("rejects unknown options and a second filter", () => {
    expect(() => parseArgs(["--write"])).toThrow(/unknown option/);
    expect(() => parseArgs(["a", "b"])).toThrow(/only one filter/);
  });
});

const portal = {
  queries: {
    users: [
      { user_id: "5f7e7900-aaaa", email: "owner@proton.me", display_name: "Owner", role: "user", account_kind: "person", email_verified: true, created_at_ms: NOW - 86_400_000 },
      { user_id: "d55e828c-bbbb", email: "admin@example.com", display_name: null, role: "admin", account_kind: "person", email_verified: true, created_at_ms: NOW - 2 * 86_400_000 },
      { user_id: "11111111-cccc", email: "cody+st1@example.com", display_name: "EC st1", role: "user", account_kind: "person", email_verified: false, created_at_ms: NOW - 3 * 86_400_000 }
    ],
    lastSignIn: [{ user_id: "5f7e7900-aaaa", last_ms: String(NOW - 3_600_000) }],
    hostApprovals: [{ email: "owner@proton.me", approved_at_ms: NOW, source: "admin" }],
    enrollments: [
      { node_id: "lambda-a100-gpu0", node_kind: "agent", owner_user_id: "5f7e7900-aaaa", node_approved: true, active: true, last_seen_ms: NOW - 5_000 },
      { node_id: "st1-old", node_kind: "agent", owner_user_id: "11111111-cccc", node_approved: false, active: false, last_seen_ms: NOW - 86_400_000 }
    ],
    apiKeys: [{ user_id: "11111111-cccc", active: "2", total: "3" }],
    payoutSet: [{ user_id: "11111111-cccc" }]
  },
  env: { SYSTEM_ADMIN_EMAILS: "admin@example.com", HOST_APPROVED_EMAILS: "" }
};
const ledger = {
  queries: {
    balances: [{ account_id: "acct-d55e828c-bbbb", balance: 5000, spent_today: 12.5 }],
    creditAccounts: [{ account_id: "acct-d55e828c-bbbb", owner_user_id: "d55e828c-bbbb" }],
    ownership: [{ agent_id: "lambda-a100-gpu0", account_id: "acct-5f7e7900-aaaa", machine_label: "A100" }],
    registry: [{ agent_id: "st1-old", os: "linux", version: "1.0", mode: "swarm-only", last_seen_ms: NOW - 86_400_000, active_model: "qwen2.5-coder:1.5b" }],
    projection: []
  }
};
const networks = [
  { app: "edgecoder-seed", network: { agents: [{ agentId: "lambda-a100-gpu0", accountId: "acct-5f7e7900-aaaa", connected: true, lastSeenMs: NOW - 1_000, computeClass: "gpu.dc", tier: "gpu.dc40", engine: "vllm", hostApproved: true, modelsInstalled: ["qwen3-coder:30b"], status: "idle" }] } },
  { app: "edgecoder-seed-eu", network: { agents: [{ agentId: "lambda-a100-gpu0", accountId: "acct-5f7e7900-aaaa", connected: false, lastSeenMs: NOW - 600_000, computeClass: "gpu.dc", engine: "vllm", modelsInstalled: [] }] } }
];

describe("mergeAccounts", () => {
  const accounts = mergeAccounts({ portal, ledger, networks }, NOW);
  const byEmail = (e: string) => accounts.find((a: any) => a.email === e);

  it("joins roles, host approval, balance, keys and payout state", () => {
    const admin = byEmail("admin@example.com");
    expect(admin.roles).toEqual(["admin", "system admin"]);
    expect(admin.hostApproved).toBe(true);
    expect(admin.balanceCSats).toBe(5000);
    expect(admin.spentTodayCSats).toBe(12.5);
    const st1 = byEmail("cody+st1@example.com");
    expect(st1.apiKeys).toEqual({ active: 2, total: 3 });
    expect(st1.payoutDestination).toBe("set");
    expect(st1.hostApproved).toBe(false);
  });

  it("builds machines from ownership, enrollments and the live coordinator view", () => {
    const owner = byEmail("owner@proton.me");
    expect(owner.lastSignInMs).toBe(NOW - 3_600_000);
    expect(owner.machines).toHaveLength(1);
    const m = owner.machines[0];
    expect(m).toMatchObject({ agentId: "lambda-a100-gpu0", online: true, computeClass: "gpu.dc", engine: "vllm", approvedNode: true, hostRole: "serves network", coordinator: "edgecoder-seed", label: "A100" });
    const old = byEmail("cody+st1@example.com").machines[0];
    expect(old).toMatchObject({ agentId: "st1-old", online: false, approvedNode: false, hostRole: "own work only", models: ["qwen2.5-coder:1.5b"], coordinator: null });
  });
});

describe("filters", () => {
  const accounts = mergeAccounts({ portal, ledger, networks }, NOW);
  it("matches email substrings and account ids", () => {
    expect(applyFilters(accounts, parseArgs(["PROTON"])).map((a: any) => a.email)).toEqual(["owner@proton.me"]);
    expect(applyFilters(accounts, parseArgs(["d55e828c"])).map((a: any) => a.email)).toEqual(["admin@example.com"]);
    expect(applyFilters(accounts, parseArgs(["acct-11111111-cccc"])).map((a: any) => a.email)).toEqual(["cody+st1@example.com"]);
    expect(matchesFilter(accounts[0], "zz-nothing")).toBe(false);
  });
  it("--online and --with-machines", () => {
    expect(applyFilters(accounts, parseArgs(["--online"])).map((a: any) => a.email)).toEqual(["owner@proton.me"]);
    expect(applyFilters(accounts, parseArgs(["--with-machines"])).map((a: any) => a.email).sort()).toEqual(["cody+st1@example.com", "owner@proton.me"]);
  });
});

describe("output", () => {
  const accounts = mergeAccounts({ portal, ledger, networks }, NOW);
  it("formats one block per account", () => {
    const text = formatAccount(accounts.find((a: any) => a.email === "owner@proton.me"), NOW);
    expect(text).toContain("5f7e7900  owner@proton.me");
    expect(text).toContain("host-approved yes (admin)");
    expect(text).toContain("machines (1, 1 online):");
    expect(text).toMatch(/lambda-a100-gpu0\s+online 1s ago\s+gpu\.dc\/gpu\.dc40\s+vllm\s+qwen3-coder:30b\s+yes\s+serves network\s+edgecoder-seed/);
    const report = formatReport(accounts, { warnings: ["x down"], timings: { portal: 1800 } }, NOW);
    expect(report).toMatch(/^3 accounts, 2 machines \(1 online\)/);
    expect(report).toContain("warning: x down");
    expect(report).toContain("balance 5,000 cSats | spent today 12.5");
  });
  it("redacts secret-looking fields but keeps payout set/not set", () => {
    const r = redact({ email: "a@b", token_hash: "x", password_hash: "y", nested: [{ apiKeyValue: "k", registration_token_hash: "z", ok: 1 }], payoutDestination: "set", destination: "lnbc1..." });
    expect(r).toEqual({ email: "a@b", nested: [{ ok: 1 }], payoutDestination: "set" });
  });
});

describe("remote calls (mocked)", () => {
  it("runs the portal and every coordinator in parallel and merges", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      const app = args[args.indexOf("-a") + 1];
      const b64 = args[args.length - 1].match(/from\('([^']+)'/)![1];
      const job = Buffer.from(b64, "base64").toString();
      expect(job).toContain("assertSelectOnly");
      const body = app === "edgecoder-portal" ? { ...portal, errors: {} } : app === "edgecoder-seed" ? { ...ledger, errors: {}, network: networks[0].network } : { queries: {}, errors: {}, network: networks[1].network };
      return `noise\n__OPS_ACCOUNTS_JSON__${JSON.stringify(body)}\n`;
    };
    const { accounts, warnings } = await collect({ exec, nowMs: NOW });
    expect(warnings).toEqual([]);
    expect(calls.map((c) => c[c.indexOf("-a") + 1]).sort()).toEqual(["edgecoder-portal", "edgecoder-seed", "edgecoder-seed-eu"]);
    expect(accounts.find((a: any) => a.email === "owner@proton.me").machines[0].coordinator).toBe("edgecoder-seed");
  });
  it("reports a failed source as a warning instead of failing", async () => {
    const exec = async (args: string[]) => {
      if (args.includes("edgecoder-seed-eu")) throw new Error("ssh: connection refused");
      return `__OPS_ACCOUNTS_JSON__${JSON.stringify({ queries: {}, errors: {} })}`;
    };
    const { warnings } = await collect({ exec, nowMs: NOW });
    expect(warnings.join("\n")).toContain("edgecoder-seed-eu: ssh: connection refused");
  });
  it("parses only the marked line and uses fly ssh console", () => {
    expect(() => parseRemoteOutput("nothing")).toThrow(/no result/);
    expect(() => parseRemoteOutput('__OPS_ACCOUNTS_JSON__{"fatal":"boom"}')).toThrow(/boom/);
    expect(flyArgs("edgecoder-portal", "1").slice(0, 5)).toEqual(["ssh", "console", "-a", "edgecoder-portal", "-q"]);
    expect(utcDayStartMs(NOW)).toBe(Date.UTC(2026, 10, 17));
  });
});

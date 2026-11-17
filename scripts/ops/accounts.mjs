#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// Accounts and machines at a glance (read-only owner tool).
//
//   npm run ops:accounts -- [filter] [--online] [--with-machines] [--json]
//
// filter: an email substring, or an account id (portal user id, its short form, or acct-<userId>).
//
// Nothing secret comes to this Mac. Each query runs inside a production machine with that machine's
// own environment (`fly ssh console -a <app> -C "node -e …"`), and only the result JSON comes back:
//   - edgecoder-portal: portal_users, portal_sessions, portal_host_approvals, portal_node_enrollments,
//     portal_api_keys, portal_payout_destinations (PORTAL_DATABASE_URL)
//   - edgecoder-seed: credit_transactions, credit_accounts, agent_ownership, agent_registry,
//     node_status_projection on edgecoder_seed (DATABASE_URL), plus GET /admin/network
//   - every other coordinator app: GET /admin/network only (live agents are in memory per coordinator)
//
// Read-only: every SQL statement must pass assertSelectOnly (here and again on the machine), and the
// connection runs with default_transaction_read_only=on. The only HTTP call is GET /admin/network.
// Columns that hold tokens, hashes, keys or payout destinations are never selected.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PORTAL_APP = process.env.OPS_PORTAL_APP || "edgecoder-portal";
export const LEDGER_APP = process.env.OPS_LEDGER_APP || "edgecoder-seed";
export const COORDINATOR_APPS = (process.env.OPS_COORDINATOR_APPS || "edgecoder-seed,edgecoder-seed-eu")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Agents seen this recently count as online (the coordinator's AGENT_CONNECTED_WINDOW_MS). */
export const ONLINE_WINDOW_MS = 2 * 60_000;
const FLY = process.env.FLY_BIN || "fly";
const MARKER = "__OPS_ACCOUNTS_JSON__";

// ---------------------------------------------------------------------------------------------
// SQL guard

const FORBIDDEN_WORDS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE",
  "COPY", "CALL", "DO", "EXECUTE", "PREPARE", "DEALLOCATE", "VACUUM", "ANALYZE", "REINDEX", "CLUSTER", "LOCK",
  "SET", "RESET", "NOTIFY", "LISTEN", "UNLISTEN", "COMMENT", "SECURITY", "REFRESH", "IMPORT", "LOAD", "DISCARD",
  "BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "ABORT", "INTO", "CHECKPOINT", "REASSIGN"
];
/** Functions with side effects (or that sleep or reach other servers), refused even inside a SELECT. */
const FORBIDDEN_FUNCTIONS = /\b(pg_sleep\w*|set_config|nextval|setval|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_advisory\w*|pg_notify|pg_read_\w+|pg_write_\w+|pg_ls_\w+|txid_current|pg_switch_wal|pg_create_\w+|pg_drop_\w+|query_to_xml\w*|xpath)\s*\(/i;

/**
 * Throws unless `sql` is one SELECT (or WITH … SELECT) statement with no writes, locks or
 * side-effecting functions. Comments and string literals are stripped before the check; dollar
 * quoting and backslashes are refused outright (they could hide text from this check).
 */
export function assertSelectOnly(sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new Error("sql_guard: empty statement");
  if (sql.includes("$$") || /\$[A-Za-z_]\w*\$/.test(sql)) throw new Error("sql_guard: dollar quoting is not allowed");
  if (sql.includes("\\")) throw new Error("sql_guard: backslashes are not allowed");
  let s = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  if (s.includes("/*") || s.includes("*/")) throw new Error("sql_guard: unbalanced comment");
  s = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '"x"');
  if (s.includes("'") && /'[^']*$/.test(s.replace(/''/g, ""))) throw new Error("sql_guard: unbalanced string literal");
  s = s.trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new Error("sql_guard: only one statement is allowed");
  if (!/^(SELECT|WITH)\b/i.test(s)) throw new Error("sql_guard: only SELECT statements are allowed");
  for (const w of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${w}\\b`, "i").test(s)) throw new Error(`sql_guard: ${w} is not allowed`);
  }
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY|KEY)\b/i.test(s)) throw new Error("sql_guard: row locks are not allowed");
  const fn = s.match(FORBIDDEN_FUNCTIONS);
  if (fn) throw new Error(`sql_guard: ${fn[1]}() is not allowed`);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Queries (only non-secret columns)

export const PORTAL_QUERIES = {
  users: `SELECT user_id, email, display_name, role, account_kind, email_verified, created_at_ms FROM portal_users`,
  lastSignIn: `SELECT user_id, MAX(created_at_ms) AS last_ms FROM portal_sessions GROUP BY user_id`,
  hostApprovals: `SELECT lower(email) AS email, approved_at_ms, source FROM portal_host_approvals`,
  enrollments: `SELECT node_id, node_kind, owner_user_id, node_approved, active, last_seen_ms, last_country_code FROM portal_node_enrollments`,
  apiKeys: `SELECT user_id, COUNT(*) FILTER (WHERE revoked_at_ms IS NULL) AS active, COUNT(*) AS total FROM portal_api_keys GROUP BY user_id`,
  payoutSet: `SELECT user_id FROM portal_payout_destinations`
};

/** $1 = start of today (UTC) in ms. */
export const LEDGER_QUERIES = {
  balances: `SELECT account_id,
      SUM(CASE WHEN tx_type = 'spend' THEN -credits ELSE credits END)::float8 AS balance,
      SUM(CASE WHEN tx_type = 'spend' AND timestamp_ms >= $1 THEN credits ELSE 0 END)::float8 AS spent_today
    FROM credit_transactions WHERE account_id LIKE 'acct-%' GROUP BY account_id`,
  creditAccounts: `SELECT account_id, owner_user_id, created_at_ms FROM credit_accounts`,
  ownership: `SELECT agent_id, account_id, machine_label FROM agent_ownership`,
  registry: `SELECT agent_id, os, version, mode, last_seen_ms, active_model FROM agent_registry`,
  projection: `SELECT node_id, node_kind, node_approved, active, last_seen_ms, country_code FROM node_status_projection`
};

export function utcDayStartMs(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------------------------------------------------------------------------------------------
// Remote program: runs on the machine with its own env; prints MARKER + JSON on one line.

/**
 * Builds the Node program shipped to a machine. `job` = { dbEnv?, queries?: {name: {sql, params}},
 * adminNetwork?: boolean, env?: string[] (names of non-secret env vars to read, e.g. email lists) }.
 */
export function buildRemoteProgram(job) {
  for (const q of Object.values(job.queries ?? {})) assertSelectOnly(q.sql);
  const body = `
const assertSelectOnly = ${assertSelectOnly.toString()};
const FORBIDDEN_WORDS = ${JSON.stringify(FORBIDDEN_WORDS)};
const FORBIDDEN_FUNCTIONS = ${FORBIDDEN_FUNCTIONS.toString()};
const job = ${JSON.stringify(job)};
const out = { queries: {}, errors: {}, env: {}, network: null };
(async () => {
  for (const name of job.env || []) out.env[name] = process.env[name] || "";
  const tasks = [];
  if (job.dbEnv && job.queries) {
    tasks.push((async () => {
      const pg = require("/app/node_modules/pg");
      const url = process.env[job.dbEnv];
      if (!url) { out.errors.db = job.dbEnv + " not set"; return; }
      const pool = new pg.Pool({ connectionString: url, max: 4, options: "-c default_transaction_read_only=on -c statement_timeout=15000" });
      try {
        await Promise.all(Object.entries(job.queries).map(async ([name, q]) => {
          try { assertSelectOnly(q.sql); out.queries[name] = (await pool.query(q.sql, q.params || [])).rows; }
          catch (e) { out.errors[name] = String(e && e.message || e).slice(0, 200); }
        }));
      } finally { await pool.end().catch(() => {}); }
    })());
  }
  if (job.adminNetwork) {
    tasks.push((async () => {
      const token = process.env.ADMIN_API_TOKEN;
      if (!token) { out.errors.network = "ADMIN_API_TOKEN not set"; return; }
      try {
        const res = await fetch("http://127.0.0.1:" + (process.env.PORT || 4301) + "/admin/network?range=1h", { method: "GET", headers: { "x-admin-token": token }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) { out.errors.network = "GET /admin/network " + res.status; return; }
        const j = await res.json();
        const keep = ["agentId","accountId","ownerEmail","os","clientType","version","mode","provider","engine","hostApproved","region","computeClass","tier","claimedTier","verification","modelsInstalled","activeModel","lastSeenMs","connected","status","blacklisted"];
        out.network = { region: process.env.FLY_REGION || null, agents: (j.agents || []).map((a) => Object.fromEntries(keep.map((k) => [k, a[k] === undefined ? null : a[k]]))) };
      } catch (e) { out.errors.network = String(e && e.message || e).slice(0, 200); }
    })());
  }
  await Promise.all(tasks);
  process.stdout.write(${JSON.stringify(MARKER)} + JSON.stringify(out) + "\\n");
})().catch((e) => { process.stdout.write(${JSON.stringify(MARKER)} + JSON.stringify({ fatal: String(e && e.message || e) }) + "\\n"); });
`;
  return body;
}

/** The fly argv that runs `program` inside `app` (base64 keeps the shell out of the program text). */
export function flyArgs(app, program, machine) {
  const b64 = Buffer.from(program, "utf8").toString("base64");
  return ["ssh", "console", "-a", app, "-q", ...(machine ? ["--machine", machine] : []), "-C", `node -e "eval(Buffer.from('${b64}','base64').toString())"`];
}

export function parseRemoteOutput(stdout) {
  const line = String(stdout).split("\n").find((l) => l.startsWith(MARKER));
  if (!line) throw new Error("no result from the machine");
  const j = JSON.parse(line.slice(MARKER.length));
  if (j.fatal) throw new Error(j.fatal);
  return j;
}

/** Runs one job on one app. `exec` is injectable for tests. */
export async function runRemote(app, job, exec = execFlyDefault) {
  const started = Date.now();
  const stdout = await exec(flyArgs(app, buildRemoteProgram(job)));
  return { app, ms: Date.now() - started, ...parseRemoteOutput(stdout) };
}

function execFlyDefault(args) {
  return new Promise((resolveP, reject) => {
    execFile(FLY, args, { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${FLY} ${args.slice(0, 4).join(" ")} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolveP(stdout);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Arguments

export function parseArgs(argv) {
  const opts = { filter: null, online: false, withMachines: false, json: false, help: false };
  for (const a of argv) {
    if (a === "--online") opts.online = true;
    else if (a === "--with-machines") opts.withMachines = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (opts.filter !== null) throw new Error("only one filter (email substring or account id) is allowed");
    else opts.filter = a.trim();
  }
  if (opts.filter === "") opts.filter = null;
  return opts;
}

export const USAGE = `usage: npm run ops:accounts -- [filter] [--online] [--with-machines] [--json]
  filter            email substring, or account id (user id, its first 8 chars, or acct-<userId>)
  --online          only accounts with a machine online now, and only their online machines
  --with-machines   only accounts that have at least one machine
  --json            machine-readable output`;

// ---------------------------------------------------------------------------------------------
// Merge

const lc = (s) => String(s ?? "").toLowerCase();
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const emailList = (s) => String(s ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

/**
 * Joins the portal, ledger and coordinator results into one record per account.
 * portal/ledger: { queries, env } as returned by the machines; networks: [{ app, network }].
 */
export function mergeAccounts({ portal, ledger, networks = [] }, nowMs = Date.now()) {
  const q = portal?.queries ?? {};
  const l = ledger?.queries ?? {};
  const sysAdmins = new Set(emailList(portal?.env?.SYSTEM_ADMIN_EMAILS));
  const hostAllow = new Set([...sysAdmins, ...emailList(portal?.env?.HOST_APPROVED_EMAILS)]);
  const approvals = new Map((q.hostApprovals ?? []).map((r) => [lc(r.email), r]));
  const lastSignIn = new Map((q.lastSignIn ?? []).map((r) => [r.user_id, num(r.last_ms)]));
  const apiKeys = new Map((q.apiKeys ?? []).map((r) => [r.user_id, { active: num(r.active) ?? 0, total: num(r.total) ?? 0 }]));
  const payoutSet = new Set((q.payoutSet ?? []).map((r) => r.user_id));
  const enrollByNode = new Map((q.enrollments ?? []).map((r) => [r.node_id, r]));
  const balances = new Map((l.balances ?? []).map((r) => [r.account_id, r]));
  const creditAccounts = new Set((l.creditAccounts ?? []).map((r) => r.account_id));
  const ownership = new Map((l.ownership ?? []).map((r) => [r.agent_id, r]));
  const registry = new Map((l.registry ?? []).map((r) => [r.agent_id, r]));
  const projection = new Map((l.projection ?? []).map((r) => [r.node_id, r]));
  // Live view per agent: the coordinator that saw it last (connected first).
  const live = new Map();
  for (const { app, network } of networks) {
    for (const a of network?.agents ?? []) {
      const entry = { ...a, coordinator: app };
      const prev = live.get(a.agentId);
      if (!prev || (entry.connected && !prev.connected) || (entry.connected === prev.connected && (entry.lastSeenMs ?? 0) > (prev.lastSeenMs ?? 0))) live.set(a.agentId, entry);
    }
  }

  const machinesByAccount = new Map();
  const add = (accountId, agentId) => {
    if (!accountId || !agentId) return;
    if (!machinesByAccount.has(accountId)) machinesByAccount.set(accountId, new Set());
    machinesByAccount.get(accountId).add(agentId);
  };
  for (const [agentId, o] of ownership) add(o.account_id, agentId);
  for (const [nodeId, e] of enrollByNode) add(`acct-${e.owner_user_id}`, nodeId);
  for (const [agentId, a] of live) if (a.accountId) add(a.accountId, agentId);

  const machine = (agentId, hostApproved) => {
    const lv = live.get(agentId);
    const reg = registry.get(agentId);
    const en = enrollByNode.get(agentId);
    const pr = projection.get(agentId);
    const lastSeenMs = Math.max(num(lv?.lastSeenMs) ?? 0, num(reg?.last_seen_ms) ?? 0, num(en?.last_seen_ms) ?? 0, num(pr?.last_seen_ms) ?? 0) || null;
    const online = Boolean(lv?.connected) || (lastSeenMs !== null && nowMs - lastSeenMs < ONLINE_WINDOW_MS);
    const models = lv?.modelsInstalled?.length ? lv.modelsInstalled : reg?.active_model ? [reg.active_model] : [];
    // The coordinator's own view wins (it applies hostApproved to dispatch); otherwise the portal's.
    const serves = lv && lv.hostApproved !== null && lv.hostApproved !== undefined ? lv.hostApproved : hostApproved;
    return {
      agentId,
      label: ownership.get(agentId)?.machine_label ?? null,
      kind: en?.node_kind ?? pr?.node_kind ?? null,
      os: lv?.os ?? reg?.os ?? null,
      version: lv?.version ?? reg?.version ?? null,
      online,
      status: lv?.status ?? (online ? "online" : "offline"),
      lastSeenMs,
      computeClass: lv?.computeClass ?? null,
      tier: lv?.tier ?? lv?.claimedTier ?? null,
      models,
      activeModel: lv?.activeModel ?? reg?.active_model ?? null,
      engine: lv?.engine ?? (lv ? "?" : null),
      approvedNode: en ? Boolean(en.node_approved) : pr ? Boolean(pr.node_approved) : null,
      hostRole: serves ? "serves network" : "own work only",
      coordinator: lv?.coordinator ?? null,
      blacklisted: Boolean(lv?.blacklisted)
    };
  };

  const accounts = [];
  const seen = new Set();
  for (const u of q.users ?? []) {
    const accountId = `acct-${u.user_id}`;
    seen.add(accountId);
    const email = lc(u.email);
    const hostApproved = approvals.has(email) || hostAllow.has(email);
    const bal = balances.get(accountId);
    const roles = [];
    if (u.role === "admin") roles.push("admin");
    if (sysAdmins.has(email)) roles.push("system admin");
    if (u.account_kind && u.account_kind !== "person") roles.push(u.account_kind);
    const machines = [...(machinesByAccount.get(accountId) ?? [])].map((id) => machine(id, hostApproved));
    machines.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0));
    accounts.push({
      userId: u.user_id,
      accountId,
      email: u.email,
      displayName: u.display_name ?? null,
      roles,
      hostApproved,
      hostApprovalSource: approvals.get(email)?.source ?? (hostAllow.has(email) ? "env allowlist" : null),
      emailVerified: Boolean(u.email_verified),
      createdAtMs: num(u.created_at_ms),
      lastSignInMs: lastSignIn.get(u.user_id) ?? null,
      creditAccount: creditAccounts.has(accountId),
      balanceCSats: bal ? Number(bal.balance) : 0,
      spentTodayCSats: bal ? Number(bal.spent_today) : 0,
      apiKeys: apiKeys.get(u.user_id) ?? { active: 0, total: 0 },
      bots: null,
      payoutDestination: payoutSet.has(u.user_id) ? "set" : "not set",
      machines
    });
  }
  // Machines whose account has no portal user (deleted accounts, ledger-only ids).
  for (const [accountId, ids] of machinesByAccount) {
    if (seen.has(accountId)) continue;
    const bal = balances.get(accountId);
    accounts.push({
      userId: accountId.replace(/^acct-/, ""), accountId, email: null, displayName: null, roles: ["no portal user"], hostApproved: false,
      hostApprovalSource: null, emailVerified: false, createdAtMs: null, lastSignInMs: null, creditAccount: creditAccounts.has(accountId),
      balanceCSats: bal ? Number(bal.balance) : 0, spentTodayCSats: bal ? Number(bal.spent_today) : 0, apiKeys: { active: 0, total: 0 },
      bots: null, payoutDestination: "not set", machines: [...ids].map((id) => machine(id, false))
    });
  }
  accounts.sort((a, b) => (b.lastSignInMs ?? b.createdAtMs ?? 0) - (a.lastSignInMs ?? a.createdAtMs ?? 0));
  return accounts;
}

// ---------------------------------------------------------------------------------------------
// Filters

export function matchesFilter(account, filter) {
  if (!filter) return true;
  const f = filter.toLowerCase();
  const uid = lc(account.userId);
  if (f === lc(account.accountId) || f === uid || (f.length >= 6 && (uid.startsWith(f) || lc(account.accountId).startsWith(f)))) return true;
  return lc(account.email).includes(f) || lc(account.displayName).includes(f);
}

export function applyFilters(accounts, opts) {
  let out = accounts.filter((a) => matchesFilter(a, opts.filter));
  if (opts.online) out = out.map((a) => ({ ...a, machines: a.machines.filter((m) => m.online) })).filter((a) => a.machines.length > 0);
  if (opts.withMachines) out = out.filter((a) => a.machines.length > 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Output

/** Keys that must never be printed, whatever a machine returns. */
const SECRET_KEY = /token|hash|secret|password|passwd|private|pem|seed_phrase|api_?key_?value|destination|mnemonic|macaroon|^key$/i;

/** Drops secret-looking fields (payoutDestination is "set"/"not set" and stays). */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "payoutDestination" && (v === "set" || v === "not set")) out[k] = v;
      else if (!SECRET_KEY.test(k)) out[k] = redact(v);
    }
    return out;
  }
  return value;
}

export function shortId(userId) {
  return String(userId ?? "").slice(0, 8);
}

export function fmtDate(ms) {
  if (!ms) return "-";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

export function fmtAgo(ms, nowMs = Date.now()) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtCSats(n) {
  return Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const yn = (b) => (b ? "yes" : "no");

function table(rows, indent = "    ") {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => indent + r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join("  ").trimEnd()).join("\n");
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function formatAccount(a, nowMs = Date.now()) {
  const head = [
    shortId(a.userId),
    a.email ?? "(no email)",
    a.displayName ? `"${a.displayName}"` : null,
    a.roles.length ? `[${a.roles.join(", ")}]` : null
  ].filter(Boolean).join("  ");
  const lines = [head];
  lines.push(
    `  host-approved ${yn(a.hostApproved)}${a.hostApprovalSource ? ` (${a.hostApprovalSource})` : ""} | email verified ${yn(a.emailVerified)} | created ${fmtDate(a.createdAtMs)} | last sign-in ${fmtDate(a.lastSignInMs)}`
  );
  lines.push(
    `  balance ${fmtCSats(a.balanceCSats)} cSats | spent today ${fmtCSats(a.spentTodayCSats)} | API keys ${a.apiKeys.active} active (${a.apiKeys.total} total) | bots ${a.bots === null ? "n/a" : a.bots} | payout destination ${a.payoutDestination}`
  );
  if (!a.machines.length) {
    lines.push("  machines: none");
  } else {
    const online = a.machines.filter((m) => m.online).length;
    lines.push(`  machines (${a.machines.length}, ${online} online):`);
    const rows = [["AGENT", "STATE", "CLASS/TIER", "ENGINE", "MODELS", "NODE OK", "HOST ROLE", "COORDINATOR"]];
    for (const m of a.machines) {
      rows.push([
        truncate(m.agentId, 36),
        `${m.online ? "online" : "offline"} ${fmtAgo(m.lastSeenMs, nowMs)}${m.blacklisted ? " BLACKLISTED" : ""}`,
        m.computeClass ? `${m.computeClass}/${m.tier ?? "?"}` : "-",
        m.engine ?? "-",
        m.models.length ? truncate(m.models.join(","), 40) : "-",
        m.approvedNode === null ? "-" : yn(m.approvedNode),
        m.hostRole,
        m.coordinator ?? "-"
      ]);
    }
    lines.push(table(rows));
  }
  return lines.join("\n");
}

export function formatReport(accounts, meta = {}, nowMs = Date.now()) {
  const machines = accounts.reduce((n, a) => n + a.machines.length, 0);
  const online = accounts.reduce((n, a) => n + a.machines.filter((m) => m.online).length, 0);
  const out = [`${accounts.length} accounts, ${machines} machines (${online} online) as of ${fmtDate(nowMs)}`];
  for (const w of meta.warnings ?? []) out.push(`warning: ${w}`);
  if (meta.timings) out.push(`sources: ${Object.entries(meta.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(", ")}`);
  for (const a of accounts) out.push("", formatAccount(a, nowMs));
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Main

export async function collect({ exec, nowMs = Date.now() } = {}) {
  const today = utcDayStartMs(nowMs);
  const withParams = (qs, params) => Object.fromEntries(Object.entries(qs).map(([k, sql]) => [k, { sql, params: params[k] ?? [] }]));
  const portalJob = { dbEnv: "PORTAL_DATABASE_URL", queries: withParams(PORTAL_QUERIES, {}), env: ["SYSTEM_ADMIN_EMAILS", "HOST_APPROVED_EMAILS"] };
  const ledgerJob = { dbEnv: "DATABASE_URL", queries: withParams(LEDGER_QUERIES, { balances: [today] }), adminNetwork: true };
  const jobs = [["portal", PORTAL_APP, portalJob]];
  for (const app of COORDINATOR_APPS) jobs.push([app, app, app === LEDGER_APP ? ledgerJob : { adminNetwork: true }]);
  if (!COORDINATOR_APPS.includes(LEDGER_APP)) jobs.push([LEDGER_APP, LEDGER_APP, ledgerJob]);
  const settled = await Promise.allSettled(jobs.map(([, app, job]) => runRemote(app, job, exec)));
  const warnings = [];
  const timings = {};
  let portal = null;
  let ledger = null;
  const networks = [];
  settled.forEach((s, i) => {
    const [name, app] = jobs[i];
    if (s.status === "rejected") {
      warnings.push(`${app}: ${s.reason?.message ?? s.reason}`);
      return;
    }
    const r = s.value;
    timings[name] = r.ms;
    for (const [k, v] of Object.entries(r.errors ?? {})) warnings.push(`${app} ${k}: ${v}`);
    if (name === "portal") portal = r;
    if (app === LEDGER_APP) ledger = r;
    if (r.network) networks.push({ app, network: r.network });
  });
  return { accounts: mergeAccounts({ portal, ledger, networks }, nowMs), warnings, timings };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const nowMs = Date.now();
  const { accounts, warnings, timings } = await collect({ nowMs });
  const shown = redact(applyFilters(accounts, opts));
  if (opts.json) console.log(JSON.stringify({ asOf: new Date(nowMs).toISOString(), warnings, timings, accounts: shown }, null, 2));
  else console.log(formatReport(shown, { warnings, timings }, nowMs));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}

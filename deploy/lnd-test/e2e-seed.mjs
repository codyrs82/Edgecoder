// Runs inside a seed machine (/app) for deploy/lnd-test/e2e-payout.sh. Calls the local coordinator with
// the tokens already in the machine's env, so no token leaves the machine. Prints JSON only.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire("/app/package.json");
const [cmd, ...args] = process.argv.slice(2);
const base = "http://127.0.0.1:4301";
const headers = {
  "content-type": "application/json",
  "x-mesh-token": process.env.MESH_AUTH_TOKEN ?? "",
  "x-portal-service-token": process.env.PORTAL_SERVICE_TOKEN ?? ""
};
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const out = (v) => console.log(JSON.stringify(v));

if (cmd === "intent") out(await call("POST", "/economy/payments/intents", { accountId: args[0], amountSats: Number(args[1]) }));
else if (cmd === "reconcile") out(await call("POST", "/economy/payments/reconcile", {}));
else if (cmd === "intent-status") out(await call("GET", `/economy/payments/intents/${args[0]}`));
else if (cmd === "earn") {
  // Test-only earnings row. reason 'regtest_e2e_test' marks it for the pre-mainnet wipe.
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sats = Number(args[1]);
  await pool.query(
    `INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms, msat)
     VALUES ($1,$2,'earn',$3,'regtest_e2e_test',NULL,$4,$5)`,
    [randomUUID(), args[0], sats, Date.now(), sats * 1000]
  );
  await pool.end();
  out({ ok: true, earnedSats: sats });
} else if (cmd === "withdraw") out(await call("POST", "/economy/payouts/withdraw", { accountId: args[0], bolt11: args[1] }));
else if (cmd === "payouts") out(await call("GET", `/economy/payouts/${args[0]}`));
else { out({ error: "unknown_command" }); process.exit(2); }

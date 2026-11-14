// Wipe a database's ledger for a new Bitcoin network (docs/going-to-mainnet.md, "Switching the
// database to mainnet"). Stop every coordinator on the database first, and take a backup.
//
//   DATABASE_URL=postgres://... npx tsx scripts/ledger-reset-network.ts --confirm-wipe-ledger regtest --to bitcoin [--dry-run]
//
// --confirm-wipe-ledger must name the network the database is recorded for (or "unrecorded" for a
// database from before the network was recorded). In one transaction it deletes every money row
// (credits, earnings, purchases, payouts and the ledgers/anchors attesting to them; the list is
// WIPED_TABLES in src/db/ledger-reset.ts), keeps accounts, agents, keys, destinations and safety
// state, and records the new network. Prints row counts per table; never prints the URL or secrets.
import pg from "pg";
import { PostgresStore } from "../src/db/postgres.js";
import { KEPT_TABLES, parseResetArgs, resetLedgerNetwork } from "../src/db/ledger-reset.js";

async function main(): Promise<number> {
  let args;
  try {
    args = parseResetArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    // Make sure every table (ledger_network included) exists, as a coordinator start would.
    await new PostgresStore(pool).migrate();
    const r = await resetLedgerNetwork(pool, args, { by: `ledger-reset-network (${process.env.USER ?? "operator"})` });
    console.log(`${r.dryRun ? "[dry run] would wipe" : "wiped"} ledger: ${r.from} -> ${r.to}`);
    for (const [table, n] of Object.entries(r.deleted)) console.log(`  ${table.padEnd(34)} ${n}`);
    console.log(`kept: ${KEPT_TABLES.join(", ")}`);
    if (r.dryRun) console.log("[dry run] nothing changed; ledger_network unchanged");
    else console.log(`ledger_network = ${r.to}. Start coordinators with BITCOIN_NETWORK=${r.to}.`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();

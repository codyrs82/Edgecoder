# Database migrations (coordinator Postgres)

`PostgresStore.migrate()` runs `SCHEMA_SQL` (`src/db/postgres.ts`) on every start. The script is
idempotent: tables and indexes use `IF NOT EXISTS`, and each type change is wrapped in a `DO` block
that checks `information_schema` first. It is sent as one statement batch, so Postgres runs it as a
single implicit transaction.

## Concurrent starts

The first statement is `SELECT pg_advisory_xact_lock(<SCHEMA_LOCK_NAMESPACE>, <SCHEMA_LOCK_KEY>)`
(`0x45430000`, `1`). If several instances start at once (rolling deploy, scaled replicas), each
`migrate()` waits for the one in progress to commit, then finds nothing left to do. The lock is
released automatically when the transaction ends, including on error or a dropped connection. It
blocks only other `migrate()` calls, not normal queries. Do not add `BEGIN`/`COMMIT` or
`CREATE INDEX CONCURRENTLY` to `SCHEMA_SQL`: they would break the single transaction.

## #108: `credit_transactions.credits` to `NUMERIC(30, 6)`

| | |
|---|---|
| Runs when | the column is not yet `NUMERIC(30, 6)` (for example `DOUBLE PRECISION`) |
| Statement | `ALTER TABLE credit_transactions ALTER COLUMN credits TYPE NUMERIC(30, 6) USING round(credits::numeric, 6)` |
| Table lock | `ACCESS EXCLUSIVE` on `credit_transactions` for the whole migration transaction. The table is rewritten, and its indexes (`idx_credit_transactions_account`, `idx_credit_tx_credit_purchase_once`) are rebuilt. Reads and writes of credits block until it commits. |
| Duration | proportional to the table size. Expect seconds per million rows; on large tables, schedule a quiet window. |
| Data change | values are rounded to 6 decimals, which removes float artefacts (`0.30000000000000004` becomes `0.300000`). Amounts are written with at most 3 decimals, so no real precision is lost. |
| Dependent views | **none ship with EdgeCoder.** Postgres refuses to change the type of a column that a view or rule uses (`cannot alter type of a column used by a view or rule`). If you created your own views on `credit_transactions`, drop them before upgrading and recreate them afterwards. Find them with the query below. |
| Rollback | `ALTER TABLE credit_transactions ALTER COLUMN credits TYPE DOUBLE PRECISION` (same lock). |

After the migration, new writes are rounded to 6 decimals by the column type. The application also
rounds (`roundCredits`) and rejects amounts that round to 0.

```sql
-- Views and rules that depend on credit_transactions (run before upgrading)
SELECT DISTINCT v.oid::regclass AS dependent_view
FROM pg_depend d
JOIN pg_rewrite r ON r.oid = d.objid
JOIN pg_class v ON v.oid = r.ev_class
WHERE d.refobjid = 'credit_transactions'::regclass
  AND d.classid = 'pg_rewrite'::regclass
  AND v.oid <> d.refobjid;
```

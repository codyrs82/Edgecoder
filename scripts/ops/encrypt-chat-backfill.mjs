#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// Seal web chat rows written before PORTAL_CHAT_KEY was set (src/portal/chat-crypto.ts).
//
//   node encrypt-chat-backfill.mjs [--dry-run] [--batch-size=500]
//
// Run INSIDE the portal machine (it reads PORTAL_DATABASE_URL and PORTAL_CHAT_KEY from that
// machine's environment; nothing secret leaves it). The portal image ships dist/ only, so copy this
// file in first, e.g.:
//
//   fly ssh sftp shell -a edgecoder-portal      # then: put scripts/ops/encrypt-chat-backfill.mjs /tmp/encrypt-chat-backfill.mjs
//   fly ssh console -a edgecoder-portal -C "node /tmp/encrypt-chat-backfill.mjs --dry-run"
//   fly ssh console -a edgecoder-portal -C "node /tmp/encrypt-chat-backfill.mjs"
//
// What it does: for portal_messages.content and portal_conversations.title, every value that does not
// start with `enc:` is replaced with `enc:v1:<base64 iv|tag|ciphertext>`, bound to its row exactly as
// the portal does (messageAad / titleAad below). Batches walk the primary key; each UPDATE only
// applies if the value is still the plaintext it read, so it is safe while the portal is serving.
// Idempotent: sealed rows are skipped, so a second run changes nothing. --dry-run only counts.
//
// Self-contained on purpose (node:crypto + the machine's pg). seal() and the AAD strings must match
// src/portal/chat-crypto.ts; tests/portal/chat-crypto.test.ts checks they do.
import { createCipheriv, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ENC_PREFIX = "enc:v1:";

/** The 32-byte key (64 hex chars or base64), or null. Same rules as parseBotSecretsKey. */
export function parseKey(raw) {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  const b = Buffer.from(v, "base64");
  return b.length === 32 ? b : null;
}

export const messageAad = (conversationId, messageId) => `edgecoder-chat:message:${conversationId}:${messageId}`;
export const titleAad = (conversationId) => `edgecoder-chat:title:${conversationId}`;

export function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export const isSealed = (v) => typeof v === "string" && v.startsWith("enc:");

/** The two columns to seal. Rows from fetch carry { id, conversationId, value }. */
export const TARGETS = {
  messages: {
    table: "portal_messages",
    idColumn: "message_id",
    column: "content",
    aad: (row) => messageAad(row.conversationId, row.id)
  },
  titles: {
    table: "portal_conversations",
    idColumn: "conversation_id",
    column: "title",
    aad: (row) => titleAad(row.conversationId)
  }
};

/** The UPDATEs for one batch: plaintext rows only, each sealed to its row. */
export function planBatch(target, rows, key) {
  const out = [];
  for (const row of rows) {
    if (typeof row.value !== "string" || isSealed(row.value)) continue;
    out.push({ id: row.id, oldValue: row.value, newValue: seal(key, row.value, target.aad(row)) });
  }
  return out;
}

/**
 * Seal every plaintext row of every target. `db` = { countPlain(target), fetchPlain(target, afterId,
 * limit), update(target, id, oldValue, newValue) -> boolean }. Returns per-target counts.
 */
export async function backfill({ db, key, dryRun = false, batchSize = 500, log = () => {} }) {
  if (!dryRun && !key) throw new Error("PORTAL_CHAT_KEY is not set or malformed");
  const result = {};
  for (const [name, target] of Object.entries(TARGETS)) {
    const plaintext = await db.countPlain(target);
    const r = { plaintext, sealed: 0, skipped: 0 };
    result[name] = r;
    log(`${target.table}.${target.column}: ${plaintext} plaintext row(s)${dryRun ? " (dry run)" : ""}`);
    if (dryRun || plaintext === 0) continue;
    let afterId = "";
    for (;;) {
      const rows = await db.fetchPlain(target, afterId, batchSize);
      if (rows.length === 0) break;
      for (const u of planBatch(target, rows, key)) {
        if (await db.update(target, u.id, u.oldValue, u.newValue)) r.sealed += 1;
        else r.skipped += 1; // changed since it was read; a re-run picks it up
      }
      afterId = rows[rows.length - 1].id;
      log(`${target.table}: sealed ${r.sealed} so far`);
      if (rows.length < batchSize) break;
    }
  }
  return result;
}

/** The db adapter over a pg Pool. */
export function pgAdapter(pool) {
  return {
    async countPlain(t) {
      const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t.table} WHERE ${t.column} NOT LIKE 'enc:%'`);
      return Number(r.rows[0]?.n ?? 0);
    },
    async fetchPlain(t, afterId, limit) {
      const r = await pool.query(
        `SELECT ${t.idColumn} AS id, conversation_id, ${t.column} AS value FROM ${t.table}
         WHERE ${t.column} NOT LIKE 'enc:%' AND ${t.idColumn} > $1 ORDER BY ${t.idColumn} LIMIT $2`,
        [afterId, limit]
      );
      return r.rows.map((row) => ({ id: row.id, conversationId: row.conversation_id, value: row.value }));
    },
    async update(t, id, oldValue, newValue) {
      const r = await pool.query(`UPDATE ${t.table} SET ${t.column} = $3 WHERE ${t.idColumn} = $1 AND ${t.column} = $2`, [id, oldValue, newValue]);
      return (r.rowCount ?? 0) > 0;
    }
  };
}

export function parseArgs(argv) {
  const opts = { dryRun: false, batchSize: 500, help: false };
  for (const a of argv) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--batch-size=")) {
      const n = Number(a.slice("--batch-size=".length));
      if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new Error("--batch-size must be 1..10000");
      opts.batchSize = n;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export const USAGE = "usage: node encrypt-chat-backfill.mjs [--dry-run] [--batch-size=500]  (inside the portal machine)";

function loadPg() {
  const require = createRequire(import.meta.url);
  try {
    return require("pg");
  } catch {
    // Copied to /tmp on the portal machine: use the app's own node_modules.
    return createRequire(join(process.env.EDGECODER_APP_DIR || "/app", "package.json"))("pg");
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) return console.log(USAGE);
  const url = process.env.PORTAL_DATABASE_URL;
  if (!url) throw new Error("PORTAL_DATABASE_URL is not set");
  const key = parseKey(process.env.PORTAL_CHAT_KEY);
  if (!opts.dryRun && !key) throw new Error("PORTAL_CHAT_KEY is not set or malformed");
  const pg = loadPg();
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const result = await backfill({ db: pgAdapter(pool), key, dryRun: opts.dryRun, batchSize: opts.batchSize, log: (m) => console.log(m) });
    console.log(JSON.stringify(result));
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}

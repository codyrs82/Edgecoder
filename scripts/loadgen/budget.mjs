#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Pre-run budget for the load test accounts (REGTEST ONLY). Runs on the operator's machine.
 *
 *   node scripts/loadgen/budget.mjs check [--users st1,st2]
 *   node scripts/loadgen/budget.mjs topup --min 200 --to 1000 --max-total 5000 [--users ...] [--dry-run]
 *
 * topup buys cSats for every account below --min, up to --to, through the public API
 * (POST /v1/account/topup), and pays the invoice from the regtest payee node
 * (fly ssh into edgecoder-lnd-test, process group "payee"), as scripts in the e2e kit do.
 * Refuses any invoice that is not a regtest invoice (lnbcrt...), so it cannot spend real funds,
 * and never spends more than --max-total sats in one call. Keys come from the account files and
 * are never printed. Needs FLY_API_TOKEN (or ~/.config/edgecoder/fly.token) for the payee.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? "true" : argv[i + 1]; };
const URL_ = flag("url", "https://edgecoder.io");
const DIR = flag("keys-dir", join(homedir(), ".config/edgecoder/e2e/accounts"));
const LND_APP = flag("lnd-app", "edgecoder-lnd-test");
const UA = "edgecoder-loadgen/1.0 (budget)";
const only = (flag("users", "") || "").split(",").filter(Boolean);

const accounts = readdirSync(DIR)
  .map((f) => /^(st\d+)\.json$/.exec(f)?.[1])
  .filter((n) => n && (!only.length || only.includes(n)))
  .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
  .map((name) => ({ name, key: JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")).apiKey }))
  .filter((a) => a.key);

const api = async (key, path, body) => {
  const r = await fetch(`${URL_}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": UA },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const balance = async (a) => { const r = await api(a.key, "/v1/account"); return r.status === 200 ? Number(r.j.cSats ?? 0) : null; };

function flyEnv() {
  const e = { ...process.env };
  if (!e.FLY_API_TOKEN) { const f = join(homedir(), ".config/edgecoder/fly.token"); if (existsSync(f)) e.FLY_API_TOKEN = readFileSync(f, "utf8").trim(); }
  return e;
}
let payeeId;
function payInvoice(invoice) {
  // Regtest invoices start with lnbcrt; anything else could be real money.
  if (!/^lnbcrt\d/i.test(invoice)) throw new Error("refusing to pay a non-regtest invoice");
  const e = flyEnv();
  payeeId ??= JSON.parse(execFileSync("fly", ["machines", "list", "-a", LND_APP, "--json"], { env: e, encoding: "utf8" }))
    .find((m) => m.config?.metadata?.fly_process_group === "payee")?.id;
  if (!payeeId) throw new Error(`no payee machine in ${LND_APP}`);
  const outp = execFileSync("fly", ["ssh", "console", "-a", LND_APP, "--machine", payeeId, "-q", "-C", `lncli --lnddir=/data --network=regtest payinvoice --force ${invoice}`], { env: e, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return /Payment status:\s*SUCCEEDED/i.test(outp) || /"status":\s*"SUCCEEDED"/.test(outp);
}

if (cmd === "check") {
  let total = 0;
  for (const a of accounts) {
    const b = await balance(a);
    total += b ?? 0;
    console.log(`${a.name.padEnd(5)} ${b === null ? "unavailable" : b.toFixed(3).padStart(14)} cSats`);
  }
  console.log(`total ${total.toFixed(3)} cSats over ${accounts.length} accounts`);
} else if (cmd === "topup") {
  const min = Number(flag("min", 200)), to = Number(flag("to", 1000)), maxTotal = Number(flag("max-total", 5000));
  const dry = flag("dry-run", "false") === "true";
  if (to < min) throw new Error("--to must be >= --min");
  let spent = 0;
  for (const a of accounts) {
    const b = await balance(a);
    if (b === null) { console.log(`${a.name}: balance unavailable, skipped`); continue; }
    if (b >= min) { console.log(`${a.name}: ${b.toFixed(3)} cSats, no top-up needed`); continue; }
    const want = Math.min(20_000, Math.ceil(to - b));
    if (spent + want > maxTotal) { console.log(`${a.name}: needs ${want} sats but the run budget (--max-total ${maxTotal}) is used up; skipped`); continue; }
    if (dry) { console.log(`${a.name}: ${b.toFixed(3)} cSats -> would buy ${want} sats`); spent += want; continue; }
    const r = await api(a.key, "/v1/account/topup", { amountSats: want });
    if (r.status !== 200 || !r.j.invoice) { console.log(`${a.name}: top-up refused (${r.status} ${r.j.error ?? ""})`); continue; }
    let paid = false;
    try { paid = payInvoice(r.j.invoice); } catch (e) { console.log(`${a.name}: payment failed: ${String(e.message).slice(0, 120)}`); }
    let status = "unknown";
    for (let i = 0; paid && i < 15; i++) {
      status = (await api(a.key, `/v1/account/topup/${encodeURIComponent(r.j.intentId)}`)).j.status;
      if (status === "settled") break;
      await new Promise((res) => setTimeout(res, 3_000));
    }
    if (paid) spent += want;
    console.log(`${a.name}: bought ${want} sats, payment ${paid ? "sent" : "not sent"}, intent ${status}; balance now ${(await balance(a))?.toFixed(3)} cSats`);
  }
  console.log(`${dry ? "would spend" : "spent"} ${spent} regtest sats (limit ${maxTotal})`);
} else {
  console.log("usage: budget.mjs check | topup --min N --to N --max-total N [--users a,b] [--dry-run]");
  process.exit(2);
}

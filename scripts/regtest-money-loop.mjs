#!/usr/bin/env node
// Regtest money loop: buy -> spend -> earn -> hold -> payout -> revenue, with the safeguards, against the
// live REGTEST network (portal edgecoder.io, seeds edgecoder-seed / -eu, LND edgecoder-lnd-test).
// See docs/going-to-mainnet.md ("Regtest money loop"). Refuses to run when a seed reports a network
// other than regtest. Prints ids, amounts, hashes and statuses only; never tokens, keys or macaroons.
// ML_NETWORK=signet runs buy / spend / transfer / withdraw / payouts / check against the signet
// coordinators instead: their node is edgecoder-lnd-signet and the Mutinynet faucet is the outside
// payer (buy) and payee (withdraw, revenue). lnurl-up and the payee-node commands stay regtest only.
//
//   node scripts/regtest-money-loop.mjs <command> [args]       (run dir: .money-loop/<runId>/)
//   preflight                          networks, pause, reconciliation, nodes, LNURL app
//   lnurl-up | lnurl-down              create+deploy / destroy the regtest Lightning-address app
//   destinations-clear <acct...>       stop auto payouts to those accounts (coordinator side)
//   mode <name> ok|cancel|hold|error   how the Lightning address <name>@<lnurl app> answers
//   cancel-held                        cancel hold invoices (fails the in-flight payments)
//   resolve-pending [us|eu]            settle stuck pending payouts (builds with /admin/payouts/resolve-pending)
//   destinations <acct...>             set <acct>@<lnurl app> as each account's payout destination (first time only)
//   buy <buyer> <sats>                 step 1: top-up invoice, paid by the payee node, balance arrives
//   spend <buyer> [minutes] [rate]     step 2: paid model calls across classes (default 25 min, 1/s)
//   verify-spend <buyer> <runId>       steps 2-3: per-call reserve/refund, 95/5 split, exact totals
//   transfer <buyer> <runId> <sats> <acct...>   test earnings large enough to pay out (balanced, regtest_e2e_test)
//   infer <buyer> us|eu [n] [model]    step 8: n paid calls billed by that seed (submitted there directly)
//   auto-payouts [us|eu]               one automatic payout pass on a seed
//   payouts <sinceMs>                  payout rows + LND payment state on hub and payee
//   withdraw <acct> <sats> [us|eu]     withdrawal of <sats> to a payee invoice
//   revenue <sats>                     step 5: withdraw <sats> of the fee pool to the payee, show /admin/revenue
//   pause on|off [reason]              kill switch
//   settings-test [holdMs] [single] [account]   temporary hold / caps / alert webhook secrets on both seeds
//   settings-restore                   unset them again (caps fall back to the seeds' fly.toml [env])
//   hooks                              alerts the webhook catcher received
//   check                              ledger invariants + /ledger/verify + reconciliation on both seeds
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { HERE, COORDS, SEEDS, LNURL_APP, LNURL_HOST, NETWORK, INVOICE_RE, admin, api, portal, seed, lncli, lndMachine, fly, log, sleep, http, lnurlAdmin, hookUrl, faucetPay, faucetInvoice } from "./regtest-money-loop/lib.mjs";

const [cmd, ...args] = process.argv.slice(2);
const RUNS = join(HERE, "..", "..", ".money-loop");
const runDir = (id) => { const d = join(RUNS, id); mkdirSync(d, { recursive: true }); return d; };
const save = (id, name, v) => writeFileSync(join(runDir(id), name), JSON.stringify(v, null, 2));
const print = (v) => console.log(JSON.stringify(v, null, 2));
const accountId = async (name) => (await api(name, "/v1/account")).json?.accountId;
const NETWORK_FEE_BPS = Number(process.env.ML_NETWORK_FEE_BPS ?? 500);

async function assertRegtest() {
  for (const w of ["us", "eu"]) {
    const r = await http(COORDS[w] + "/health/runtime").catch(() => null);
    const net = r?.json?.bitcoinNetwork ?? r?.json?.network ?? r?.json?.economy?.network;
    if (net && net !== NETWORK) throw new Error(`${w} coordinator reports ${net}; this run is ${NETWORK} only`);
  }
  const info = JSON.parse(await lncli("hub", "getinfo"));
  if (!info.chains?.some((c) => c.network === NETWORK)) throw new Error(`hub node is not on ${NETWORK}`);
  return info;
}
const regtestOnly = (what) => { if (NETWORK !== "regtest") throw new Error(`${what} is regtest only`); };

async function payeeInvoice(sats, memo) {
  if (NETWORK === "signet") return faucetInvoice(sats);
  const r = JSON.parse(await lncli("payee", `addinvoice --amt ${Math.floor(sats)} --memo ${memo}`));
  return { bolt11: r.payment_request, hash: r.r_hash };
}

/** Pay a coordinator invoice from outside: the regtest payee node, or on signet the faucet. */
async function payFromOutside(bolt11) {
  if (!INVOICE_RE.test(bolt11 ?? "")) throw new Error(`refusing to pay a non-${NETWORK} invoice`);
  if (NETWORK === "signet") {
    const r = await faucetPay(bolt11);
    return { status: r.status === "OK" ? "SENT_BY_FAUCET" : r.status, reason: r.reason };
  }
  const pay = await lncli("payee", `payinvoice --force --json ${bolt11}`).catch((e) => e.stdout ?? String(e));
  try { return JSON.parse(pay.slice(pay.indexOf("{"))); } catch { return {}; /* lncli prints progress lines */ }
}

const MODELS = [
  // [model, weight]: CPU fleet (st1-st9), Apple (Macs), GPU VM (st10)
  ["network/qwen2.5-coder:1.5b@cpu", 6],
  ["network/qwen2.5-coder:1.5b@apple", 1],
  ["network/qwen2.5-coder:7b@apple", 1],
  ["network/qwen3-coder:30b@gpu.dc", 2]
];
const PROMPTS = ["Write a Python function that reverses a string.", "Explain a JavaScript closure in two sentences.", "Write a SQL query that counts rows per day.", "Give a bash one-liner that counts lines in all .ts files.", "Write a Go function that sums a slice of ints."];
const pickModel = () => {
  const total = MODELS.reduce((s, [, w]) => s + w, 0);
  let x = Math.random() * total;
  for (const [m, w] of MODELS) if ((x -= w) < 0) return m;
  return MODELS[0][0];
};

const commands = {
  async preflight() {
    const hub = await assertRegtest();
    const out = { hub: { alias: hub.alias, synced: hub.synced_to_chain, height: hub.block_height, channels: hub.num_active_channels } };
    if (NETWORK === "signet") out.hubChannels = JSON.parse(await lncli("hub", "listchannels")).channels.map((c) => ({ capacity: +c.capacity, local: +c.local_balance, remote: +c.remote_balance, active: c.active }));
    else {
    const payee = JSON.parse(await lncli("payee", "getinfo"));
    out.payee = { alias: payee.alias, synced: payee.synced_to_chain, channels: payee.num_active_channels };
    out.payeeChannels = JSON.parse(await lncli("payee", "listchannels")).channels.map((c) => ({ capacity: +c.capacity, local: +c.local_balance, remote: +c.remote_balance, active: c.active }));
    }
    for (const w of ["us", "eu"]) {
      const p = await admin(w, "/admin/payouts/pause");
      const rc = await admin(w, "/admin/payouts/reconciliation");
      out[w] = { pause: p.json, reconciliation: { status: rc.json?.last?.status, atMs: rc.json?.last?.atMs, failed: rc.json?.last?.checks?.filter((c) => !c.ok).map((c) => c.name), webhookConfigured: rc.json?.webhookConfigured } };
    }
    out.lnurl = (await http(`https://${LNURL_HOST}/healthz`).catch(() => ({ status: 0 }))).status;
    print(out);
  },

  async "lnurl-up"(org = "edgecoder") {
    // Regtest Lightning-address server + webhook catcher (scripts/regtest-money-loop/lnurl). The payee's
    // invoice macaroon and TLS cert go from the payee machine straight into Fly secrets.
    regtestOnly("lnurl-up");
    await assertRegtest();
    const apps = JSON.parse(await fly(["apps", "list", "--json"]));
    if (!apps.some((a) => (a.Name ?? a.name) === LNURL_APP)) await fly(["apps", "create", LNURL_APP, "-o", org]);
    const tokFile = process.env.ML_LNURL_TOKENS ?? join(homedir(), ".config/edgecoder/e2e/lnurl-tokens.env");
    if (!existsSync(tokFile)) writeFileSync(tokFile, `ADMIN_TOKEN=${randomBytes(24).toString("hex")}\nHOOK_TOKEN=${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
    const mac = (await lncli("payee", "bakemacaroon invoices:read invoices:write")).replace(/\s+/g, "");
    const payee = await lndMachine("payee");
    const cert = (await fly(["ssh", "console", "-a", "edgecoder-lnd-test", "--machine", payee, "-q", "-C", "base64 -w0 /data/tls.cert"])).split("\n").filter((l) => !l.startsWith("Connecting")).join("").trim();
    if (mac.length < 100 || !Buffer.from(cert, "base64").toString("utf8").includes("BEGIN CERTIFICATE")) throw new Error("could not read payee macaroon/cert");
    await fly(["secrets", "import", "-a", LNURL_APP, "--stage"], { input: `PAYEE_MACAROON_HEX=${mac}\nPAYEE_TLS_CERT_BASE64=${cert}\n${readFileSync(tokFile, "utf8")}` });
    await fly(["deploy", "-a", LNURL_APP, "--ha=false", "--remote-only", "--config", join(HERE, "lnurl", "fly.toml"), join(HERE, "lnurl")], { timeoutMs: 900_000 });
    print({ app: LNURL_APP, health: (await http(`https://${LNURL_HOST}/healthz`)).status });
  },

  async "lnurl-down"() {
    // Destinations that point at the app stop resolving: clear them on the coordinator first
    // (destinations-clear), so auto payouts skip those accounts instead of failing every pass.
    await fly(["apps", "destroy", LNURL_APP, "--yes"]);
    print({ destroyed: LNURL_APP });
  },

  async "destinations-clear"(...names) {
    // The portal keeps its record (changing it needs an emailed code); the coordinator stops paying it.
    const res = [];
    for (const n of names) res.push({ n, ...(await seed("us", "address", await accountId(n), "-")) });
    print(res);
  },

  async "settings-test"(holdMs = "600000", single = "15000", account = "30000") {
    // Temporary regtest-only overrides as Fly secrets on both seeds (fly restarts the machines).
    // Undo with settings-restore: the caps fall back to the [env] values in the seeds' fly.toml.
    const vals = `PAYOUT_EARNINGS_HOLD_MS=${holdMs}\nPAYOUT_ALERT_WEBHOOK_URL=${hookUrl()}\nPAYOUT_MAX_SINGLE_SATS=${single}\nPAYOUT_MAX_ACCOUNT_DAILY_SATS=${account}\n`;
    for (const app of Object.values(SEEDS)) {
      await fly(["secrets", "import", "-a", app], { input: vals, timeoutMs: 900_000 });
      log(`set on ${app}: PAYOUT_EARNINGS_HOLD_MS=${holdMs} PAYOUT_MAX_SINGLE_SATS=${single} PAYOUT_MAX_ACCOUNT_DAILY_SATS=${account} PAYOUT_ALERT_WEBHOOK_URL=<catcher>`);
    }
  },

  async "settings-restore"() {
    for (const app of Object.values(SEEDS)) {
      await fly(["secrets", "unset", "-a", app, "PAYOUT_EARNINGS_HOLD_MS", "PAYOUT_ALERT_WEBHOOK_URL", "PAYOUT_MAX_SINGLE_SATS", "PAYOUT_MAX_ACCOUNT_DAILY_SATS"], { timeoutMs: 900_000 });
      log(`unset on ${app}`);
    }
  },

  async "resolve-pending"(which = "us") {
    const r = await admin(which, "/admin/payouts/resolve-pending", { method: "POST", body: {} });
    print({ status: r.status, body: r.json ?? r.text });
  },

  async destinations(...names) {
    const res = [];
    for (const n of names) {
      const cur = await portal(n, "/wallet/payout-destination");
      const want = `${n}@${LNURL_HOST}`;
      if (cur.json?.destination?.destination === want) { res.push({ n, accountId: cur.json.accountId, destination: want, already: true }); continue; }
      if (cur.json?.destination) { res.push({ n, accountId: cur.json.accountId, destination: cur.json.destination.destination, skipped: "has another destination (changing needs an emailed code)" }); continue; }
      const r = await portal(n, "/wallet/payout-destination", { method: "PUT", body: { destination: want } });
      res.push({ n, accountId: r.json?.accountId, status: r.status, destination: r.json?.destination?.destination, registration: r.json?.registration, error: r.json?.error });
    }
    print(res);
  },

  async buy(buyer, sats) {
    await assertRegtest();
    const before = (await api(buyer, "/v1/account")).json;
    const t = await api(buyer, "/v1/account/topup", { method: "POST", body: { amountSats: Number(sats) } });
    if (!t.json?.intentId) throw new Error(`topup failed: ${t.status} ${JSON.stringify(t.json)}`);
    const id = t.json.intentId;
    log("intent", id, "status", (await api(buyer, `/v1/account/topup/${id}`)).json?.status);
    const payJ = await payFromOutside(t.json.invoice);
    let st;
    for (let i = 0; i < 30; i++) {
      st = (await api(buyer, `/v1/account/topup/${id}`)).json;
      if (st?.status && st.status !== "created") break;
      await sleep(3000);
    }
    const after = (await api(buyer, "/v1/account")).json;
    const ev = { network: NETWORK, buyer, accountId: after.accountId, intentId: id, amountSats: Number(sats), intent: st, payer: { status: payJ.status, reason: payJ.reason, paymentHash: payJ.payment_hash, feeMsat: payJ.fee_msat }, cSatsBefore: before.cSats, cSatsAfter: after.cSats, purchaseRow: after.recent?.find((r) => String(r.reason ?? "").includes(id)) };
    save(`buy-${id}`, "buy.json", ev);
    print(ev);
  },

  async spend(buyer, minutes = "25", rate = "1", conc = "8") {
    await assertRegtest();
    const runId = `spend-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}`;
    const dir = runDir(runId);
    const endAt = Date.now() + Number(minutes) * 60_000;
    const startMs = Date.now();
    const intervalMs = 1000 / Number(rate);
    let inflight = 0, sent = 0, ok = 0, fail = 0, spent = 0;
    const byModel = {};
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ buyer, accountId: await accountId(buyer), startMs, minutes: Number(minutes), rate: Number(rate) }));
    const one = async () => {
      const model = pickModel();
      const t0 = Date.now();
      const body = { model, messages: [{ role: "user", content: `${PROMPTS[sent % PROMPTS.length]} (${runId} #${sent})` }], max_tokens: model.includes("30b") ? 120 : 60 };
      sent++;
      inflight++;
      let r;
      try { r = await api(buyer, "/v1/chat/completions", { method: "POST", body, timeoutMs: 180_000 }); } catch (e) { r = { status: 0, json: { error: String(e.message ?? e) } }; }
      inflight--;
      const rec = { t0, ms: Date.now() - t0, model, status: r.status, spent: r.json?.edgecoder?.cSatsSpent ?? null, usage: r.json?.usage ?? null, error: r.status === 200 ? undefined : r.json?.error ?? r.text };
      appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(rec) + "\n");
      const m = (byModel[model] ??= { ok: 0, fail: 0, spent: 0 });
      if (r.status === 200) { ok++; m.ok++; spent += rec.spent ?? 0; m.spent += rec.spent ?? 0; } else { fail++; m.fail++; }
    };
    const timer = setInterval(() => log(`sent ${sent} ok ${ok} fail ${fail} inflight ${inflight} spent ${spent.toFixed(3)} cSats`), 60_000);
    while (Date.now() < endAt) {
      if (inflight < Number(conc)) void one();
      await sleep(intervalMs);
    }
    while (inflight > 0) await sleep(500);
    clearInterval(timer);
    const summary = { runId, buyer, startMs, endMs: Date.now(), sent, ok, fail, spentReported: Number(spent.toFixed(6)), byModel };
    save(runId, "summary.json", summary);
    print(summary);
  },

  async "verify-spend"(buyer, runId) {
    const meta = JSON.parse(readFileSync(join(RUNS, runId, "meta.json"), "utf8"));
    const summary = JSON.parse(readFileSync(join(RUNS, runId, "summary.json"), "utf8"));
    const acct = meta.accountId;
    const r = await seed("us", "spend", acct, meta.startMs - 5_000, summary.endMs + 120_000);
    const POOL = "network:fee_pool";
    const tasks = new Map(r.reserves.map((x) => [x.task, { reserved: x.reservedMicro, refunded: 0, earn: 0, fee: 0, earnMsat: 0, feeMsat: 0, hosts: new Set(), other: [] }]));
    for (const row of r.rows) {
      const task = row.task ?? row.reason.split(":").slice(1).join(":");
      const t = tasks.get(task);
      if (!t) continue;
      if (row.reason.startsWith("task_submit_refund:")) t.refunded += row.micro;
      else if (row.reason.startsWith("network_fee:") && row.account === POOL) { t.fee += row.micro; t.feeMsat += row.msat ?? 0; }
      else if (row.reason === "compute_contribution") { t.earn += row.micro; t.earnMsat += row.msat ?? 0; t.hosts.add(row.account); }
      else if (row.reason === "inference_reserve" || row.reason === "task_reserve") { /* the reserve itself */ }
      else t.other.push(row.reason);
    }
    let charged = 0, earn = 0, fee = 0, earnMsat = 0, feeMsat = 0, unsettled = 0, over = 0, splitOff = 0, own = 0;
    const perHost = {};
    const problems = [];
    for (const [task, t] of tasks) {
      const c = t.reserved - t.refunded; // micro-cSats the buyer paid for this call
      if (t.refunded === 0) { unsettled++; problems.push({ task, problem: "no refund row (unsettled)" }); continue; }
      if (c < 0 || t.earn + t.fee > c) { over++; problems.push({ task, problem: "paid out more than charged", c, earn: t.earn, fee: t.fee }); }
      if (t.earn + t.fee !== c) problems.push({ task, problem: "charge != host + fee", c, earn: t.earn, fee: t.fee });
      if (c === 0 && t.earn === 0) own++;
      const costMsat = Math.round(c / 1000);
      const expectFee = Math.floor((costMsat * NETWORK_FEE_BPS) / 10_000);
      if (t.feeMsat !== expectFee || t.earnMsat !== costMsat - expectFee) { splitOff++; problems.push({ task, problem: "split", costMsat, earnMsat: t.earnMsat, feeMsat: t.feeMsat, expectFee }); }
      charged += c; earn += t.earn; fee += t.fee; earnMsat += t.earnMsat; feeMsat += t.feeMsat;
      for (const h of t.hosts) (perHost[h] ??= { tasks: 0, msat: 0 }).tasks++;
    }
    for (const row of r.rows) if (row.reason === "compute_contribution" && tasks.has(row.task)) perHost[row.account].msat += row.msat ?? 0;
    const okCalls = summary.ok;
    const byCoordinator = {};
    for (const c of r.coords ?? []) byCoordinator[c.coordinator] = (byCoordinator[c.coordinator] ?? 0) + 1;
    const ids = {};
    for (const w of ["us", "eu"]) ids[(await http(COORDS[w] + "/identity")).json?.peerId] = w;
    const billedBy = Object.fromEntries(Object.entries(byCoordinator).map(([k, v]) => [`${ids[k] ?? "?"}:${k}`, v]));
    const out = {
      runId, buyer: acct, calls: { sent: summary.sent, ok: okCalls, fail: summary.fail, byModel: summary.byModel },
      billedBy,
      ledger: { tasks: tasks.size, unsettled, freeOwnMachine: own, chargedMsat: charged / 1000, hostEarnMsat: earnMsat, feeMsat, hostShare: charged ? earnMsat / (charged / 1000) : null, feeShare: charged ? feeMsat / (charged / 1000) : null, reportedSpentMsat: Math.round(summary.spentReported * 1000) },
      checks: { everyReserveRefunded: unsettled === 0, noTaskOverpaid: over === 0, chargeEqualsHostPlusFee: charged === earn + fee, splitMatchesFloorBps: splitOff === 0, reservesMatchCalls: tasks.size === okCalls },
      feeIfExact5pct: Math.round(((charged / 1000) * NETWORK_FEE_BPS) / 10_000), perHost, problems: problems.slice(0, 20), problemCount: problems.length
    };
    save(runId, "verify.json", out);
    print(out);
  },

  async transfer(buyer, runId, sats, ...names) {
    const list = [];
    for (const n of names) list.push([n.startsWith("acct-") || n.includes(":") ? n : await accountId(n), Number(sats)]);
    const r = await seed("us", "transfer", await accountId(buyer), runId, Buffer.from(JSON.stringify(list)).toString("base64"), NETWORK_FEE_BPS);
    save(runId, `transfer-${Date.now()}.json`, r);
    print(r);
  },

  async infer(buyer, which, n = "10", model = "qwen2.5-coder:1.5b") {
    // Calls billed by one seed (US or EU), submitted there directly as the portal would.
    const r = await seed(which, "infer", await accountId(buyer), model, n, 2);
    const ok = r.results.filter((x) => x.status === 200 && !x.error);
    print({ which, coordinator: r.coordinator, ok: ok.length, failed: r.results.length - ok.length, spent: ok.reduce((s, x) => s + (x.creditsSpent ?? 0), 0), tasks: r.results.map((x) => x.taskId), errors: r.results.filter((x) => x.status !== 200 || x.error).map((x) => x.error ?? x.status) });
  },

  async "auto-payouts"(which = "us") {
    const t0 = Date.now();
    const r = await seed(which, "auto-payouts");
    print({ which, startedMs: t0, results: r });
  },

  async payouts(sinceMs) {
    const rows = await seed("us", "payouts", sinceMs);
    const hub = JSON.parse(await lncli("hub", "listpayments --include_incomplete --max_payments 200 --paginate_forwards=false")).payments ?? [];
    const byHash = new Map(hub.map((p) => [p.payment_hash, p]));
    const out = [];
    for (const p of rows) {
      const lp = byHash.get(p.hash);
      out.push({ ...p, hub: lp ? { status: lp.status, valueSat: +lp.value_sat, feeMsat: +lp.fee_msat, failure: lp.failure_reason } : null });
    }
    print(out);
  },

  async withdraw(name, sats, which = "us") {
    const acct = name.startsWith("acct-") || name.includes(":") ? name : await accountId(name);
    const inv = await payeeInvoice(Number(sats), `ml-withdraw-${Date.now()}`);
    const r = await seed(which, "withdraw", acct, inv.bolt11);
    print({ account: acct, hash: inv.hash, status: r.status, result: r.body });
  },

  async revenue(sats, which = "us") {
    const before = await admin(which, "/admin/revenue");
    const inv = await payeeInvoice(Number(sats), `ml-revenue-${Date.now()}`);
    const w = await admin(which, "/admin/revenue/withdraw", { method: "POST", body: { bolt11: inv.bolt11 } });
    const after = await admin(which, "/admin/revenue");
    const pick = (j) => j && { feeIncome: j.feeIncome, balance: j.balance, withdrawals: (j.withdrawals ?? j.payouts ?? []).slice(0, 3) };
    print({ hash: inv.hash, withdraw: { status: w.status, body: w.json }, before: pick(before.json), after: pick(after.json) });
  },

  async pause(state, ...reason) {
    const r = await admin("us", "/admin/payouts/pause", { method: "POST", body: { paused: state === "on", reason: reason.join(" ") || "money-loop drill" } });
    print({ status: r.status, body: r.json, eu: (await admin("eu", "/admin/payouts/pause")).json });
  },

  async hooks() {
    const s = await lnurlAdmin("/admin/state");
    print({ hooks: s.json?.hooks, invoices: s.json?.invoices?.slice(-30), held: s.json?.held, modes: s.json?.modes });
  },

  async mode(name, mode) {
    print((await lnurlAdmin("/admin/mode", { method: "POST", body: { name, mode } })).json);
  },

  async "cancel-held"() {
    print((await lnurlAdmin("/admin/cancel-held", { method: "POST", body: {} })).json);
  },

  async check() {
    const out = { ledger: await seed("us", "ledger-totals") };
    for (const w of ["us", "eu"]) {
      const v = await seed(w, "ledger-verify");
      const rc = await admin(w, "/admin/payouts/reconciliation/run", { method: "POST", body: {} });
      const last = rc.json?.last ?? rc.json;
      out[w] = {
        ledgerVerify: v,
        reconciliation: { status: last?.status, failed: last?.checks?.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })), ledger: last?.ledger },
        pause: (await admin(w, "/admin/payouts/pause")).json
      };
    }
    print(out);
  }
};

if (!commands[cmd]) {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
  process.exit(2);
}
commands[cmd](...args).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });

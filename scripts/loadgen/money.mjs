// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Where a load run's money went (REGTEST). Buyers are debited what each call cost; the serving
 * agent's owner account is credited (10000 - NETWORK_FEE_BPS) / 10000 of it and the network fee pool
 * the rest (NETWORK_FEE_BPS 500: 95% / 5%). 1 cSat = 1 sat.
 *
 * Sources, all existing APIs:
 *   - GET /v1/account per test account (its API key): accountId, cSats balance, earnedSats.
 *   - GET /admin/network per coordinator (admin token): which account owns which agent and the
 *     models it holds, so we know who hosts what (and which buyer could be served by itself).
 *   - the load generator's per-call charges (edgecoder.cSatsSpent on each reply), summed per buyer.
 *
 * snapshotLedger() is taken before and after a run; moneyReport() is the pure math (unit-tested).
 * Keys and the admin token are never printed; account ids are shortened in printed output.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const NETWORK_FEE_BPS = 500;
const UA = "edgecoder-loadgen/1.0 (ledger)";

/** API keys of the test accounts (st<N>.json with an apiKey), optionally only `only`. Never printed. */
export function loadAccountKeys(dir, only = []) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^(st\d+)\.json$/.exec(f)?.[1])
    .filter((n) => n && (!only.length || only.includes(n)))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((name) => {
      try { return { name, key: JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")).apiKey }; } catch { return { name, key: null }; }
    })
    .filter((a) => a.key);
}

/** "acct-1234…cdef" for logs. */
export const shortId = (id) => (id && id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id ?? "?");

const r3 = (x) => Math.round(x * 1000) / 1000;

export async function fetchAccount(url, key) {
  try {
    const r = await fetch(`${url}/v1/account`, { headers: { authorization: `Bearer ${key}`, "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
    if (r.status !== 200) return { error: `http_${r.status}` };
    const j = await r.json();
    return { accountId: j.accountId ?? null, cSats: Number(j.cSats ?? 0), earnedSats: j.earnedSats === undefined ? null : Number(j.earnedSats) };
  } catch (e) {
    return { error: String(e?.name === "TimeoutError" ? "timeout" : "network_error") };
  }
}

/**
 * Who hosts what, from /admin/network agents of every coordinator:
 * { accountId: { agents, connected, classes: [], models: [] } } (connected, non-blacklisted agents
 * fill classes and models; an agent seen on two coordinators counts once).
 */
export function hostingFrom(snapshots) {
  const seen = new Set();
  const hosts = {};
  for (const s of snapshots ?? []) {
    for (const a of s?.agents ?? []) {
      if (!a.accountId || seen.has(a.agentId)) continue;
      seen.add(a.agentId);
      const h = (hosts[a.accountId] ??= { agents: 0, connected: 0, classes: [], models: [] });
      h.agents++;
      if (a.connected === false || a.blacklisted) continue;
      h.connected++;
      const cls = a.computeClass ?? "cpu";
      if (!h.classes.includes(cls)) h.classes.push(cls);
      for (const m of a.modelsInstalled ?? []) if (!h.models.includes(m)) h.models.push(m);
    }
  }
  return hosts;
}

/** Balances of every keyed account and who hosts what, now. */
export async function snapshotLedger({ url, accounts, fetchSnapshots, adminToken }) {
  const atMs = Date.now();
  const out = {};
  await Promise.all(accounts.map(async (a) => { out[a.name] = await fetchAccount(url, a.key); }));
  let hosts = null;
  if (adminToken && fetchSnapshots) {
    const snaps = await fetchSnapshots(adminToken).catch(() => []);
    if (snaps.some(Boolean)) hosts = hostingFrom(snaps);
  }
  return { type: "ledger", atMs, url, accounts: out, hosts };
}

/** The account id behind a name in a snapshot, and the name behind an id. */
function indexNames(...snaps) {
  const byName = {}, byId = {};
  for (const s of snaps) for (const [name, a] of Object.entries(s?.accounts ?? {})) if (a?.accountId) { byName[name] = a.accountId; byId[a.accountId] = name; }
  return { byName, byId };
}

/**
 * Buyers for a run and, per buyer, the models it must not ask for (its own agents hold them, so
 * the network could route its call to itself). "auto" is never avoided: best-fit routing leaves the
 * requester's own agents out (src/swarm/coordinator/routing.ts withoutRequesterAgents).
 * Default buyers: keyed accounts that host nothing and hold at least minBalance. When every
 * account hosts something, all keyed accounts with minBalance, each avoiding its own models.
 */
export function chooseBuyers(snapshot, { buyers = [], minBalance = 0 } = {}) {
  const hosts = snapshot?.hosts ?? {};
  const accounts = snapshot?.accounts ?? {};
  const hostedBy = (name) => hosts[accounts[name]?.accountId] ?? null;
  const funded = (name) => typeof accounts[name]?.cSats === "number" && accounts[name].cSats >= minBalance;
  let chosen = buyers.filter((n) => n in accounts || !Object.keys(accounts).length);
  let reason = "requested";
  if (!buyers.length) {
    const names = Object.keys(accounts).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const free = names.filter((n) => funded(n) && !(hostedBy(n)?.connected > 0));
    if (free.length) { chosen = free; reason = "accounts that host nothing"; }
    else { chosen = names.filter(funded); reason = "every account hosts something: each buyer avoids the models its own agents hold"; }
  }
  const avoid = {};
  const hosting = {};
  for (const n of chosen) {
    const h = hostedBy(n);
    if (!h?.connected) continue;
    hosting[n] = { agents: h.connected, classes: h.classes, models: h.models };
    avoid[n] = [...h.models];
  }
  return { buyers: chosen, avoid, hosting, reason, hostsKnown: !!snapshot?.hosts };
}

/**
 * Per-buyer charges from the load generator's summaries (one per machine), merged by name:
 * { name: { calls, ok, cSats, byModel: { model: { calls, cSats } }, ownCalls, ownCSats, servedSeen } }.
 */
export function chargesFrom(summaries) {
  const out = {};
  for (const s of summaries ?? []) {
    for (const u of s.users ?? []) {
      if (!u.money) continue;
      const e = (out[u.name] ??= { calls: 0, ok: 0, cSats: 0, byModel: {}, ownCalls: 0, ownCSats: 0, servedSeen: 0 });
      e.calls += u.money.calls ?? 0;
      e.ok += u.money.ok ?? 0;
      e.cSats += u.money.cSats ?? 0;
      e.ownCalls += u.money.ownCalls ?? 0;
      e.ownCSats += u.money.ownCSats ?? 0;
      e.servedSeen += u.money.servedSeen ?? 0;
      for (const [m, g] of Object.entries(u.money.byModel ?? {})) {
        const t = (e.byModel[m] ??= { calls: 0, cSats: 0 });
        t.calls += g.calls ?? 0;
        t.cSats += g.cSats ?? 0;
      }
    }
  }
  return out;
}

const modelKey = (id) => {
  const rest = id.startsWith("network/") ? id.slice(8) : id;
  const at = rest.lastIndexOf("@");
  return at > 0 ? rest.slice(0, at) : rest;
};

/**
 * The money report. before/after: ledger snapshots. charges: chargesFrom(...) (may be empty: then
 * buyers come from `buyers` and a buyer that also hosts cannot be split into debit and credit).
 *
 * - buyer debit: balance drop for a buyer that hosts nothing; for one that also hosts, the per-call
 *   charges (its balance moves both ways), and its credit is balance change + charges.
 * - host credit: balance rise of every keyed account whose agents were online (and of dual-role
 *   buyers, above). Hosts without a key (the owner's Macs) cannot be read: their implied credit is
 *   what the buyers paid less the fee less the readable credits.
 * - conservation: debits = host credits + fee, within rounding (the ledger keeps 3 decimals per row:
 *   tolerance 0.01 + 0.002 per call). A buyer whose balance fell more than its charges still has
 *   reserves held (calls not settled at the snapshot) or spent elsewhere; flagged.
 * - self-dealing: a buyer's charges on models its own agents hold (an upper bound: the API does not
 *   say which agent served a call), or the exact amount when replies carried served.own.
 */
export function moneyReport({ before, after, charges = {}, buyers = [], feeBps = NETWORK_FEE_BPS }) {
  const { byName, byId } = indexNames(before, after);
  const hostsB = before?.hosts ?? {}, hostsA = after?.hosts ?? {};
  const hostIds = new Set([...Object.keys(hostsB), ...Object.keys(hostsA)].filter((id) => (hostsB[id]?.connected ?? 0) + (hostsA[id]?.connected ?? 0) > 0));
  const hostModels = (id) => [...new Set([...(hostsB[id]?.models ?? []), ...(hostsA[id]?.models ?? [])])];
  const buyerNames = [...new Set([...buyers, ...Object.keys(charges).filter((n) => (charges[n]?.calls ?? 0) > 0)])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const totalCalls = buyerNames.reduce((a, n) => a + (charges[n]?.calls ?? 0), 0);
  const tol = r3(0.01 + 0.002 * totalCalls);
  const bal = (snap, n) => (typeof snap?.accounts?.[n]?.cSats === "number" ? snap.accounts[n].cSats : null);
  const delta = (n) => (bal(before, n) === null || bal(after, n) === null ? null : bal(after, n) - bal(before, n));
  const earned = (n) => {
    const a = before?.accounts?.[n]?.earnedSats, b = after?.accounts?.[n]?.earnedSats;
    return typeof a === "number" && typeof b === "number" ? b - a : null;
  };
  const flags = [];

  // Buyers.
  const buyerRows = buyerNames.map((name) => {
    const c = charges[name];
    const id = byName[name];
    const hosts = !!id && hostIds.has(id);
    const d = delta(name);
    const charged = c ? r3(c.cSats) : null;
    let debit = null, credit = 0, reserveGap = null;
    if (hosts) {
      debit = charged;
      credit = d !== null && charged !== null ? r3(d + charged) : null;
    } else if (d !== null) {
      debit = r3(-d);
      if (charged !== null) reserveGap = r3(debit - charged);
    } else debit = charged;
    // Self-dealing: exact when replies said so, else charges on models its own agents hold.
    const own = hosts ? hostModels(id) : [];
    const risk = c ? Object.entries(c.byModel ?? {}).filter(([m]) => m !== "auto" && own.includes(modelKey(m))).reduce((a, [, g]) => a + g.cSats, 0) : 0;
    const exact = (c?.servedSeen ?? 0) > 0 && (c?.servedSeen ?? 0) >= (c?.ok ?? 0);
    const selfDealt = r3(exact ? c.ownCSats : risk);
    if (reserveGap !== null && reserveGap > tol) flags.push({ kind: "buyer_debit_exceeds_charges", name, gap: reserveGap, note: "reserves still held (unsettled calls) or spending outside the run" });
    if (reserveGap !== null && reserveGap < -tol) flags.push({ kind: "buyer_debit_below_charges", name, gap: reserveGap, note: "a refund or top-up landed in the window" });
    if (hosts && credit !== null && credit < -tol) flags.push({ kind: "dual_role_negative_credit", name, credit, note: "its balance fell more than its charges: reserves held or other spending" });
    return { name, accountId: id ?? null, alsoHosts: hosts, calls: c?.calls ?? null, charged, balanceDelta: d === null ? null : r3(d), debit, creditAsHost: hosts ? credit : null, reserveGap, selfDealt, selfDealtExact: exact, earnedSatsDelta: earned(name) };
  });

  // Hosts we can read (keyed accounts with agents online), buyers that also host included above.
  const hostRows = [];
  for (const id of hostIds) {
    const name = byId[id];
    const models = hostModels(id);
    const classes = [...new Set([...(hostsB[id]?.classes ?? []), ...(hostsA[id]?.classes ?? [])])];
    const agents = Math.max(hostsB[id]?.connected ?? 0, hostsA[id]?.connected ?? 0);
    if (!name) { hostRows.push({ name: null, accountId: id, readable: false, agents, classes, models, credit: null }); continue; }
    const b = buyerRows.find((x) => x.name === name);
    const credit = b ? b.creditAsHost : delta(name) === null ? null : r3(delta(name));
    if (!b && credit !== null && credit < -tol) flags.push({ kind: "host_balance_fell", name, credit, note: "a host spent during the window (not from this run's buyers)" });
    hostRows.push({ name, accountId: id, readable: credit !== null, agents, classes, models, credit, alsoBuyer: !!b, earnedSatsDelta: earned(name) });
  }

  hostRows.sort((a, b) => (a.name === null) - (b.name === null) || String(a.name ?? a.accountId).localeCompare(String(b.name ?? b.accountId), "en", { numeric: true }));
  // Which models were bought, and could an unreadable host have served them?
  const bought = new Set(buyerNames.flatMap((n) => Object.keys(charges[n]?.byModel ?? {}).filter((m) => (charges[n].byModel[m].cSats ?? 0) > 0).map(modelKey)));
  const unreadable = hostRows.filter((h) => !h.readable).map((h) => ({ ...h, couldServe: h.models.some((m) => bought.has(m)) || bought.has("auto") }));

  const D = r3(buyerRows.reduce((a, b) => a + (b.debit ?? 0), 0));
  const C = r3(buyerRows.reduce((a, b) => a + (b.charged ?? 0), 0));
  const fee = r3((D * feeBps) / 10_000);
  const expectedHosts = r3(D - fee);
  const H = r3(hostRows.reduce((a, h) => a + (h.readable ? Math.max(0, h.credit ?? 0) : 0), 0));
  const S = r3(buyerRows.reduce((a, b) => a + b.selfDealt, 0));
  const unreadableCouldServe = unreadable.some((u) => u.couldServe);
  const residual = r3(expectedHosts - H);
  let conservation;
  if (!unreadableCouldServe) {
    const gap = r3(D - H - fee);
    const ok = Math.abs(gap) <= tol;
    conservation = { ok, gap, tolerance: tol, basis: "every host that could serve is readable: debits - host credits - fee" };
    if (!ok) flags.push({ kind: "conservation_gap", gap, note: gap > 0 ? "buyers paid more than hosts + fee received: reserves still held, or a host without a key served" : "hosts received more than buyers paid: other traffic paid them in the window" });
  } else {
    const ok = residual >= -tol;
    conservation = { ok, gap: residual, tolerance: tol, basis: "hosts without a key (e.g. the owner's machines) could serve: the gap is their implied credit, and must not be negative" };
    if (!ok) flags.push({ kind: "conservation_gap", gap: residual, note: "readable hosts received more than buyers paid less the fee: other traffic paid them in the window" });
  }
  return {
    feeBps, tolerance: tol,
    totals: {
      buyerDebits: D, perCallCharges: C, chargesVsDebits: r3(D - C),
      hostCreditsReadable: H, impliedFee: fee, impliedHostCredits: expectedHosts,
      impliedUnreadableHostCredits: unreadableCouldServe ? residual : 0,
      selfDealt: S, selfDealtNetCost: r3((S * feeBps) / 10_000), movedBetweenAccounts: r3(D - S),
    },
    conservation, buyers: buyerRows, hosts: hostRows, unreadableHosts: unreadable, flags,
    window: { from: before?.atMs ?? null, to: after?.atMs ?? null },
  };
}

/** Plain-text money report. */
export function formatMoney(m) {
  const f = (x) => (x === null || x === undefined ? "-" : Number(x).toFixed(3));
  const lines = [];
  const w = m.window;
  lines.push(`Money (cSats; 1 cSat = 1 sat; fee ${m.feeBps / 100}%)${w.from && w.to ? `, ${new Date(w.from).toISOString()} -> ${new Date(w.to).toISOString()}` : ""}:`);
  lines.push("  buyers:");
  for (const b of m.buyers) {
    lines.push(`    ${b.name.padEnd(5)} spent ${f(b.debit).padStart(10)}  (charges ${f(b.charged)}, ${b.calls ?? "?"} calls, balance ${b.balanceDelta === null ? "?" : f(b.balanceDelta)}${b.reserveGap !== null ? `, debit - charges ${f(b.reserveGap)}` : ""})${b.alsoHosts ? `  also hosts: earned ${f(b.creditAsHost)}` : ""}${b.selfDealt ? `  self-dealt ${f(b.selfDealt)}${b.selfDealtExact ? "" : " (upper bound)"}` : ""}`);
  }
  lines.push("  hosts:");
  for (const h of m.hosts) {
    const who = h.name ?? `${shortId(h.accountId)} (no key)`;
    lines.push(`    ${who.padEnd(20)} ${h.readable ? `earned ${f(h.credit).padStart(10)}` : "not readable".padStart(17)}  ${h.agents} agent(s) ${h.classes.join("/")}: ${h.models.join(", ") || "-"}${h.alsoBuyer ? "  (also a buyer)" : ""}`);
  }
  const t = m.totals;
  lines.push(`  buyer debits ${f(t.buyerDebits)} (per-call charges ${f(t.perCallCharges)}, difference ${f(t.chargesVsDebits)})`);
  lines.push(`  -> hosts ${f(t.impliedHostCredits)} (readable ${f(t.hostCreditsReadable)}, implied to hosts without a key ${f(t.impliedUnreadableHostCredits)}) + network fee ${f(t.impliedFee)}`);
  lines.push(`  self-dealt ${f(t.selfDealt)} (net cost to those accounts: the fee, ${f(t.selfDealtNetCost)}); moved between different accounts ${f(t.movedBetweenAccounts)}`);
  lines.push(`  conservation: ${m.conservation.ok ? "OK" : "GAP"} (gap ${f(m.conservation.gap)}, tolerance ${f(m.conservation.tolerance)}; ${m.conservation.basis})`);
  for (const x of m.flags) lines.push(`  FLAG ${x.kind}${x.name ? ` ${x.name}` : ""}: ${f(x.gap ?? x.credit)} - ${x.note}`);
  return lines.join("\n");
}

// Shared helpers for scripts/regtest-money-loop.mjs. Never prints tokens, keys, macaroons or passwords.
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PORTAL = process.env.ML_PORTAL ?? "https://edgecoder.io";
export const COORDS = { us: process.env.ML_COORD_US ?? "https://coordinator.edgecoder.io", eu: process.env.ML_COORD_EU ?? "https://coordinator-eu.edgecoder.io" };
export const SEEDS = { us: "edgecoder-seed", eu: "edgecoder-seed-eu" };
// ML_NETWORK=signet runs the loop against Mutinynet: the coordinators' node is edgecoder-lnd-signet
// (one machine, `lnc` wrapper) and the outside payer / payee is the Mutinynet faucet, called from
// inside that machine (deploy/lnd-signet/README.md, "Prove routing"). Default: regtest.
export const NETWORK = process.env.ML_NETWORK ?? "regtest";
if (!["regtest", "signet"].includes(NETWORK)) throw new Error(`ML_NETWORK must be regtest or signet, not ${NETWORK}`);
export const LND_APP = NETWORK === "signet" ? "edgecoder-lnd-signet" : "edgecoder-lnd-test";
/** Invoice prefix for this network (refuse anything else: it could be real money). */
export const INVOICE_RE = NETWORK === "signet" ? /^lntbs\d/i : /^lnbcrt\d/i;
export const LNURL_APP = process.env.ML_LNURL_APP ?? "edgecoder-regtest-lnurl";
export const LNURL_HOST = `${LNURL_APP}.fly.dev`;
const CFG = join(homedir(), ".config/edgecoder");
export const ACCOUNTS_DIR = process.env.ML_ACCOUNTS_DIR ?? join(CFG, "e2e/accounts");
const FORBIDDEN_APPS = new Set(["edgecoder-lnd"]); // mainnet node: never touched

export const readSecret = (path) => readFileSync(path, "utf8").trim();
export const adminToken = () => readSecret(join(CFG, "coordinator-admin-token"));
const flyEnv = () => ({ ...process.env, FLY_API_TOKEN: process.env.FLY_API_TOKEN ?? readSecret(join(CFG, "fly.token")) });

export function account(name) {
  const f = join(ACCOUNTS_DIR, `${name}.json`);
  if (!existsSync(f)) throw new Error(`no account file for ${name}`);
  return JSON.parse(readFileSync(f, "utf8"));
}
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fly(args, { input, timeoutMs = 300_000 } = {}) {
  const app = args[args.indexOf("-a") + 1];
  if (FORBIDDEN_APPS.has(app)) throw new Error(`refusing to touch ${app}`);
  return new Promise((resolve, reject) => {
    const p = execFile("fly", args, { env: flyEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`fly ${args.slice(0, 3).join(" ")} failed: ${String(stderr).split("\n").filter(Boolean).slice(-2).join(" | ")}`), { stdout }));
      else resolve(String(stdout));
    });
    if (input !== undefined) p.stdin.end(input);
  });
}

/** Last JSON line of remote output. */
export function lastJson(s) {
  const lines = String(s).split("\n").map((l) => l.trim()).filter((l) => /^[[{]/.test(l));
  if (!lines.length) throw new Error(`no JSON in output: ${String(s).slice(-300)}`);
  return JSON.parse(lines[lines.length - 1]);
}

const seedJs = () => readFileSync(join(HERE, "seed-query.mjs")).toString("base64");
/** Run seed-query.mjs inside a seed machine (machine env holds the tokens; nothing secret comes back). */
export async function seed(which, ...args) {
  const app = SEEDS[which] ?? which;
  const quoted = args.map((x) => `'${String(x).replace(/'/g, "")}'`).join(" ");
  const cmd = `sh -c "echo ${seedJs()} | base64 -d > /tmp/ml-seed.mjs && cd /app && node /tmp/ml-seed.mjs ${quoted}"`;
  return lastJson(await fly(["ssh", "console", "-a", app, "-q", "-C", cmd], { timeoutMs: 600_000 }));
}

let machineCache = {};
export async function lndMachine(group) {
  if (machineCache[group]) return machineCache[group];
  const list = JSON.parse(await fly(["machines", "list", "-a", LND_APP, "--json"]));
  const m = list.find((x) => x.config?.metadata?.fly_process_group === group);
  if (!m) throw new Error(`no ${group} machine`);
  return (machineCache[group] = m.id);
}
/** lncli on the regtest hub or payee node (edgecoder-lnd-test), or on signet the coordinators' node. */
export async function lncli(group, cmd) {
  if (NETWORK === "signet") {
    if (group !== "hub") throw new Error("signet has no payee node; the faucet pays and is paid (faucetPay / faucetInvoice)");
    return signetSh(`lnc ${cmd}`);
  }
  const m = await lndMachine(group);
  const outp = await fly(["ssh", "console", "-a", LND_APP, "--machine", m, "-q", "-C", `lncli --lnddir=/data --network=regtest ${cmd}`], { timeoutMs: 180_000 });
  return outp.split("\n").filter((l) => !l.startsWith("Connecting")).join("\n");
}

/** A command inside the signet node's machine (where the faucet calls run, as the README does). */
export async function signetSh(cmd) {
  if (NETWORK !== "signet") throw new Error("signet only");
  const outp = await fly(["ssh", "console", "-a", LND_APP, "-q", "-C", `sh -c '${cmd.replace(/'/g, "")}'`], { timeoutMs: 180_000 });
  return outp.split("\n").filter((l) => !l.startsWith("Connecting")).join("\n");
}
/** Signet: the Mutinynet faucet pays <bolt11> through its LNURL-withdraw (an outside payer). */
export async function faucetPay(bolt11) {
  if (!/^lntbs\d+[a-z0-9]+$/i.test(bolt11)) throw new Error("refusing to hand the faucet a non-signet invoice");
  const r = await signetSh(`k1=$(curl -sf https://faucet.mutinynet.com/api/lnurlw | jq -r .k1) && curl -sf "https://faucet.mutinynet.com/api/lnurlw/callback?k1=$k1&pr=${bolt11}"`);
  return lastJson(r);
}
/** Signet: an invoice from the Mutinynet faucet (an outside payee) for <sats>. */
export async function faucetInvoice(sats) {
  const r = await signetSh(`curl -sf -X POST https://faucet.mutinynet.com/api/bolt11 -H content-type:application/json -d {\\"amount_sats\\":${Math.floor(Number(sats))}}`);
  const bolt11 = lastJson(r).bolt11;
  if (!INVOICE_RE.test(bolt11 ?? "")) throw new Error("faucet returned no signet invoice");
  const d = JSON.parse(await lncli("hub", `decodepayreq ${bolt11}`));
  return { bolt11, hash: d.payment_hash };
}

export async function http(url, { method = "GET", headers = {}, body, timeoutMs = 120_000 } = {}) {
  const r = await fetch(url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text: json ? undefined : text.slice(0, 300) };
}
/**
 * An admin-token route on a coordinator. The coordinators refuse admin calls that arrive through the
 * public edge (src/common/admin-origin.ts), so the call runs inside the seed machine over loopback
 * (seed-query.mjs `admin`) with the machine's own ADMIN_API_TOKEN; no token leaves the machine.
 * Same { status, json } shape as http().
 */
export async function admin(which, path, opts = {}) {
  const body = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body)).toString("base64")];
  const r = await seed(which, "admin", opts.method ?? "GET", path, ...body);
  return { status: r.status, json: r.body ?? null };
}
export const api = (name, path, opts = {}) => http(PORTAL + path, { ...opts, headers: { authorization: `Bearer ${account(name).apiKey}`, ...(opts.headers ?? {}) } });

const sessions = {};
export async function session(name) {
  if (sessions[name]) return sessions[name];
  const a = account(name);
  const r = await http(PORTAL + "/auth/login", { method: "POST", headers: { origin: PORTAL }, body: { email: a.email, password: a.password } });
  if (r.status !== 200 || !r.json?.sessionToken) throw new Error(`login ${name}: ${r.status} ${r.json?.error ?? ""}`);
  return (sessions[name] = r.json.sessionToken);
}
export async function portal(name, path, opts = {}) {
  return http(PORTAL + path, { ...opts, headers: { authorization: `Bearer ${await session(name)}`, origin: PORTAL, ...(opts.headers ?? {}) } });
}
export const lnurlAdmin = (path, opts = {}) => {
  const env = readFileSync(process.env.ML_LNURL_TOKENS ?? join(CFG, "e2e/lnurl-tokens.env"), "utf8");
  const tok = /ADMIN_TOKEN=(\S+)/.exec(env)?.[1];
  return http(`https://${LNURL_HOST}${path}`, { ...opts, headers: { authorization: `Bearer ${tok}`, ...(opts.headers ?? {}) } });
};
export const hookUrl = () => {
  const env = readFileSync(process.env.ML_LNURL_TOKENS ?? join(CFG, "e2e/lnurl-tokens.env"), "utf8");
  return `https://${LNURL_HOST}/hook/${/HOOK_TOKEN=(\S+)/.exec(env)?.[1]}`;
};

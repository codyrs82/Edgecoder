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
export const LND_APP = "edgecoder-lnd-test";
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
/** lncli on the regtest hub or payee node (edgecoder-lnd-test). */
export async function lncli(group, cmd) {
  const m = await lndMachine(group);
  const outp = await fly(["ssh", "console", "-a", LND_APP, "--machine", m, "-q", "-C", `lncli --lnddir=/data --network=regtest ${cmd}`], { timeoutMs: 180_000 });
  return outp.split("\n").filter((l) => !l.startsWith("Connecting")).join("\n");
}

export async function http(url, { method = "GET", headers = {}, body, timeoutMs = 120_000 } = {}) {
  const r = await fetch(url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text: json ? undefined : text.slice(0, 300) };
}
export const admin = (which, path, opts = {}) => http(COORDS[which] + path, { ...opts, headers: { "x-admin-token": adminToken(), ...(opts.headers ?? {}) } });
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

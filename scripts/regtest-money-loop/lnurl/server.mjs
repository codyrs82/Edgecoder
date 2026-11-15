// Regtest-only test helper (not deployed with EdgeCoder). LNURL-pay (Lightning address) server and alert-webhook catcher for
// scripts/regtest-money-loop.mjs. Invoices come from the edgecoder-lnd-test payee node, so
// coordinator auto payouts to <name>@<this app> land on the payee. Never point this at mainnet.
//
//   GET  /.well-known/lnurlp/:name          LUD-16 pay request
//   GET  /lnurlp/:name/callback?amount=msat LUD-06 invoice; behaviour per name (mode):
//        ok (default) a normal invoice | cancel: invoice cancelled at once (payment fails, final)
//        hold: a hold invoice nobody settles (payment stays in flight until /admin/cancel-held)
//        error: LNURL error response
//   POST /hook/:token                       webhook catcher (body kept in memory)
//   GET  /admin/state, POST /admin/mode {name, mode}, POST /admin/cancel-held   (Bearer ADMIN_TOKEN)
// Env: PUBLIC_URL, PAYEE_REST_URL, PAYEE_MACAROON_HEX (invoices:read invoices:write),
//      PAYEE_TLS_CERT_BASE64, ADMIN_TOKEN, HOOK_TOKEN.
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const PUBLIC_URL = env("PUBLIC_URL").replace(/\/+$/, "");
const PAYEE = new URL(env("PAYEE_REST_URL"));
const MAC = env("PAYEE_MACAROON_HEX");
const CA = Buffer.from(env("PAYEE_TLS_CERT_BASE64"), "base64").toString("utf8");
const ADMIN = env("ADMIN_TOKEN");
const HOOK = env("HOOK_TOKEN");

const modes = new Map();
const invoices = [];
const hooks = [];
const held = new Map();

function lnd(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: PAYEE.hostname, port: PAYEE.port || 8080, path, method, ca: CA, servername: PAYEE.hostname, headers: { "Grpc-Metadata-macaroon": MAC, "content-type": "application/json" }, timeout: 15_000 },
      (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => {
          let j = {};
          try { j = JSON.parse(s || "{}"); } catch { j = { raw: s.slice(0, 200) }; }
          if (res.statusCode >= 300) reject(new Error(`lnd ${res.statusCode}: ${j.message ?? s.slice(0, 200)}`));
          else resolve(j);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("lnd timeout")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const metadataFor = (name) => JSON.stringify([["text/plain", `EdgeCoder regtest payee ${name}`], ["text/identifier", `${name}@${new URL(PUBLIC_URL).host}`]]);
const b64ToHex = (b) => Buffer.from(b, "base64").toString("hex");
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function callback(name, amountMsat) {
  const mode = modes.get(name) ?? "ok";
  if (mode === "error") return { status: "ERROR", reason: "regtest test destination refuses" };
  const descriptionHash = createHash("sha256").update(metadataFor(name), "utf8").digest("base64");
  let pr, hash;
  if (mode === "hold") {
    const pre = randomBytes(32);
    const h = createHash("sha256").update(pre).digest();
    const r = await lnd("POST", "/v2/invoices/hodl", { hash: h.toString("base64"), value_msat: String(amountMsat), description_hash: descriptionHash, expiry: "3600" });
    pr = r.payment_request;
    hash = h.toString("hex");
    held.set(hash, { name, amountMsat, at: Date.now() });
  } else {
    const r = await lnd("POST", "/v1/invoices", { value_msat: String(amountMsat), description_hash: descriptionHash, expiry: "600" });
    pr = r.payment_request;
    hash = b64ToHex(r.r_hash);
    if (mode === "cancel") await lnd("POST", "/v2/invoices/cancel", { payment_hash: r.r_hash });
  }
  invoices.push({ name, mode, amountMsat, paymentHash: hash, atMs: Date.now() });
  if (invoices.length > 2000) invoices.shift();
  return { pr, routes: [] };
}

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { if (s.length < 200_000) s += c; });
    req.on("end", () => resolve(s));
  });
}

http
  .createServer(async (req, res) => {
    try {
      const u = new URL(req.url, PUBLIC_URL);
      let m;
      if (req.method === "GET" && u.pathname === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && (m = /^\/\.well-known\/lnurlp\/([a-z0-9._-]{1,64})$/.exec(u.pathname))) {
        const name = m[1];
        return send(res, 200, { tag: "payRequest", callback: `${PUBLIC_URL}/lnurlp/${name}/callback`, minSendable: 1000, maxSendable: 100_000_000_000, metadata: metadataFor(name) });
      }
      if (req.method === "GET" && (m = /^\/lnurlp\/([a-z0-9._-]{1,64})\/callback$/.exec(u.pathname))) {
        const amount = Number(u.searchParams.get("amount"));
        if (!Number.isSafeInteger(amount) || amount < 1000) return send(res, 200, { status: "ERROR", reason: "bad amount" });
        return send(res, 200, await callback(m[1], amount));
      }
      if (req.method === "POST" && (m = /^\/hook\/([A-Za-z0-9_-]{8,128})$/.exec(u.pathname))) {
        if (!same(m[1], HOOK)) return send(res, 404, { error: "not_found" });
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { body = { raw: raw.slice(0, 2000) }; }
        hooks.push({ atMs: Date.now(), body });
        if (hooks.length > 500) hooks.shift();
        return send(res, 200, { ok: true });
      }
      if (u.pathname.startsWith("/admin/")) {
        const auth = String(req.headers.authorization ?? "");
        if (!same(auth, `Bearer ${ADMIN}`)) return send(res, 401, { error: "unauthorized" });
        if (req.method === "GET" && u.pathname === "/admin/state") {
          return send(res, 200, { modes: Object.fromEntries(modes), invoices, hooks, held: [...held.entries()].map(([h, v]) => ({ paymentHash: h, ...v })) });
        }
        if (req.method === "POST" && u.pathname === "/admin/mode") {
          const b = JSON.parse((await readBody(req)) || "{}");
          if (!/^[a-z0-9._-]{1,64}$/.test(b.name ?? "") || !["ok", "cancel", "hold", "error"].includes(b.mode)) return send(res, 400, { error: "bad_request" });
          modes.set(b.name, b.mode);
          return send(res, 200, { ok: true, modes: Object.fromEntries(modes) });
        }
        if (req.method === "POST" && u.pathname === "/admin/cancel-held") {
          const out = [];
          for (const h of [...held.keys()]) {
            try {
              await lnd("POST", "/v2/invoices/cancel", { payment_hash: Buffer.from(h, "hex").toString("base64") });
              held.delete(h);
              out.push({ paymentHash: h, cancelled: true });
            } catch (e) {
              out.push({ paymentHash: h, error: String(e.message ?? e) });
            }
          }
          return send(res, 200, { cancelled: out });
        }
      }
      send(res, 404, { error: "not_found" });
    } catch (e) {
      send(res, 200, { status: "ERROR", reason: String(e?.message ?? e).slice(0, 200) });
    }
  })
  .listen(8080, "::", () => console.log("regtest lnurl listening on 8080"));

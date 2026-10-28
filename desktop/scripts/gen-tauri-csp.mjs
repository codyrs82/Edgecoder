#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// #83: add the origins of VITE_COORDINATOR_URL and VITE_PORTAL_URL to the release CSP
// connect-src, so self-hosted builds can reach their own coordinator/portal, without widening
// connect-src to `https:`. Everything else in the policy is left exactly as in tauri.conf.json.
//
//   node scripts/gen-tauri-csp.mjs            -> writes src-tauri/tauri.csp.json
//   npx tauri build --config src-tauri/tauri.csp.json
//
// Rules: https origins are allowed; http only for loopback (127.0.0.1, localhost, [::1]).
// Anything else (other schemes, credentials in the URL, http to a remote host) fails the build.
// With no VITE_* hosts set the output CSP is identical to tauri.conf.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const HOST_VARS = ["VITE_COORDINATOR_URL", "VITE_PORTAL_URL"];

/** Origin to allow for one configured URL, or throw with the reason. */
export function allowedOrigin(name, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${raw}`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.origin;
  throw new Error(`${name} must be https (http only for loopback): ${url.origin}`);
}

/** connect-src with the VITE_* origins appended (deduplicated, base order kept). */
export function connectSrcWithHosts(baseConnectSrc, env = process.env) {
  const tokens = baseConnectSrc.split(/\s+/).filter(Boolean);
  for (const name of HOST_VARS) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const origin = allowedOrigin(name, raw);
    if (!tokens.includes(origin)) tokens.push(origin);
  }
  return tokens.join(" ");
}

/** Tauri --config merge patch carrying only the generated connect-src. */
export function cspOverride(conf, env = process.env) {
  const csp = conf?.app?.security?.csp;
  if (!csp || typeof csp !== "object" || typeof csp["connect-src"] !== "string") {
    throw new Error("tauri.conf.json app.security.csp must be a directive map with connect-src");
  }
  return { app: { security: { csp: { "connect-src": connectSrcWithHosts(csp["connect-src"], env) } } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  const out = cspOverride(conf);
  writeFileSync(resolve(root, "src-tauri/tauri.csp.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[gen-tauri-csp] connect-src: ${out.app.security.csp["connect-src"]}`);
}

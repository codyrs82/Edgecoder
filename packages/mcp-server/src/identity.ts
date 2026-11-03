// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The agent's identity: a secp256k1 (Nostr-style) key kept at ~/.edgecoder/agent-key (0600).
 * With no EDGECODER_API_KEY, the server signs up with that key (POST /agents/challenge, then
 * /agents/signup with a BIP-340 signature over sha256(challenge)) and keeps the API key it gets in
 * the same file. Signing up again with the key rotates the API key (the old one stops working).
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { Http } from "./http.js";

export interface AgentKeyFile {
  keyType: "secp256k1";
  secretKey: string;
  publicKey: string;
  /** The API key from the last signup and the portal it belongs to. */
  apiKey?: string;
  url?: string;
  accountId?: string;
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

export const defaultKeyPath = (env: NodeJS.ProcessEnv = process.env) => env.EDGECODER_AGENT_KEY_FILE || join(homedir(), ".edgecoder", "agent-key");

export function generateAgentKey(): AgentKeyFile {
  const { secretKey, publicKey } = schnorr.keygen();
  return { keyType: "secp256k1", secretKey: toHex(secretKey), publicKey: toHex(publicKey) };
}

export function loadOrCreateAgentKey(path: string): AgentKeyFile {
  if (existsSync(path)) {
    const k = JSON.parse(readFileSync(path, "utf8")) as AgentKeyFile;
    if (k.keyType !== "secp256k1" || !/^[0-9a-f]{64}$/.test(k.secretKey)) throw new Error(`${path} is not an EdgeCoder agent key`);
    return k;
  }
  const k = generateAgentKey();
  saveAgentKey(path, k);
  return k;
}

export function saveAgentKey(path: string, k: AgentKeyFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(k, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** BIP-340 signature over sha256(utf8(challenge)), as the portal checks it. */
export function signChallenge(secretKeyHex: string, challenge: string): string {
  const msg = new Uint8Array(createHash("sha256").update(challenge, "utf8").digest());
  return toHex(schnorr.sign(msg, fromHex(secretKeyHex)));
}

/** Challenge, sign, sign up: a new account the first time, a rotated API key after that. */
export async function signUp(http: Http, key: AgentKeyFile, name?: string): Promise<{ apiKey: string; accountId: string; created: boolean }> {
  const c = await http("POST", "/agents/challenge", { keyType: key.keyType, publicKey: key.publicKey });
  if (c.status !== 200 || typeof c.json?.challenge !== "string") throw new Error(`agent challenge failed (${c.status}): ${JSON.stringify(c.json)}`);
  const s = await http("POST", "/agents/signup", {
    keyType: key.keyType,
    publicKey: key.publicKey,
    nonce: c.json.nonce,
    signature: signChallenge(key.secretKey, c.json.challenge),
    ...(name ? { name } : {}),
  });
  if (s.status !== 200 || typeof s.json?.apiKey !== "string") throw new Error(`agent signup failed (${s.status}): ${JSON.stringify(s.json)}`);
  return { apiKey: s.json.apiKey, accountId: s.json.accountId, created: Boolean(s.json.created) };
}

/**
 * Where the API key comes from: EDGECODER_API_KEY when set (never re-signed-up), else the key
 * file's stored key for this portal, signing up when there is none or the portal refuses it.
 */
export function apiKeySource(opts: { http: Http; url: string; envKey?: string; keyPath: string; name?: string }) {
  if (opts.envKey) {
    const key = opts.envKey;
    return { current: async () => key, renew: undefined };
  }
  let cached: string | undefined;
  const renew = async () => {
    const k = loadOrCreateAgentKey(opts.keyPath);
    const r = await signUp(opts.http, k, opts.name);
    saveAgentKey(opts.keyPath, { ...k, apiKey: r.apiKey, url: opts.url, accountId: r.accountId });
    cached = r.apiKey;
    return r.apiKey;
  };
  const current = async () => {
    if (cached) return cached;
    const k = loadOrCreateAgentKey(opts.keyPath);
    if (k.apiKey && k.url === opts.url) return (cached = k.apiKey);
    return renew();
  };
  return { current, renew };
}

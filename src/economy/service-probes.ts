// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP, Socket } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { BitcoinNetwork } from "../common/types.js";
import { publicKeyFingerprint } from "../security/key-fingerprint.js";

/*
 * Network probes the coordinator uses to attest an infrastructure host's services before they
 * count in its fee-pool weight (src/economy/host-attestation.ts). Each probe speaks enough of the
 * service's own protocol that an open port alone does not pass:
 *
 *   coordinator  GET /identity returns the heartbeat's hostId and the key that signed it
 *   bitcoind     Bitcoin P2P: our `version` is answered by a `version` with the chain's magic
 *   lightning    BOLT 8 acts one and two against the declared node id: only the holder of that
 *                node key can produce act two (we then hang up before act three)
 *   electrs      Electrum protocol `server.version` returns a result
 *
 * No dependency beyond node:crypto and @noble/curves (already used for Nostr).
 */

export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/* ------------------------------------------------------------------ */
/*  TCP helper                                                         */
/* ------------------------------------------------------------------ */

/**
 * Connect, send `hello`, and feed received bytes to `onData` until it returns a result (or the
 * timeout / connection end). Always destroys the socket.
 */
export function tcpExchange(
  host: string,
  port: number,
  hello: Buffer,
  onData: (received: Buffer) => ProbeResult | null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: "timeout" }), timeoutMs);
    timer.unref?.();
    socket.once("error", (err) => finish({ ok: false, detail: `connect_error:${(err as NodeJS.ErrnoException).code ?? err.message}` }));
    socket.once("close", () => finish({ ok: false, detail: "closed_before_answer" }));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1 << 20) return finish({ ok: false, detail: "oversized_answer" });
      const r = onData(buf);
      if (r) finish(r);
    });
    socket.connect(port, host, () => socket.write(hello));
  });
}

/* ------------------------------------------------------------------ */
/*  Address policy                                                     */
/* ------------------------------------------------------------------ */

/** Loopback, private, link-local, CGNAT, unique-local and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb");
  }
  return true;
}

/**
 * Resolve a host for probing. Private addresses are refused unless allowed (local test networks),
 * so a peer cannot point the coordinator's probes at its own internal services.
 */
export async function resolveProbeTarget(host: string, allowPrivate: boolean): Promise<{ ok: true; address: string } | { ok: false; detail: string }> {
  let address = host;
  if (!isIP(host)) {
    try {
      address = (await lookup(host)).address;
    } catch {
      return { ok: false, detail: "dns_lookup_failed" };
    }
  }
  if (!allowPrivate && isPrivateAddress(address)) return { ok: false, detail: "private_address" };
  return { ok: true, address };
}

/* ------------------------------------------------------------------ */
/*  Bitcoin P2P                                                        */
/* ------------------------------------------------------------------ */

const BITCOIN_MAGIC: Record<BitcoinNetwork | "regtest", string> = {
  bitcoin: "f9beb4d9",
  testnet: "0b110907",
  signet: "0a03cf40",
  regtest: "fabfb5da"
};

export const BITCOIN_P2P_PORT: Record<BitcoinNetwork | "regtest", number> = { bitcoin: 8333, testnet: 18333, signet: 38333, regtest: 18444 };

function sha256d(b: Buffer): Buffer {
  return createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
}

function netAddr(): Buffer {
  const b = Buffer.alloc(26);
  b.writeBigUInt64LE(0n, 0);
  Buffer.from("00000000000000000000ffff7f000001", "hex").copy(b, 8);
  b.writeUInt16BE(0, 24);
  return b;
}

export function bitcoinMessage(network: BitcoinNetwork | "regtest", command: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from(BITCOIN_MAGIC[network], "hex").copy(header, 0);
  header.write(command, 4, 12, "ascii");
  header.writeUInt32LE(payload.length, 16);
  sha256d(payload).copy(header, 20, 0, 4);
  return Buffer.concat([header, payload]);
}

export function bitcoinVersionPayload(nowMs = Date.now()): Buffer {
  const ua = Buffer.from("/edgecoder-probe:1/", "ascii");
  const head = Buffer.alloc(20);
  head.writeInt32LE(70016, 0);
  head.writeBigUInt64LE(0n, 4); // services: none
  head.writeBigInt64LE(BigInt(Math.floor(nowMs / 1000)), 12);
  const tail = Buffer.alloc(8 + 1 + ua.length + 4 + 1);
  randomBytes(8).copy(tail, 0);
  tail.writeUInt8(ua.length, 8);
  ua.copy(tail, 9);
  tail.writeInt32LE(0, 9 + ua.length); // start height
  tail.writeUInt8(0, 13 + ua.length); // relay: no
  return Buffer.concat([head, netAddr(), netAddr(), tail]);
}

/** Decide on the bytes received so far: null while a full message header + payload is pending. */
export function checkBitcoinVersionReply(network: BitcoinNetwork | "regtest", received: Buffer): ProbeResult | null {
  if (received.length < 24) return null;
  if (received.subarray(0, 4).toString("hex") !== BITCOIN_MAGIC[network]) return { ok: false, detail: "wrong_network_magic" };
  const command = received.subarray(4, 16).toString("ascii").replace(/\0+$/, "");
  const length = received.readUInt32LE(16);
  if (length > 1_000) return { ok: false, detail: "bad_version_length" };
  if (received.length < 24 + length) return null;
  const payload = received.subarray(24, 24 + length);
  if (!sha256d(payload).subarray(0, 4).equals(received.subarray(20, 24))) return { ok: false, detail: "bad_checksum" };
  if (command !== "version") return { ok: false, detail: `unexpected_command:${command}` };
  if (payload.length < 80 || payload.readInt32LE(0) < 70001) return { ok: false, detail: "bad_version_payload" };
  return { ok: true, detail: `protocol ${payload.readInt32LE(0)}` };
}

export function probeBitcoind(host: string, port: number, network: BitcoinNetwork | "regtest", timeoutMs?: number): Promise<ProbeResult> {
  return tcpExchange(host, port, bitcoinMessage(network, "version", bitcoinVersionPayload()), (b) => checkBitcoinVersionReply(network, b), timeoutMs);
}

/* ------------------------------------------------------------------ */
/*  Lightning: BOLT 8 acts one and two                                 */
/* ------------------------------------------------------------------ */

const NOISE_PROTOCOL = "Noise_XK_secp256k1_ChaChaPoly_SHA256";
const NOISE_PROLOGUE = "lightning";

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();

function noiseHkdf(salt: Buffer, ikm: Buffer): [Buffer, Buffer] {
  const okm = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.alloc(0), 64));
  return [okm.subarray(0, 32), okm.subarray(32)];
}

/** BOLT 8 ECDH: sha256 of the compressed shared point. */
function noiseEcdh(priv: Uint8Array, pub: Buffer): Buffer {
  return sha256(Buffer.from(secp256k1.getSharedSecret(priv, pub, true)));
}

function chachaNonce(n: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(BigInt(n), 4);
  return nonce;
}

export function noiseEncrypt(key: Buffer, n: number, ad: Buffer, plaintext: Buffer): Buffer {
  const c = createCipheriv("chacha20-poly1305", key, chachaNonce(n), { authTagLength: 16 });
  c.setAAD(ad, { plaintextLength: plaintext.length });
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

export function noiseDecrypt(key: Buffer, n: number, ad: Buffer, ciphertext: Buffer): Buffer | null {
  try {
    const d = createDecipheriv("chacha20-poly1305", key, chachaNonce(n), { authTagLength: 16 });
    d.setAAD(ad, { plaintextLength: ciphertext.length - 16 });
    d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

/** Initial handshake hash and chaining key for a responder static key (both sides compute this). */
export function noiseInit(responderStatic: Buffer): { h: Buffer; ck: Buffer } {
  const h0 = sha256(Buffer.from(NOISE_PROTOCOL, "ascii"));
  const ck = h0;
  const h = sha256(sha256(h0, Buffer.from(NOISE_PROLOGUE, "ascii")), responderStatic);
  return { h, ck };
}

export function isLightningNodeId(value: string | undefined): value is string {
  return typeof value === "string" && /^0[23][0-9a-f]{64}$/i.test(value);
}

/** Act one for `nodeId`; returns the 50-byte message and the state needed to check act two. */
export function bolt8ActOne(nodeId: string, ephemeralPriv: Uint8Array = secp256k1.utils.randomSecretKey()) {
  const rs = Buffer.from(nodeId, "hex");
  let { h, ck } = noiseInit(rs);
  const ePub = Buffer.from(secp256k1.getPublicKey(ephemeralPriv, true));
  h = sha256(h, ePub);
  const [ck1, tempK1] = noiseHkdf(ck, noiseEcdh(ephemeralPriv, rs));
  const c = noiseEncrypt(tempK1, 0, h, Buffer.alloc(0));
  h = sha256(h, c);
  return { message: Buffer.concat([Buffer.from([0]), ePub, c]), state: { h, ck: ck1, ephemeralPriv } };
}

/** Act two verifies only if the responder holds the node key (its chaining key includes es). */
export function bolt8CheckActTwo(state: { h: Buffer; ck: Buffer; ephemeralPriv: Uint8Array }, act2: Buffer): ProbeResult {
  if (act2.length < 50) return { ok: false, detail: "short_act_two" };
  if (act2[0] !== 0) return { ok: false, detail: "bad_handshake_version" };
  const re = act2.subarray(1, 34);
  const c = act2.subarray(34, 50);
  let ee: Buffer;
  try {
    ee = noiseEcdh(state.ephemeralPriv, re);
  } catch {
    return { ok: false, detail: "bad_responder_ephemeral" };
  }
  const h = sha256(state.h, re);
  const [, tempK2] = noiseHkdf(state.ck, ee);
  return noiseDecrypt(tempK2, 0, h, c) ? { ok: true, detail: "bolt8_act_two_valid" } : { ok: false, detail: "act_two_mac_invalid" };
}

export function probeLightning(host: string, port: number, nodeId: string, timeoutMs?: number): Promise<ProbeResult> {
  if (!isLightningNodeId(nodeId)) return Promise.resolve({ ok: false, detail: "no_node_id" });
  const { message, state } = bolt8ActOne(nodeId.toLowerCase());
  return tcpExchange(host, port, message, (b) => (b.length >= 50 ? bolt8CheckActTwo(state, b.subarray(0, 50)) : null), timeoutMs);
}

/* ------------------------------------------------------------------ */
/*  Electrum (electrs)                                                 */
/* ------------------------------------------------------------------ */

export function probeElectrum(host: string, port: number, timeoutMs?: number): Promise<ProbeResult> {
  const req = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server.version", params: ["edgecoder-probe", "1.4"] }) + "\n");
  return tcpExchange(
    host,
    port,
    req,
    (b) => {
      const nl = b.indexOf(0x0a);
      if (nl < 0) return null;
      try {
        const msg = JSON.parse(b.subarray(0, nl).toString("utf8")) as { id?: unknown; result?: unknown };
        return msg.id === 1 && Array.isArray(msg.result) ? { ok: true, detail: String(msg.result[0] ?? "") } : { ok: false, detail: "electrum_error" };
      } catch {
        return { ok: false, detail: "electrum_bad_json" };
      }
    },
    timeoutMs
  );
}

/* ------------------------------------------------------------------ */
/*  Coordinator identity                                               */
/* ------------------------------------------------------------------ */

export type IdentityFetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The host's /identity must name `hostId` with the key its heartbeat was signed with. */
export async function probeCoordinatorIdentity(
  coordinatorUrl: string,
  hostId: string,
  publicKeyPem: string,
  fetcher: IdentityFetcher = globalThis.fetch as IdentityFetcher,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<ProbeResult> {
  try {
    const res = await fetcher(`${coordinatorUrl.replace(/\/+$/, "")}/identity`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, detail: `identity_http_${res.status}` };
    const body = (await res.json()) as { peerId?: unknown; publicKeyPem?: unknown };
    if (body?.peerId !== hostId || typeof body.publicKeyPem !== "string") return { ok: false, detail: "identity_peer_mismatch" };
    return publicKeyFingerprint(body.publicKeyPem) === publicKeyFingerprint(publicKeyPem) ? { ok: true } : { ok: false, detail: "identity_key_mismatch" };
  } catch (err) {
    return { ok: false, detail: `identity_unreachable:${err instanceof Error ? err.name : "error"}` };
  }
}

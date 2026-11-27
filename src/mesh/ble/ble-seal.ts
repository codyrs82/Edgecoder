// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Sealed BLE requests (edgecoder-ble-seal/v1): a prompt that only the device whose key the user
 * pinned can read, and a reply only that device can have written. BLE itself is not encrypted and a
 * device's agent id is self-asserted, so this is what keeps a bot's prompt off any other radio.
 *
 * Each device has a static X25519 "seal key", derived from its agent signing key (so it stays the
 * same across restarts) and published in its BLE identity characteristic as `sealKey` (base64 of the
 * 32 raw bytes). The user pins that key when they allow the device (ble-offline-consent.ts).
 *
 * Wire format (the iOS app implements the same in Swift, BLESeal.swift):
 *   R = responder's static key (pinned), S = requester's static key, E = a fresh ephemeral key
 *   ikm  = X25519(E, R) || X25519(S, R)                         (64 bytes)
 *   salt = E.pub || S.pub || R.pub                              (96 bytes)
 *   kReq = HKDF-SHA256(ikm, salt, "edgecoder-ble-seal/v1 request", 32)
 *   kRep = HKDF-SHA256(ikm, salt, "edgecoder-ble-seal/v1 reply", 32)
 *   request: AES-256-GCM(kReq, random 12-byte nonce, JSON {task, issuedAtMs},
 *            aad "edgecoder-ble-seal/v1|<requestId>|<requesterId>")
 *   reply:   AES-256-GCM(kRep, random 12-byte nonce, JSON {status, output, cpuSeconds},
 *            aad "edgecoder-ble-seal/v1 reply|<requestId>")
 *   messages: {type:"sealed_task", v:1, requestId, requesterId, epk, spk, rpk, nonce, ct}
 *             {type:"sealed_result", v:1, requestId, providerId, nonce, ct}   (ct = ciphertext || 16-byte tag, base64)
 *
 * Only the holder of R's private key can open the request, and only the holder of R or of S and E
 * can write a reply that opens with kRep, so a valid reply proves the pinned device answered. The
 * static-static term also proves to the responder that the requester holds S (used by a Mac to admit
 * requests from devices on its own allowlist without a mesh token).
 */

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

export const BLE_SEAL_VERSION = 1;
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export interface SealKeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface SealedTaskMessage {
  type: "sealed_task";
  v: 1;
  requestId: string;
  requesterId: string;
  /** Ephemeral, requester static and responder static public keys (base64, 32 bytes each). */
  epk: string;
  spk: string;
  rpk: string;
  nonce: string;
  ct: string;
}

export interface SealedResultMessage {
  type: "sealed_result";
  v: 1;
  requestId: string;
  providerId: string;
  nonce: string;
  ct: string;
}

export interface SealedResultBody {
  status: "completed" | "failed";
  output: string;
  cpuSeconds: number;
}

function publicOf(privateRaw: Buffer): Buffer {
  const priv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privateRaw]), format: "der", type: "pkcs8" });
  return createPublicKey(priv).export({ type: "spki", format: "der" }).subarray(-32);
}

function dh(privateRaw: Buffer, publicRaw: Buffer): Buffer {
  return diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privateRaw]), format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, publicRaw]), format: "der", type: "spki" }),
  });
}

/** This device's seal key, derived from its agent signing key (Ed25519 PEM), so it never changes. */
export function bleSealKeyPairFromPem(privateKeyPem: string): SealKeyPair {
  const der = createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "der" });
  const privateKey = Buffer.from(hkdfSync("sha256", der, "edgecoder-ble-seal-key", "edgecoder-ble-seal-key/v1", 32));
  return { privateKey, publicKey: publicOf(privateKey) };
}

/** A seal key pair from its 32 raw private bytes. */
export function sealKeyPairFromPrivate(privateKey: Buffer): SealKeyPair {
  return { privateKey, publicKey: publicOf(privateKey) };
}

export function generateSealKeyPair(): SealKeyPair {
  const { privateKey } = generateKeyPairSync("x25519");
  const raw = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  return { privateKey: Buffer.from(raw), publicKey: publicOf(Buffer.from(raw)) };
}

/** A base64 seal key as 32 raw bytes, or null when it isn't one. */
export function parseSealKey(b64: unknown): Buffer | null {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) return null;
  const raw = Buffer.from(b64, "base64");
  return raw.length === 32 ? raw : null;
}

function keys(ikm: Buffer, salt: Buffer): { req: Buffer; rep: Buffer } {
  return {
    req: Buffer.from(hkdfSync("sha256", ikm, salt, "edgecoder-ble-seal/v1 request", 32)),
    rep: Buffer.from(hkdfSync("sha256", ikm, salt, "edgecoder-ble-seal/v1 reply", 32)),
  };
}

function seal(key: Buffer, plaintext: Buffer, aad: string, fixedNonce?: Buffer): { nonce: string; ct: string } {
  const nonce = fixedNonce ?? randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString("base64"), ct: ct.toString("base64") };
}

function open(key: Buffer, nonceB64: unknown, ctB64: unknown, aad: string): Buffer {
  if (typeof nonceB64 !== "string" || typeof ctB64 !== "string") throw new Error("seal_malformed");
  const nonce = Buffer.from(nonceB64, "base64");
  const all = Buffer.from(ctB64, "base64");
  if (nonce.length !== 12 || all.length < 16) throw new Error("seal_malformed");
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
}

const requestAad = (requestId: string, requesterId: string) => `edgecoder-ble-seal/v1|${requestId}|${requesterId}`;
const replyAad = (requestId: string) => `edgecoder-ble-seal/v1 reply|${requestId}`;

/** Requester: seal `task` to the pinned responder key. Keep `replyKey` to open the answer. */
export function sealBleTask(o: { responderKey: Buffer; sender: SealKeyPair; requestId: string; requesterId: string; task: string; issuedAtMs: number; ephemeral?: SealKeyPair; nonce?: Buffer }): { message: SealedTaskMessage; replyKey: Buffer } {
  const e = o.ephemeral ?? generateSealKeyPair();
  const ikm = Buffer.concat([dh(e.privateKey, o.responderKey), dh(o.sender.privateKey, o.responderKey)]);
  const k = keys(ikm, Buffer.concat([e.publicKey, o.sender.publicKey, o.responderKey]));
  const body = seal(k.req, Buffer.from(JSON.stringify({ task: o.task, issuedAtMs: o.issuedAtMs }), "utf8"), requestAad(o.requestId, o.requesterId), o.nonce);
  return {
    message: { type: "sealed_task", v: 1, requestId: o.requestId, requesterId: o.requesterId, epk: e.publicKey.toString("base64"), spk: o.sender.publicKey.toString("base64"), rpk: o.responderKey.toString("base64"), ...body },
    replyKey: k.rep,
  };
}

export class BleSealError extends Error {
  constructor(readonly reason: "seal_malformed" | "key_mismatch" | "seal_invalid") {
    super(reason);
  }
}

/** Responder: open a sealed request with this device's seal key. Throws BleSealError. */
export function openBleTask(msg: unknown, own: SealKeyPair): { requestId: string; requesterId: string; senderKey: Buffer; task: string; issuedAtMs: number; replyKey: Buffer } {
  const m = (msg ?? {}) as Partial<SealedTaskMessage>;
  if (m.type !== "sealed_task" || m.v !== 1 || typeof m.requestId !== "string" || typeof m.requesterId !== "string") throw new BleSealError("seal_malformed");
  const epk = parseSealKey(m.epk);
  const spk = parseSealKey(m.spk);
  const rpk = parseSealKey(m.rpk);
  if (!epk || !spk || !rpk) throw new BleSealError("seal_malformed");
  if (!rpk.equals(own.publicKey)) throw new BleSealError("key_mismatch");
  let plain: Buffer;
  let k: { req: Buffer; rep: Buffer };
  try {
    k = keys(Buffer.concat([dh(own.privateKey, epk), dh(own.privateKey, spk)]), Buffer.concat([epk, spk, rpk]));
    plain = open(k.req, m.nonce, m.ct, requestAad(m.requestId, m.requesterId));
  } catch {
    throw new BleSealError("seal_invalid");
  }
  let body: { task?: unknown; issuedAtMs?: unknown };
  try {
    body = JSON.parse(plain.toString("utf8")) as typeof body;
  } catch {
    throw new BleSealError("seal_malformed");
  }
  if (typeof body.task !== "string" || typeof body.issuedAtMs !== "number" || !Number.isFinite(body.issuedAtMs)) throw new BleSealError("seal_malformed");
  return { requestId: m.requestId, requesterId: m.requesterId, senderKey: spk, task: body.task, issuedAtMs: body.issuedAtMs, replyKey: k.rep };
}

/** Responder: the sealed answer. */
export function sealBleResult(replyKey: Buffer, requestId: string, providerId: string, body: SealedResultBody, nonce?: Buffer): SealedResultMessage {
  return { type: "sealed_result", v: 1, requestId, providerId, ...seal(replyKey, Buffer.from(JSON.stringify(body), "utf8"), replyAad(requestId), nonce) };
}

/**
 * Requester: the answer, only when it is a sealed result for this request that opens with the reply
 * key (so it came from the pinned device). Anything else, including a plain-text reply, is null.
 */
export function openBleResult(msg: unknown, replyKey: Buffer, requestId: string): SealedResultBody | null {
  const m = (msg ?? {}) as Partial<SealedResultMessage>;
  if (m.type !== "sealed_result" || m.v !== 1 || m.requestId !== requestId) return null;
  try {
    const body = JSON.parse(open(replyKey, m.nonce, m.ct, replyAad(requestId)).toString("utf8")) as Partial<SealedResultBody>;
    if (body.status !== "completed" && body.status !== "failed") return null;
    return { status: body.status, output: typeof body.output === "string" ? body.output : "", cpuSeconds: typeof body.cpuSeconds === "number" ? body.cpuSeconds : 0 };
  } catch {
    return null;
  }
}

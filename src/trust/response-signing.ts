// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { Transform, type Readable } from "node:stream";

/*
 * Signed coordinator responses. The identity challenge (identity-challenge.ts) proves the
 * coordinator holds its key; this authenticates every response an agent acts on afterwards.
 *
 * The agent sends a fresh `x-agent-nonce` with each request. When a request carries one, the
 * coordinator signs its response with its Ed25519 identity key over
 *
 *   edgecoder-coord-response:v1 \n METHOD \n path?query \n status \n sha256(body bytes) \n
 *   agentId \n nonce \n timestampMs \n coordinatorPeerId
 *
 * and sends the signature in headers, so bodies are unchanged:
 *   x-coord-sig   base64 Ed25519 signature
 *   x-coord-ts    coordinator time (ms) included in the signed string
 *   x-coord-peer  coordinator peerId included in the signed string
 *
 * `agentId` is the `x-agent-id` request header (the signed-request identity), or "" when absent.
 * The nonce binds the response to one request, so an old response cannot be replayed.
 *
 * Streaming bodies (a route that replies with a stream) cannot be hashed before the headers go
 * out. They are signed in an HTTP trailer: the head carries x-coord-ts / x-coord-peer and
 * `Trailer: x-coord-sig`; the body streams unchanged through a hashing pass-through, and when it
 * ends the coordinator signs the same canonical string over the hash of every byte sent and
 * emits it as the `x-coord-sig` trailer. The agent buffers the body and acts on none of it until
 * the trailer verifies. A proxy that drops trailers makes the response unsigned, which fails
 * closed (refused when signatures are required).
 */

export const RESPONSE_SIGNING_VERSION = 1;
export const RESPONSE_SIG_HEADER = "x-coord-sig";
export const RESPONSE_TS_HEADER = "x-coord-ts";
export const RESPONSE_PEER_HEADER = "x-coord-peer";
export const AGENT_NONCE_HEADER = "x-agent-nonce";
const DOMAIN = "edgecoder-coord-response:v1";
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const AGENT_ID_RE = /^[^\r\n]{0,256}$/;

export interface ResponseSigningFields {
  method: string;
  /** Request path including the query string, exactly as sent. */
  path: string;
  status: number;
  bodySha256: string;
  agentId: string;
  nonce: string;
  timestampMs: string;
  peerId: string;
}

export function newAgentNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function isValidAgentNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_RE.test(value);
}

export function sha256Hex(body: string | Buffer | Uint8Array | null | undefined): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

/** The exact string the coordinator signs. */
export function responseSigningPayload(f: ResponseSigningFields): string {
  return [DOMAIN, f.method.toUpperCase(), f.path, String(f.status), f.bodySha256, f.agentId, f.nonce, f.timestampMs, f.peerId].join("\n");
}

// Parsed keys, so each response costs one Ed25519 operation and no PEM parsing.
const keyCache = new Map<string, KeyObject>();
function cachedKey(pem: string, kind: "private" | "public"): KeyObject {
  const id = `${kind}:${pem}`;
  let key = keyCache.get(id);
  if (!key) {
    key = kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
    if (keyCache.size > 64) keyCache.clear();
    keyCache.set(id, key);
  }
  return key;
}

export function signCoordinatorResponse(f: ResponseSigningFields, privateKeyPem: string): string {
  return sign(null, Buffer.from(responseSigningPayload(f)), cachedKey(privateKeyPem, "private")).toString("base64");
}

function verifySignature(payload: string, signature: string, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(payload), cachedKey(publicKeyPem, "public"), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Coordinator side: Fastify onSend hook                              */
/* ------------------------------------------------------------------ */

interface HookRequest {
  method: string;
  url: string;
  raw?: { url?: string };
  headers: Record<string, string | string[] | undefined>;
}
interface HookReply {
  statusCode: number;
  header(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
  raw: { addTrailers(headers: Record<string, string>): void };
}
interface HookApp {
  addHook(name: "onSend", fn: (req: any, reply: any, payload: any) => Promise<unknown>): unknown;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function isReadable(payload: unknown): payload is Readable {
  return !!payload && typeof (payload as Readable).pipe === "function" && typeof (payload as Readable).on === "function";
}

/**
 * Sign every response to a request that carries a valid `x-agent-nonce` (agents send one on
 * every coordinator call). Requests without it (portal, browsers, peers) are untouched.
 */
export function registerResponseSigning(
  app: HookApp,
  self: { peerId: string; privateKeyPem: string },
  now: () => number = Date.now
): void {
  app.addHook("onSend", async (req: HookRequest, reply: HookReply, payload: unknown) => {
    const nonce = headerValue(req.headers[AGENT_NONCE_HEADER]);
    if (!isValidAgentNonce(nonce)) return payload;
    const rawAgentId = headerValue(req.headers["x-agent-id"]) ?? "";
    const agentId = AGENT_ID_RE.test(rawAgentId) ? rawAgentId : "";
    const base = {
      method: req.method,
      path: req.raw?.url ?? req.url,
      agentId,
      nonce,
      timestampMs: String(now()),
      peerId: self.peerId
    };
    reply.header(RESPONSE_TS_HEADER, base.timestampMs);
    reply.header(RESPONSE_PEER_HEADER, self.peerId);

    if (isReadable(payload)) {
      // Chunked transfer with a declared trailer. The signature is added in flush(), after the
      // last chunk and before the stream ends, so it is in place when Fastify's pipe ends the
      // response (Fastify's own reply.trailer() runs a tick too late for piped streams).
      reply.removeHeader("content-length");
      reply.header("transfer-encoding", "chunked");
      reply.header("trailer", RESPONSE_SIG_HEADER);
      const hash = createHash("sha256");
      const hashing = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
        flush(cb) {
          try {
            const sig = signCoordinatorResponse({ ...base, status: reply.statusCode, bodySha256: hash.digest("hex") }, self.privateKeyPem);
            reply.raw.addTrailers({ [RESPONSE_SIG_HEADER]: sig });
            cb();
          } catch (err) {
            cb(err as Error);
          }
        }
      });
      payload.on("error", (err) => hashing.destroy(err));
      payload.pipe(hashing);
      return hashing;
    }

    const bytes = payload === null || payload === undefined ? "" : typeof payload === "string" || Buffer.isBuffer(payload) ? payload : String(payload);
    reply.header(RESPONSE_SIG_HEADER, signCoordinatorResponse({ ...base, status: reply.statusCode, bodySha256: sha256Hex(bytes) }, self.privateKeyPem));
    return payload;
  });
}

/* ------------------------------------------------------------------ */
/*  Agent side                                                         */
/* ------------------------------------------------------------------ */

export type ResponseVerifyError =
  | "response_unsigned"
  | "response_peer_mismatch"
  | "response_malformed"
  | "response_bad_signature";

export interface ResponseToVerify {
  method: string;
  path: string;
  status: number;
  body: string | Buffer;
  headers: Record<string, unknown>;
  /** Trailers, for a streamed response. */
  trailers?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

/**
 * Check one response against the request we sent (its nonce and agentId) and the pinned,
 * challenge-verified coordinator key. The signature may arrive as a header or a trailer.
 */
export function verifyCoordinatorResponse(
  res: ResponseToVerify,
  sent: { nonce: string; agentId: string },
  expected: { peerId: string; publicKeyPem: string }
): { ok: true } | { ok: false; error: ResponseVerifyError } {
  const sig = str(res.headers[RESPONSE_SIG_HEADER]) ?? str(res.trailers?.[RESPONSE_SIG_HEADER]);
  if (!sig) return { ok: false, error: "response_unsigned" };
  const peer = str(res.headers[RESPONSE_PEER_HEADER]);
  const ts = str(res.headers[RESPONSE_TS_HEADER]);
  if (!peer || !ts || !/^\d{1,16}$/.test(ts)) return { ok: false, error: "response_malformed" };
  if (peer !== expected.peerId) return { ok: false, error: "response_peer_mismatch" };
  const payload = responseSigningPayload({
    method: res.method,
    path: res.path,
    status: res.status,
    bodySha256: sha256Hex(res.body),
    agentId: sent.agentId,
    nonce: sent.nonce,
    timestampMs: ts,
    peerId: expected.peerId
  });
  if (!verifySignature(payload, sig, expected.publicKeyPem)) return { ok: false, error: "response_bad_signature" };
  return { ok: true };
}

/**
 * required: every response must be signed (strict mode, or EDGECODER_RESPONSE_SIGNING=required).
 * optional: signatures are required from a coordinator that advertises `responseSigning` (or was
 *           seen signing before); an older coordinator's unsigned responses are accepted with a warning.
 * A response that carries a signature is always verified, whatever the policy.
 */
export type ResponseSigningPolicy = "required" | "optional";

export function responseSigningPolicyFromEnv(env: NodeJS.ProcessEnv, mode: "tofu" | "strict" | "open"): ResponseSigningPolicy {
  const v = (env.EDGECODER_RESPONSE_SIGNING ?? "").trim().toLowerCase();
  if (v === "required" || v === "optional") return v;
  if (v !== "") throw new Error(`EDGECODER_RESPONSE_SIGNING must be required or optional, got "${env.EDGECODER_RESPONSE_SIGNING}"`);
  return mode === "strict" ? "required" : "optional";
}

export interface VerifiedCoordinator {
  peerId: string;
  publicKeyPem: string;
  /** The coordinator advertised `responseSigning` (in /identity or its challenge answer). */
  responseSigning: boolean;
}

export type ResponseDecision =
  | { accept: true; signed: true }
  | { accept: true; signed: false; warning: string }
  | { accept: false; error: ResponseVerifyError | "response_signing_required" };

/**
 * Agent-side policy: which coordinators must sign, and a memory of the ones seen signing so a
 * man-in-the-middle cannot downgrade a signing coordinator by stripping its advertisement.
 */
export class ResponseVerifier {
  private readonly signers = new Set<string>();
  failures = 0;
  constructor(
    private readonly policy: ResponseSigningPolicy,
    private readonly persist?: { load(): string[]; save(peerIds: string[]): void }
  ) {
    try {
      for (const p of persist?.load() ?? []) this.signers.add(p);
    } catch {
      // a missing or unreadable memory only weakens downgrade protection in optional mode
    }
  }

  get mode(): ResponseSigningPolicy {
    return this.policy;
  }

  /** The coordinator must sign: required policy, it advertises signing, or it signed before. */
  mustSign(c: VerifiedCoordinator): boolean {
    return this.policy === "required" || c.responseSigning || this.signers.has(c.peerId);
  }

  check(res: ResponseToVerify, sent: { nonce: string; agentId: string }, c: VerifiedCoordinator): ResponseDecision {
    const v = verifyCoordinatorResponse(res, sent, c);
    if (v.ok) {
      this.rememberSigner(c.peerId);
      return { accept: true, signed: true };
    }
    if (v.error === "response_unsigned" && !this.mustSign(c)) {
      return { accept: true, signed: false, warning: `coordinator ${c.peerId} does not sign its responses (older build); accepted unsigned (EDGECODER_RESPONSE_SIGNING=optional)` };
    }
    this.failures += 1;
    return { accept: false, error: v.error === "response_unsigned" ? "response_signing_required" : v.error };
  }

  private rememberSigner(peerId: string): void {
    if (this.signers.has(peerId)) return;
    this.signers.add(peerId);
    try {
      this.persist?.save([...this.signers]);
    } catch {
      // best effort
    }
  }
}

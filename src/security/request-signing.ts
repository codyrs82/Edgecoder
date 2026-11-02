// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash, sign, verify, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface SignRequestParams {
  method: string;
  path: string;
  bodyHash: string;
  privateKeyPem: string;
  agentId: string;
}

export interface SignedHeaders {
  "x-agent-id": string;
  "x-timestamp-ms": string;
  "x-nonce": string;
  "x-body-sha256": string;
  "x-signature": string;
}

export interface VerifyParams {
  method: string;
  path: string;
  headers: SignedHeaders;
  publicKeyPem: string;
  maxSkewMs: number;
  /**
   * The exact bytes received (Fastify raw body). When given, `x-body-sha256` must equal
   * sha256(rawBody), so a captured signature cannot be replayed with a different body.
   * An absent body hashes as the empty string.
   */
  rawBody?: string | Buffer | null;
}

export interface VerifyResult {
  valid: boolean;
  agentId?: string;
  nonce?: string;
  reason?: string;
}

/** sha256 hex of the exact request body bytes; the value agents send as `x-body-sha256`. */
export function hashRequestBody(raw: string | Buffer | null | undefined): string {
  return createHash("sha256").update(raw ?? "").digest("hex");
}

function canonicalize(
  timestampMs: string,
  nonce: string,
  method: string,
  path: string,
  bodyHash: string
): string {
  return `${timestampMs}\n${nonce}\n${method}\n${path}\n${bodyHash}`;
}

export function signRequest(params: SignRequestParams): SignedHeaders {
  const timestampMs = String(Date.now());
  const nonce = randomUUID();
  const payload = canonicalize(timestampMs, nonce, params.method, params.path, params.bodyHash);
  const signature = sign(null, Buffer.from(payload, "utf8"), params.privateKeyPem).toString("base64");

  return {
    "x-agent-id": params.agentId,
    "x-timestamp-ms": timestampMs,
    "x-nonce": nonce,
    "x-body-sha256": params.bodyHash,
    "x-signature": signature,
  };
}

export function verifySignedRequest(params: VerifyParams): VerifyResult {
  const { method, path, headers, publicKeyPem, maxSkewMs } = params;
  const timestampMs = headers["x-timestamp-ms"];
  const nonce = headers["x-nonce"];
  const bodyHash = headers["x-body-sha256"];
  const signature = headers["x-signature"];
  const agentId = headers["x-agent-id"];

  if (!timestampMs || !nonce || !bodyHash || !signature || !agentId) {
    return { valid: false, reason: "missing_headers" };
  }

  const skew = Math.abs(Date.now() - Number(timestampMs));
  if (skew > maxSkewMs) {
    return { valid: false, reason: "timestamp_skew" };
  }

  const payload = canonicalize(timestampMs, nonce, method, path, bodyHash);
  const ok = verify(null, Buffer.from(payload, "utf8"), publicKeyPem, Buffer.from(signature, "base64"));

  if (!ok) {
    return { valid: false, reason: "invalid_signature" };
  }

  // The signature covers the declared hash; bind that hash to the body actually received.
  if (params.rawBody !== undefined && hashRequestBody(params.rawBody) !== bodyHash.toLowerCase()) {
    return { valid: false, agentId, reason: "body_hash_mismatch" };
  }

  return { valid: true, agentId, nonce };
}

/**
 * Keep the exact JSON request bytes on `req.rawBody` so signed bodies are verified against what
 * was sent, not a re-serialization. Parsing itself stays Fastify's default (safe) JSON parser.
 */
export function installRawBodyCapture(app: FastifyInstance): void {
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    defaultJsonParser(req, body as string, done);
  });
}

/** Raw body captured by installRawBodyCapture; "" when the request had none. */
export function rawBodyOf(req: unknown): string {
  return (req as { rawBody?: string }).rawBody ?? "";
}

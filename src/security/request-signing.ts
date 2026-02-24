import { sign, verify, randomUUID } from "node:crypto";

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
}

export interface VerifyResult {
  valid: boolean;
  agentId?: string;
  nonce?: string;
  reason?: string;
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

  return { valid: true, agentId, nonce };
}

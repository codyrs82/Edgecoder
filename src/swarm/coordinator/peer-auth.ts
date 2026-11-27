// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Signed peer requests (coordinator to coordinator). A peer coordinator signs each request to a
 * peer route with its own Ed25519 key (src/mesh/peer-trust.ts signPeerRequest); the receiver
 * admits it when that key is one it trusts for the peer (MESH_PEER_ALLOWLIST, or the signed
 * registry's members on probation or active: context.ts trustedPeerKey).
 *
 * Migration without downtime:
 * - Outbound: every peer call is signed, and still carries MESH_AUTH_TOKEN while one is configured,
 *   to the peers MESH_TOKEN_PEER_URLS allows (every peer when it is unset).
 * - Inbound: a signature that is present is always verified (headers, body hash, single-use nonce);
 *   a bad one is refused even next to a valid token. (One by a key this coordinator does not trust
 *   is ignored when a valid token came with it, so token-only peers keep working.) With MESH_TOKEN_REQUIRED_FOR_PEERS=true (the
 *   default) the token is still required on peer routes; with false a valid signature alone passes.
 * - Agents and operator routes do not change: this applies to the peer routes below only.
 */
import { verifyNonce } from "../../security/nonce-verifier.js";
import {
  hasPeerRequestSignature,
  PEER_SIGNATURE_MAX_SKEW_MS,
  signPeerRequest,
  verifyPeerRequest,
  type PeerKeyTrust
} from "../../mesh/peer-trust.js";
import { rawBodyOf } from "../../security/request-signing.js";
import {
  identity,
  coordinatorKeys,
  meshTokenFor,
  MESH_TOKEN_REQUIRED_FOR_PEERS,
  PEER_KEY_TRUST_CONFIGURED,
  trustedPeerKey,
  nonceStore,
  SECURITY_NONCE_TTL_MS
} from "./context.js";
import { hasMeshToken, requireMeshToken } from "./auth.js";

/** GET routes another coordinator calls (federation reads). */
const PEER_GET_ROUTES: ReadonlySet<string> = new Set([
  "/mesh/capabilities",
  "/receipts/since",
  "/network/world/local",
  "/economy/price/quote",
  "/stats/ledger/head",
  "/stats/ledger/range"
]);
/** POST routes another coordinator calls (registration, gossip, forwarded results, replication). */
const PEER_POST_ROUTES: ReadonlySet<string> = new Set([
  "/mesh/register-peer",
  "/mesh/ingest",
  "/mesh/relay-gossip",
  "/result",
  "/receipts/replicate",
  "/stats/ledger/ingest"
]);

/**
 * Whether `method path` (no query string) is a coordinator-to-coordinator route, where a signed
 * peer request may stand in for the mesh token. /mesh/ws is checked in its handler (signed bind).
 */
export function isPeerGateRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET") return PEER_GET_ROUTES.has(path);
  if (m === "POST") return PEER_POST_ROUTES.has(path);
  return false;
}

/**
 * Whether peer signatures are checked at all. With no trusted keys configured (empty allowlist and
 * no pinned registry key) nothing could be trusted by key, so the signature is ignored and the mesh token decides, as before.
 */
export function peerSignaturesChecked(): boolean {
  return PEER_KEY_TRUST_CONFIGURED();
}

/**
 * Transport-gate check (onRequest, before the body is read): the headers carry a fresh signature,
 * over this method and path, by a key trusted for the named peer. Returns the peer id, or null.
 * The body hash and the nonce are checked in checkPeerRequest once the body is in.
 */
export async function peerSignatureAtGate(
  headers: Record<string, unknown>,
  method: string,
  url: string,
  trusted: PeerKeyTrust = trustedPeerKey
): Promise<string | null> {
  if (!peerSignaturesChecked() || !hasPeerRequestSignature(headers)) return null;
  const decision = await verifyPeerRequest({ headers, method, path: url, trusted });
  return decision.ok ? decision.peerId : null;
}

/** Whether the global gate admits a request by its peer signature alone (the flag allows it). */
export async function peerSignatureAdmits(headers: Record<string, unknown>, method: string, url: string): Promise<boolean> {
  if (MESH_TOKEN_REQUIRED_FOR_PEERS) return false;
  if (!isPeerGateRoute(method, url.split("?")[0])) return false;
  return (await peerSignatureAtGate(headers, method, url)) !== null;
}

const verifiedPeers = new WeakMap<object, string>();

/** The peer coordinator that signed this request (set by checkPeerRequest), or null. */
export function verifiedPeerOf(req: unknown): string | null {
  return (req && typeof req === "object" ? verifiedPeers.get(req) : undefined) ?? null;
}

type HookReq = { method: string; url: string; headers: Record<string, unknown> };
type HookReply = { code: (n: number) => { send: (b: unknown) => unknown } };

/**
 * preValidation: a peer signature that is present on a peer route is verified in full (trusted key,
 * skew, body hash against the bytes received, single-use nonce), whether or not a token came with
 * it. Sends the refusal and returns false when it fails.
 */
export async function checkPeerRequest(req: HookReq, reply: HookReply): Promise<boolean> {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  if (!peerSignaturesChecked() || !hasPeerRequestSignature(headers)) return true;
  const url = String(req.url ?? "");
  if (!isPeerGateRoute(req.method, url.split("?")[0])) return true;
  const decision = await verifyPeerRequest({
    headers,
    method: req.method,
    path: url,
    rawBody: rawBodyOf(req),
    trusted: trustedPeerKey,
    replay: async (peerId, nonce, issuedAtMs) =>
      (
        await verifyNonce(nonceStore, {
          nonce: `peer-req:${peerId}:${nonce}`,
          sourceId: peerId,
          timestampMs: issuedAtMs,
          maxSkewMs: PEER_SIGNATURE_MAX_SKEW_MS,
          ttlMs: SECURITY_NONCE_TTL_MS
        })
      ).valid
  });
  if (!decision.ok) {
    // A key this coordinator does not trust says nothing either way; with a valid mesh token the
    // request goes on as before (token-only), it just is not taken as that peer's signed request.
    // A signature that fails for any other reason (stale, forged, wrong body, replayed) is refused.
    if (decision.error === "peer_not_allowlisted" && hasMeshToken(headers)) return true;
    reply.code(decision.code).send({ error: "mesh_unauthorized", reason: decision.error });
    return false;
  }
  verifiedPeers.set(req, decision.peerId);
  return true;
}

/** A verified peer signature that, with the flag off, stands in for the mesh token. */
export function hasAcceptedPeerSignature(req: unknown): boolean {
  return !MESH_TOKEN_REQUIRED_FOR_PEERS && verifiedPeerOf(req) !== null;
}

/** Mesh token, or (when the flag allows it) a verified peer signature. */
export function hasPeerCredential(req: { headers?: unknown }): boolean {
  return hasMeshToken((req.headers ?? {}) as Record<string, unknown>) || hasAcceptedPeerSignature(req);
}

/** requireMeshToken for peer routes: also passes a verified peer signature when the flag allows it. */
export function requirePeerCredential(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => any }): boolean {
  if (hasPeerCredential(req)) return true;
  return requireMeshToken(req, reply);
}

/** Signature headers for one outbound peer request (sign every attempt: the nonce is single-use). */
export function peerSignatureHeaders(method: string, url: string, body?: string | Buffer | null): Record<string, string> {
  return signPeerRequest({
    peerId: identity.peerId,
    privateKeyPem: coordinatorKeys.privateKeyPem,
    publicKeyPem: identity.publicKeyPem,
    method,
    url,
    body
  });
}

/**
 * Everything an outbound peer request carries: the signature, plus the mesh token while one is
 * configured and the peer is one it may go to (MESH_TOKEN_PEER_URLS).
 */
export function peerRequestHeaders(method: string, url: string, body?: string | Buffer | null): Record<string, string> {
  const token = meshTokenFor(url);
  return { ...peerSignatureHeaders(method, url, body), ...(token ? { "x-mesh-token": token } : {}) };
}

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import { BlacklistRecord } from "../common/types.js";
import { verifyPayload } from "../mesh/peer.js";
import { buildBlacklistEventHash } from "../security/blacklist.js";

type IdentityResponse = { peerId: string; publicKeyPem: string };
type PeerResponse = { peers: Array<{ peerId: string; publicKeyPem: string }> };
type AuditResponse = { chainHead: string; events: BlacklistRecord[] };

function fail(message: string): never {
  throw new Error(message);
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await request(url, { method: "GET", headers });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    fail(`request_failed ${url} status=${res.statusCode}`);
  }
  return (await res.body.json()) as T;
}

async function main(): Promise<void> {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4303";
  const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
  const adminToken = process.env.ADMIN_API_TOKEN;
  const meshToken = process.env.MESH_AUTH_TOKEN ?? process.env.COORDINATOR_MESH_TOKEN ?? "";
  const adminHeaders: Record<string, string> = adminToken ? { "x-admin-token": adminToken } : {};
  const meshHeaders: Record<string, string> = meshToken ? { "x-mesh-token": meshToken } : {};

  const [audit, identity, peers] = await Promise.all([
    getJson<AuditResponse>(`${controlPlaneUrl}/security/blacklist/audit`, adminHeaders),
    getJson<IdentityResponse>(`${coordinatorUrl}/identity`, meshHeaders),
    getJson<PeerResponse>(`${coordinatorUrl}/mesh/peers`, meshHeaders).catch(() => ({ peers: [] }))
  ]);

  const coordinatorKeyById = new Map<string, string>();
  coordinatorKeyById.set(identity.peerId, identity.publicKeyPem);
  for (const peer of peers.peers) {
    coordinatorKeyById.set(peer.peerId, peer.publicKeyPem);
  }

  let previousHash = "BLACKLIST_GENESIS";
  for (const event of audit.events) {
    if (event.prevEventHash !== previousHash) {
      fail(`hash_chain_break event=${event.eventId}`);
    }

    const expectedHash = buildBlacklistEventHash({
      eventId: event.eventId,
      agentId: event.agentId,
      reasonCode: event.reasonCode,
      reason: event.reason,
      evidenceHashSha256: event.evidenceHashSha256,
      reporterId: event.reporterId,
      sourceCoordinatorId: event.sourceCoordinatorId,
      timestampMs: event.timestampMs,
      expiresAtMs: event.expiresAtMs,
      prevEventHash: event.prevEventHash,
      evidenceSignatureVerified: event.evidenceSignatureVerified
    });
    if (expectedHash !== event.eventHash) {
      fail(`event_hash_mismatch event=${event.eventId}`);
    }

    const coordinatorPublicKey = coordinatorKeyById.get(event.sourceCoordinatorId);
    if (!coordinatorPublicKey) {
      fail(`missing_coordinator_key source=${event.sourceCoordinatorId}`);
    }
    if (!verifyPayload(event.eventHash, event.coordinatorSignature, coordinatorPublicKey)) {
      fail(`coordinator_signature_invalid event=${event.eventId}`);
    }
    previousHash = event.eventHash;
  }

  if (audit.chainHead !== previousHash) {
    fail(`chain_head_mismatch expected=${previousHash} actual=${audit.chainHead}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        eventsVerified: audit.events.length,
        chainHead: audit.chainHead
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
});

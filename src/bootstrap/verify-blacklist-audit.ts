// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readFileSync } from "node:fs";
import { request } from "undici";
import { parseTrustEntries } from "../trust/pinned-keys.js";
import { EDGECODER_SEED_KEYS } from "../trust/seed-keys.js";
import { verifyBlacklistAuditChain, type BlacklistAudit } from "./blacklist-audit-chain.js";

type IdentityResponse = { peerId: string; publicKeyPem: string };
type PeerResponse = { peers: Array<{ peerId: string; publicKeyPem: string }> };

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

/**
 * Keys pinned independently of the coordinator being audited: TRUSTED_COORDINATOR_KEYS, the trust
 * file (EDGECODER_TRUST_FILE) and the edgecoder.io seed keys.
 */
function pinnedFingerprints(env: NodeJS.ProcessEnv): Map<string, string> {
  const pins = parseTrustEntries(EDGECODER_SEED_KEYS.join(","));
  const file = env.EDGECODER_TRUST_FILE;
  if (file && existsSync(file)) for (const [peerId, fp] of parseTrustEntries(readFileSync(file, "utf8"))) pins.set(peerId, fp);
  for (const [peerId, fp] of parseTrustEntries(env.TRUSTED_COORDINATOR_KEYS)) pins.set(peerId, fp);
  return pins;
}

async function main(): Promise<void> {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4303";
  const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
  const adminToken = process.env.ADMIN_API_TOKEN;
  const meshToken = process.env.MESH_AUTH_TOKEN ?? process.env.COORDINATOR_MESH_TOKEN ?? "";
  const adminHeaders: Record<string, string> = adminToken ? { "x-admin-token": adminToken } : {};
  const meshHeaders: Record<string, string> = meshToken ? { "x-mesh-token": meshToken } : {};

  const [audit, identity, peers] = await Promise.all([
    getJson<BlacklistAudit>(`${controlPlaneUrl}/security/blacklist/audit`, adminHeaders),
    getJson<IdentityResponse>(`${coordinatorUrl}/identity`, meshHeaders),
    getJson<PeerResponse>(`${coordinatorUrl}/mesh/peers`, meshHeaders).catch(() => ({ peers: [] }))
  ]);

  // Keys as the audited coordinator presents them; each is used only if it matches a pin.
  const presented = new Map<string, string>();
  presented.set(identity.peerId, identity.publicKeyPem);
  for (const peer of peers.peers) if (!presented.has(peer.peerId)) presented.set(peer.peerId, peer.publicKeyPem);

  const result = verifyBlacklistAuditChain(audit, presented, pinnedFingerprints(process.env));

  console.log(
    JSON.stringify(
      {
        ok: true,
        eventsVerified: result.eventsVerified,
        chainHead: result.chainHead
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

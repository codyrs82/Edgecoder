// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator peers: bootstrap discovery, peer keys and the approved-coordinator list.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { request } from "undici";
import { normalizeUrl } from "../coordinator-utils.js";
import type { NetworkMode } from "../../common/types.js";
import { signRegistration } from "../../mesh/peer-trust.js";
import { app } from "./app.js";
import {
  COORDINATOR_PEER_CACHE_FILE,
  COORDINATOR_DISCOVERY_URL,
  COORDINATOR_BOOTSTRAP_URLS,
  COORDINATOR_PUBLIC_URL,
  MESH_AUTH_TOKEN,
  identity,
  mesh,
  PEER_ALLOWLIST_ENFORCED,
  peerScore,
  networkMode,
  COORDINATOR_REGISTRATION_TOKEN,
  coordinatorKeys,
  APPROVED_COORDINATOR_IDS
} from "./context.js";

async function readCachedPeerUrls(): Promise<string[]> {
  try {
    const raw = await readFile(COORDINATOR_PEER_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { peers?: string[] };
    if (!Array.isArray(parsed.peers)) return [];
    return parsed.peers.map((item) => normalizeUrl(item) ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

async function writeCachedPeerUrls(urls: string[]): Promise<void> {
  try {
    await mkdir(dirname(COORDINATOR_PEER_CACHE_FILE), { recursive: true });
    await writeFile(
      COORDINATOR_PEER_CACHE_FILE,
      JSON.stringify({ peers: urls, updatedAtMs: Date.now() }, null, 2),
      "utf8"
    );
  } catch {
    // Best-effort cache only.
  }
}

async function discoverCoordinatorUrlsFromRegistry(): Promise<string[]> {
  if (!COORDINATOR_DISCOVERY_URL) return [];
  try {
    const res = await request(COORDINATOR_DISCOVERY_URL, { method: "GET" });
    if (res.statusCode < 200 || res.statusCode >= 300) return [];
    const payload = (await res.body.json()) as {
      coordinators?: Array<{ coordinatorUrl?: string }>;
    };
    return (payload.coordinators ?? [])
      .map((item) => normalizeUrl(item.coordinatorUrl) ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function discoverBootstrapPeers(): Promise<string[]> {
  const fromRegistry = await discoverCoordinatorUrlsFromRegistry();
  const fromCache = await readCachedPeerUrls();
  const candidates = [...fromRegistry, ...fromCache, ...COORDINATOR_BOOTSTRAP_URLS]
    .map((value) => normalizeUrl(value) ?? "")
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .filter((value) => value !== normalizeUrl(COORDINATOR_PUBLIC_URL));
  return candidates;
}

/** Whether `url` serves the coordinator identity `peerId` (so its announced URL is safe to use). */
async function peerAnswersAs(url: string, peerId: string): Promise<boolean> {
  try {
    const res = await request(`${url}/identity`, { method: "GET", headersTimeout: 5_000, bodyTimeout: 5_000 });
    if (res.statusCode !== 200) {
      await res.body.text().catch(() => undefined);
      return false;
    }
    return ((await res.body.json()) as { peerId?: string }).peerId === peerId;
  } catch {
    return false;
  }
}

export async function bootstrapPeerMesh(): Promise<void> {
  const candidates = await discoverBootstrapPeers();
  app.log.info({ candidateCount: candidates.length, candidates }, "mesh_bootstrap_start");
  if (candidates.length === 0) return;

  const discoveredForCache = new Set<string>();
  for (const peerUrl of candidates) {
    try {
      const identityRes = await request(`${peerUrl}/identity`, {
        method: "GET",
        headers: MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : undefined,
        signal: AbortSignal.timeout(8_000)
      });
      if (identityRes.statusCode < 200 || identityRes.statusCode >= 300) {
        // Must consume the body to release the socket (undici requirement)
        await identityRes.body.text().catch(() => undefined);
        app.log.warn({ peerUrl, status: identityRes.statusCode }, "mesh_bootstrap_identity_failed");
        continue;
      }
      const remote = (await identityRes.body.json()) as {
        peerId: string;
        publicKeyPem: string;
        coordinatorUrl: string;
        networkMode: NetworkMode;
      };
      app.log.info({ peerUrl, remotePeerId: remote.peerId, localPeerId: identity.peerId }, "mesh_bootstrap_identity_fetched");
      if (!remote.peerId || remote.peerId === identity.peerId) {
        app.log.warn({ peerUrl, remotePeerId: remote.peerId }, "mesh_bootstrap_skip_same_peer");
        continue;
      }

      // Prefer the peer's self-reported coordinatorUrl, but fall back to the
      // actual URL we successfully reached it on (the bootstrap/discovery URL).
      // This handles cases where the self-reported URL (e.g. custom domain) is
      // unreachable but the direct URL (e.g. fly.dev) works.
      const normalizedRemoteUrl = normalizeUrl(remote.coordinatorUrl);
      const normalizedPeerUrl = normalizeUrl(peerUrl);
      const effectiveUrl = normalizedRemoteUrl ?? normalizedPeerUrl;
      if (!effectiveUrl || effectiveUrl === normalizeUrl(COORDINATOR_PUBLIC_URL)) {
        app.log.warn({ peerUrl, effectiveUrl, localUrl: normalizeUrl(COORDINATOR_PUBLIC_URL) }, "mesh_bootstrap_skip_same_url");
        continue;
      }
      // Gossip on the peer's own public URL (its domain) when it answers there as the same peer;
      // otherwise on the URL we reached it at (e.g. a bootstrap fly.dev host).
      let gossipUrl = normalizedPeerUrl ?? effectiveUrl;
      if (normalizedRemoteUrl && normalizedRemoteUrl !== normalizedPeerUrl && (await peerAnswersAs(normalizedRemoteUrl, remote.peerId))) gossipUrl = normalizedRemoteUrl;
      const admitted = mesh.addPeer(
        {
          peerId: remote.peerId,
          publicKeyPem: remote.publicKeyPem,
          coordinatorUrl: gossipUrl!,
          networkMode: remote.networkMode
        },
        // Dev without an allowlist keeps the old refresh-on-bootstrap behaviour.
        { authoritative: !PEER_ALLOWLIST_ENFORCED, source: "bootstrap" }
      );
      if (!admitted) {
        app.log.warn({ peerUrl, remotePeerId: remote.peerId }, "mesh_bootstrap_peer_not_allowlisted");
        continue;
      }
      peerScore.set(remote.peerId, peerScore.get(remote.peerId) ?? 100);
      discoveredForCache.add(gossipUrl!);

      const selfUrl = normalizeUrl(COORDINATOR_PUBLIC_URL) ?? COORDINATOR_PUBLIC_URL;
      const registerRes = await request(`${peerUrl}/mesh/register-peer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {})
        },
        body: JSON.stringify({
          peerId: identity.peerId,
          publicKeyPem: identity.publicKeyPem,
          coordinatorUrl: selfUrl,
          networkMode,
          registrationToken: COORDINATOR_REGISTRATION_TOKEN,
          // #52: prove we hold the key the peer's allowlist names.
          ...signRegistration(
            { peerId: identity.peerId, publicKeyPem: identity.publicKeyPem, coordinatorUrl: selfUrl, networkMode },
            coordinatorKeys.privateKeyPem
          )
        }),
        signal: AbortSignal.timeout(8_000)
      });
      await registerRes.body.text().catch(() => undefined);
      app.log.info({ peerUrl, registerStatus: registerRes.statusCode, remotePeerId: remote.peerId }, "mesh_bootstrap_registered");
      if (registerRes.statusCode >= 200 && registerRes.statusCode < 300) {
        discoveredForCache.add(peerUrl);
      }
    } catch (err) {
      app.log.warn({ peerUrl, error: (err as Error).message }, "mesh_bootstrap_peer_error");
    }
  }

  if (discoveredForCache.size > 0) {
    await writeCachedPeerUrls([...discoveredForCache]);
  }
}

export function coordinatorPublicKeyById(peerId: string): string | null {
  if (peerId === identity.peerId) return identity.publicKeyPem;
  const peer = mesh.listPeers().find((item) => item.peerId === peerId);
  return peer?.publicKeyPem ?? null;
}

export function isApprovedCoordinator(peerId: string): boolean {
  if (APPROVED_COORDINATOR_IDS.size === 0) return true;
  return APPROVED_COORDINATOR_IDS.has(peerId);
}

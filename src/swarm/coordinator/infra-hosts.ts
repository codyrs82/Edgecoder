// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Infrastructure host heartbeats, including this coordinator's own attested services.
 */
import type { InfrastructureHost } from "../../common/types.js";
import { pgStore } from "../../db/store.js";
import {
  attestSelfServices,
  heartbeatCounts,
  normalizeServices,
  signHostHeartbeat,
  type AttestationResult
} from "../../economy/host-attestation.js";
import { probeElectrum } from "../../economy/service-probes.js";
import { app } from "./app.js";
import { CC, identity, COORDINATOR_PUBLIC_URL, coordinatorKeys, MESH_AUTH_TOKEN } from "./context.js";
import {
  memoryPayoutStore,
  INFRA_HOST_SERVICES,
  ECONOMY_PAYMENTS_ENABLED,
  lightningProvider,
  INFRA_HOST_ENABLED,
  INFRA_HOST_REPORT_URLS
} from "./payouts.js";
import { anchorDeps } from "./stats-ledger.js";

/**
 * Infrastructure hosts (this coordinator included) report uptime by heartbeat; weight = uptime ×
 * attested services (src/economy/host-attestation.ts). A heartbeat counts toward the window at
 * most once per ~HOST_HEARTBEAT_MS, and only attested services are stored in `services`.
 */
export async function recordInfraHeartbeat(input: {
  hostId: string;
  accountId?: string;
  declaredServices: string[];
  attestation: AttestationResult;
  region?: string;
  coordinatorUrl?: string;
  lightningAddress?: string;
  lightningNodeId?: string;
}): Promise<{ host: InfrastructureHost; counted: boolean }> {
  const now = Date.now();
  const minCountIntervalMs = Math.floor(CC.HOST_HEARTBEAT_MS * 0.8);
  const host: InfrastructureHost = {
    hostId: input.hostId,
    accountId: input.accountId ?? `host:${input.hostId}`,
    coordinatorUrl: input.coordinatorUrl,
    region: input.region,
    services: input.attestation.attested,
    declaredServices: normalizeServices(input.declaredServices),
    attestedAtMs: input.attestation.atMs,
    lightningNodeId: input.lightningNodeId,
    lightningAddress: input.lightningAddress,
    firstSeenMs: now,
    lastSeenMs: now,
    lastCountedMs: now,
    heartbeatsInWindow: 1
  };
  if (pgStore) {
    const r = await pgStore.recordAttestedHostHeartbeat(host, now, minCountIntervalMs);
    return { host: { ...host, heartbeatsInWindow: r.heartbeatsInWindow }, counted: r.counted };
  }
  if (!memoryPayoutStore) return { host, counted: false };
  const existing = memoryPayoutStore.hosts.get(host.hostId);
  let counted = true;
  if (existing) {
    counted = heartbeatCounts(existing.lastCountedMs, now, CC.HOST_HEARTBEAT_MS);
    Object.assign(existing, {
      accountId: host.accountId,
      services: host.services,
      declaredServices: host.declaredServices,
      attestedAtMs: host.attestedAtMs,
      lastSeenMs: now,
      lastCountedMs: counted ? now : existing.lastCountedMs,
      heartbeatsInWindow: existing.heartbeatsInWindow + (counted ? 1 : 0),
      region: host.region ?? existing.region,
      coordinatorUrl: host.coordinatorUrl ?? existing.coordinatorUrl,
      lightningAddress: host.lightningAddress ?? existing.lightningAddress,
      lightningNodeId: host.lightningNodeId ?? existing.lightningNodeId
    });
  } else {
    memoryPayoutStore.hosts.set(host.hostId, host);
  }
  if (host.lightningAddress) memoryPayoutStore.autoAccounts.set(host.accountId, host.lightningAddress);
  return { host: memoryPayoutStore.hosts.get(host.hostId) ?? host, counted };
}

/** Our own services: each counts only if the backend this process uses answers (cached 10 min). */
let selfAttestation: AttestationResult | null = null;
async function attestOwnServices(): Promise<AttestationResult> {
  if (selfAttestation && Date.now() - selfAttestation.atMs < 10 * 60_000) return selfAttestation;
  const electrs = CC.INFRA_HOST_ELECTRS_ENDPOINT.split(":");
  selfAttestation = await attestSelfServices(INFRA_HOST_SERVICES, {
    lightning: async () => {
      if (!ECONOMY_PAYMENTS_ENABLED || !lightningProvider.getBalances) return { ok: false, detail: "lightning_unavailable" };
      const b = await lightningProvider.getBalances();
      return b.supported ? { ok: true } : { ok: false, detail: b.reason };
    },
    bitcoind: async () => {
      const provider = process.env.BITCOIN_ANCHOR_PROVIDER === "bitcoind" ? anchorDeps()?.provider : undefined;
      if (!provider) return { ok: false, detail: "bitcoind_not_configured" };
      const h = await provider.healthCheck();
      return h.reachable ? { ok: true, detail: h.chain } : { ok: false, detail: h.error ?? "unreachable" };
    },
    electrs: () => probeElectrum(electrs[0], Number(electrs[1] ?? 50001))
  });
  const missing = normalizeServices(INFRA_HOST_SERVICES).filter((x) => !selfAttestation!.attested.includes(x));
  if (missing.length) app.log.warn({ missing, results: selfAttestation.results }, "infra_host_services_not_attested");
  return selfAttestation;
}

export async function selfInfraHeartbeat(): Promise<void> {
  if (!INFRA_HOST_ENABLED) return;
  const fields = {
    hostId: identity.peerId,
    accountId: CC.INFRA_HOST_ACCOUNT_ID,
    services: INFRA_HOST_SERVICES,
    region: CC.INFRA_HOST_REGION || process.env.FLY_REGION || undefined,
    coordinatorUrl: COORDINATOR_PUBLIC_URL,
    lightningAddress: CC.INFRA_HOST_LIGHTNING_ADDRESS,
    lightningNodeId: CC.INFRA_HOST_LIGHTNING_NODE_ID
  };
  await recordInfraHeartbeat({ ...fields, declaredServices: fields.services, attestation: await attestOwnServices() });
  for (const url of INFRA_HOST_REPORT_URLS) {
    // Fresh signature per target: each heartbeat is single-use on the receiver.
    const body = signHostHeartbeat(fields, coordinatorKeys.privateKeyPem);
    void fetch(`${url}/economy/hosts/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    })
      .then(async (res) => {
        if (!res.ok) app.log.warn({ url, status: res.status, body: await res.text().catch(() => "") }, "infra_heartbeat_report_rejected");
      })
      .catch((error) => app.log.warn({ url, error: String(error) }, "infra_heartbeat_report_failed"));
  }
}

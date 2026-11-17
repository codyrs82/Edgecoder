// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The portal's proof-of-reserves source for /reserves and /reserves.json: the first discovered
 * coordinator's public GET /economy/reserves, cached (RESERVES_CACHE_MS, default 60 s). The body
 * is checked field by field and rebuilt, so only the aggregate fields are passed on, whatever the
 * coordinator sent. A coordinator that can't be reached, or a body that doesn't check out, gives
 * an "unavailable" report: no numbers rather than wrong ones, and never the last good numbers
 * under a new timestamp.
 */
import { request } from "undici";
import {
  RESERVES_METHOD,
  createReservesCache,
  reservesCacheMsFromEnv,
  type LiabilitiesView,
  type ProofOfReservesReport,
  type ReservesAnchorView,
  type ReservesView,
  type Unavailable
} from "../economy/proof-of-reserves.js";

const NETWORKS = new Set(["mainnet", "testnet", "signet", "regtest"]);
const ANCHORING = new Set(["enabled", "disabled", "simulated"]);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const reasonOf = (v: unknown): string => (typeof v === "string" && /^[a-z_]{1,64}$/.test(v) ? v : "unavailable");

function liabilitiesOf(v: any): LiabilitiesView | Unavailable | null {
  if (v?.available === false) return { available: false, reason: reasonOf(v.reason) };
  if (v?.available !== true) return null;
  const { accountBalancesSats: a, feePoolSats: f, heldForJobsSats: h, totalSats: t } = v;
  if (![a, f, h, t].every(count) || a + f + h !== t) return null;
  return { available: true, accountBalancesSats: a, feePoolSats: f, heldForJobsSats: h, totalSats: t };
}

function reservesOf(v: any): ReservesView | Unavailable | null {
  if (v?.available === false) return { available: false, reason: reasonOf(v.reason) };
  if (v?.available !== true) return null;
  const { channelLocalSats: c, onchainConfirmedSats: o, totalSats: t, pendingSats: p } = v;
  if (![c, o, t, p].every(count) || c + o !== t) return null;
  return { available: true, channelLocalSats: c, onchainConfirmedSats: o, totalSats: t, pendingSats: p };
}

function anchorOf(v: any): ReservesAnchorView | null {
  if (!v || typeof v !== "object") return null;
  if (typeof v.txid !== "string" || !/^[0-9a-f]{64}$/i.test(v.txid)) return null;
  if (typeof v.checkpointHash !== "string" || !/^[0-9a-f]{8,128}$/i.test(v.checkpointHash)) return null;
  if (!count(v.confirmations) || !count(v.createdAtMs) || (v.status !== "pending" && v.status !== "anchored")) return null;
  return {
    txid: v.txid.toLowerCase(),
    checkpointHash: v.checkpointHash.toLowerCase(),
    confirmations: v.confirmations,
    status: v.status,
    createdAtMs: v.createdAtMs,
    ...(count(v.anchoredAtMs) ? { anchoredAtMs: v.anchoredAtMs } : {})
  };
}

/** Rebuild a coordinator report from its known fields only; null when it doesn't check out. */
export function parseReservesReport(body: unknown): ProofOfReservesReport | null {
  const b = body as any;
  if (!b || typeof b !== "object" || !NETWORKS.has(b.network) || !count(b.asOfMs)) return null;
  const liabilities = liabilitiesOf(b.liabilities);
  const reserves = reservesOf(b.reserves);
  if (!liabilities || !reserves) return null;
  let ratio: number | null = null;
  if (liabilities.available && reserves.available && liabilities.totalSats > 0) {
    ratio = Math.floor((reserves.totalSats / liabilities.totalSats) * 10_000) / 10_000;
  }
  return {
    network: b.network,
    asOfMs: b.asOfMs,
    asOf: new Date(b.asOfMs).toISOString(),
    liabilities,
    reserves,
    ratio,
    anchor: anchorOf(b.anchor),
    anchoring: ANCHORING.has(b.anchoring) ? b.anchoring : "disabled",
    cacheSeconds: count(b.cacheSeconds) ? b.cacheSeconds : 60,
    method: RESERVES_METHOD
  };
}

/** Both sides unavailable, for when the coordinator can't be read. */
export function unavailableReservesReport(reason: string, network: ProofOfReservesReport["network"], nowMs: number): ProofOfReservesReport {
  return {
    network,
    asOfMs: nowMs,
    asOf: new Date(nowMs).toISOString(),
    liabilities: { available: false, reason },
    reserves: { available: false, reason },
    ratio: null,
    anchor: null,
    anchoring: "disabled",
    cacheSeconds: 60,
    method: RESERVES_METHOD
  };
}

export function portalNetworkName(env: NodeJS.ProcessEnv = process.env): ProofOfReservesReport["network"] {
  const n = (env.BITCOIN_NETWORK ?? "").trim().toLowerCase();
  if (n === "bitcoin" || n === "mainnet") return "mainnet";
  return NETWORKS.has(n) ? (n as ProofOfReservesReport["network"]) : "signet";
}

export function coordinatorReservesSource(deps: {
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  PORTAL_SERVICE_TOKEN: string;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): () => Promise<ProofOfReservesReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  return createReservesCache(
    async () => {
      try {
        const urls = await deps.discoverCoordinatorUrlsForPortal();
        if (!urls.length) return unavailableReservesReport("coordinator_unreachable", portalNetworkName(env), now());
        const res = await request(`${urls[0].replace(/\/$/, "")}/economy/reserves`, {
          method: "GET",
          headers: deps.PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": deps.PORTAL_SERVICE_TOKEN } : {},
          headersTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS,
          bodyTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS
        });
        if (res.statusCode !== 200) {
          await res.body.text().catch(() => undefined);
          return unavailableReservesReport("coordinator_unreachable", portalNetworkName(env), now());
        }
        return parseReservesReport(await res.body.json()) ?? unavailableReservesReport("coordinator_report_invalid", portalNetworkName(env), now());
      } catch {
        return unavailableReservesReport("coordinator_unreachable", portalNetworkName(env), now());
      }
    },
    { ttlMs: reservesCacheMsFromEnv(env), now }
  );
}

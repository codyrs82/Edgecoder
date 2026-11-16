// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Loads the coordinator's dependencies in the order the single-file coordinator imported them.
 *
 * Some of these modules do work when first loaded (reading environment settings, opening the
 * database pool, validating MODEL_DOWNLOAD_DOMAINS). coordinator.ts imports this file first so
 * that work still happens before the Fastify app is created and in the same order as before
 * the coordinator was split into modules. Nothing is exported.
 */
import "../../common/desktop-origins.js";
import "../../common/config.js";
import "../coordinator-config.js";
import "../sandbox-enforcement.js";
import "fastify";
import "../../common/http-logging.js";
import "../../common/metrics.js";
import "../coordinator-metrics.js";
import "../../common/error-tracking.js";
import "@fastify/cors";
import "@fastify/websocket";
import "node:crypto";
import "node:fs/promises";
import "node:path";
import "node:os";
import "undici";
import "zod";
import "../coordinator-utils.js";
import "../robot-queue.js";
import "../robot-routes.js";
import "../../discovery/announce.js";
import "../../discovery/registry-mirror.js";
import "../../model/extract.js";
import "../queue.js";
import "../../mesh/peer.js";
import "../../mesh/peer-trust.js";
import "../../mesh/forwarded-agent-envelope.js";
import "../../mesh/protocol.js";
import "../../mesh/ws-auth.js";
import "../../security/key-fingerprint.js";
import "../../trust/identity-challenge.js";
import "../../trust/local-attest.js";
import "../../trust/response-signing.js";
import "../../mesh/gossip.js";
import "../../ledger/chain.js";
import "../../ledger/verify.js";
import "../../ledger/reconcile.js";
import "../../ledger/record.js";
import "../../ledger/stats-checkpoint.js";
import "../../credits/store.js";
import "../../economy/job-pricing.js";
import "../../inference-api/auto-route.js";
import "../inference-streams.js";
import "../../economy/payout-service.js";
import "../../economy/payout-safeguards.js";
import "../../economy/payout-reconcile.js";
import "../../economy/payouts.js";
import "../../economy/lnurl-callback-pin.js";
import "../../economy/payout-destination.js";
import "../../security/public-fetch.js";
import "../../model/ollama-installer.js";
import "../../db/store.js";
import "../../economy/pricing.js";
import "../../economy/price-epoch-guard.js";
import "../../economy/rate-oracle.js";
import "../../economy/compute-classes.js";
import "../../economy/usage.js";
import "../../economy/reservations.js";
import "../../economy/order-book.js";
import "../../economy/market-history.js";
import "../../model/catalog.js";
import "../../economy/issuance.js";
import "../../economy/issuance-epoch.js";
import "../../common/env-guard.js";
import "../../economy/host-attestation.js";
import "../../economy/service-probes.js";
import "../../economy/lightning.js";
import "../../economy/bitcoin-rpc.js";
import "../../economy/anchoring.js";
import "../../economy/anchor-tracker.js";
import "../../economy/anchor-status.js";
import "../../receipts/store.js";
import "../../receipts/replication.js";
import "../../receipts/epochs.js";
import "../../receipts/issue.js";
import "../result-integrity.js";
import "../verification.js";
import "../hardware-verification.js";
import "../model-catalog.js";
import "../../credits/ble-sync.js";
import "../../economy/payment-settlement.js";
import "../../economy/treasury.js";
import "../power-policy.js";
import "../../security/blacklist.js";
import "../../escalation/server.js";
import "../../mesh/capability-gossip.js";
import "../../security/envelope.js";
import "../../security/request-signing.js";
import "../../security/nonce-verifier.js";
import "../../security/agent-rate-limiter.js";
import "../../audit/security-events.js";
import "../../audit/prune-scheduler.js";
import "../../security/behavior-tracker.js";
import "../../security/anomaly-detector.js";
import "../../security/auto-blacklister.js";
import "../../security/release-verifier.js";
import "../../security/release-manifest-cache.js";
import "../snapshot-resolver.js";
import "../../model/pull-tracker.js";
import "../../model/system-prompt.js";
import "../subtask-deps.js";
import "../lease-gate.js";

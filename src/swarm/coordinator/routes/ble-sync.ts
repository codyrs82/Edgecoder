// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Offline BLE credit sync route.
 */
import { creditEngine, rewardAccountForAgent } from "../../../credits/store.js";
import { pgStore } from "../../../db/store.js";
import {
  applyBleSyncBatch,
  bleSyncAllowV1,
  createBleSyncSchema,
  createInMemoryBleTransfer,
  isBleSyncAuthorized
} from "../../../credits/ble-sync.js";
import { rawBodyOf } from "../../../security/request-signing.js";
import type { CoordinatorApp } from "../app.js";
import { MESH_AUTH_TOKEN } from "../context.js";
import { agentCapabilities } from "../agent-state.js";
import { verifyAgentRequest, hasMeshToken } from "../auth.js";

// #41: authenticated, double-signed, balance-checked, persistently deduped BLE settlement.
const bleSyncSchema = createBleSyncSchema();
const syncedBLETxIds = new Set<string>(); // non-PG mode only
const inMemoryBleTransfer = createInMemoryBleTransfer(creditEngine, syncedBLETxIds);

export function registerBleSyncRoutes(app: CoordinatorApp): void {
  app.post("/credits/ble-sync", async (req, reply) => {
    // Unsigned callers fall through to the (configured) mesh-token check below.
    const verified = await verifyAgentRequest(req.headers as any, "/credits/ble-sync", req.ip, { allowUnsigned: true, rawBody: rawBodyOf(req) });
    if (!isBleSyncAuthorized(verified, MESH_AUTH_TOKEN !== "", hasMeshToken(req.headers as any))) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = bleSyncSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_ble_sync_body", detail: parsed.error.message });
    }
    const body = parsed.data;
    const { applied, skipped } = await applyBleSyncBatch(body.transactions, {
      getPublicKeyPem: (agentId) => agentCapabilities.get(agentId)?.publicKeyPem,
      rewardAccountForAgent,
      allowV1: bleSyncAllowV1(),
      transfer: (tx, requesterAccountId, providerAccountId) =>
        pgStore
          ? pgStore.applyBleTransfer({ txId: tx.txId, requesterAccountId, providerAccountId, credits: tx.credits })
          : inMemoryBleTransfer(tx, requesterAccountId, providerAccountId)
    });
    return reply.send({ applied, skipped, total: body.transactions.length });
  });
}

import { createHash } from "node:crypto";
import type { BLETaskRequest, BLETaskResponse } from "../../../../src/common/types.js";
import { BleCosignProvider } from "../../../../src/mesh/ble/ble-cosign.js";
import type { BLETransport } from "../../../../src/mesh/ble/ble-transport.js";
import { createPeerKeys } from "../../../../src/mesh/peer.js";

/** One Ed25519 key pair per agent id, shared across a test file (stands in for /register). */
const keyCache = new Map<string, ReturnType<typeof createPeerKeys>>();
export function keysFor(agentId: string) {
  let keys = keyCache.get(agentId);
  if (!keys) {
    keys = createPeerKeys(agentId);
    keyCache.set(agentId, keys);
  }
  return keys;
}

/** BLEMeshManager options for a requester that can sign its side of the transaction. */
export function requesterOptions(agentId: string) {
  return { privateKeyPem: keysFor(agentId).privateKeyPem };
}

/**
 * Register `handler` as the provider's task handler and wire the #63 co-sign step the way
 * worker-runner.ts does: completed tasks are remembered and later co-signed with the agent's key.
 */
export function serveWithCosign(
  transport: BLETransport,
  agentId: string,
  handler: (req: BLETaskRequest) => Promise<BLETaskResponse>,
  accountId = agentId
): BleCosignProvider {
  const cosigner = new BleCosignProvider({
    agentId,
    accountId: () => accountId,
    privateKeyPem: keysFor(agentId).privateKeyPem,
    modelParamSize: () => transport.currentAdvertisement()?.modelParamSize ?? 0
  });
  transport.onTaskRequest(async (req) => {
    const response = await handler(req);
    if (response.status !== "completed") return response;
    const taskHash = createHash("sha256").update(req.task).digest("hex");
    cosigner.recordServed(req.requestId, req.requesterId, taskHash, Math.round(response.cpuSeconds * 1000));
    return { ...response, providerAccountId: accountId };
  });
  transport.onCosignRequest((req) => cosigner.handle(req));
  return cosigner;
}

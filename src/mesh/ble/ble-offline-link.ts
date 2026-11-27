// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The agent side of Bluetooth failover (src/inference-api/bluetooth-failover.ts): the app's calls
 * reach it on the local forwarder (/forward/ble/*). It lists nearby devices, marking the ones the
 * user allowed (ble-offline-consent.ts, read on every call so a change applies at once), and runs a
 * prompt on an allowed device only; any other agent id is refused before anything is sent.
 *
 * The request is the mesh's ordinary task request (signed, with the mesh-token proof the Mac
 * providers ask for), sent straight to that device. It skips the co-sign step on purpose: no credit
 * record is made, so nothing is paid or charged for these calls.
 */

import { createHash, randomUUID } from "node:crypto";
import type { BLETaskRequest } from "../../common/types.js";
import type { ForwarderBlePeer, LocalForwarderBle } from "../../swarm/local-forwarder.js";
import { bleOfflineAllowed, defaultDeviceName, loadBleOfflineConsent, type BleOfflineConsent } from "./ble-offline-consent.js";
import { bleRequestProof } from "./ble-request-guard.js";
import type { BLETransport } from "./ble-transport.js";

export interface BleOfflineLinkDeps {
  agentId: string;
  transport: Pick<BLETransport, "discoveredPeers" | "sendTaskRequest">;
  /** The mesh token, when an operator set one ("" otherwise: Mac providers then refuse). */
  meshToken: () => string;
  /** Signs the requester side of a task request (the agent's key). */
  sign: (payload: string) => string;
  consent?: () => BleOfflineConsent;
  now?: () => number;
}

export function bleOfflineLink(deps: BleOfflineLinkDeps): LocalForwarderBle {
  const consent = deps.consent ?? (() => loadBleOfflineConsent());
  const now = deps.now ?? Date.now;
  return {
    nearby(): ForwarderBlePeer[] {
      const c = consent();
      const names = new Map(c.devices.map((d) => [d.agentId, d.name]));
      return deps.transport.discoveredPeers().map((p) => ({
        agentId: p.agentId,
        name: names.get(p.agentId) ?? defaultDeviceName(p.agentId),
        model: p.model,
        modelParamSize: p.modelParamSize,
        deviceType: p.deviceType,
        rssi: p.rssi,
        allowed: bleOfflineAllowed(p.agentId, c),
      }));
    },
    async run(agentId, prompt) {
      if (!bleOfflineAllowed(agentId, consent())) return { ok: false, error: "not_allowed" };
      const requestId = `ble-offline-${randomUUID()}`;
      const taskHash = createHash("sha256").update(prompt).digest("hex");
      const req: BLETaskRequest & { requesterIssuedAtMs?: number; requesterProof?: string } = {
        requestId,
        requesterId: deps.agentId,
        task: prompt,
        language: "python",
        requesterSignature: deps.sign(JSON.stringify({ requesterId: deps.agentId, taskHash })),
        ...(deps.meshToken() ? bleRequestProof(deps.meshToken(), { requestId, requesterId: deps.agentId, task: prompt }, now()) : {}),
      };
      const started = now();
      try {
        const resp = await deps.transport.sendTaskRequest(agentId, req);
        if (resp.status === "completed") return { ok: true, output: resp.output ?? "", ms: Math.max(0, now() - started) };
        return { ok: false, error: "failed", ...(resp.output ? { detail: String(resp.output).slice(0, 200) } : {}) };
      } catch (err) {
        return { ok: false, error: "failed", detail: String((err as Error)?.message ?? err).slice(0, 200) };
      }
    },
  };
}

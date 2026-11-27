// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The agent side of Bluetooth failover (src/inference-api/bluetooth-failover.ts): the app's calls
 * reach it on the local forwarder (/forward/ble/*). It lists nearby devices, marking the ones the
 * user allowed (ble-offline-consent.ts, read on every call so a change applies at once), and runs a
 * prompt only on an allowed device that still advertises the seal key pinned for it.
 *
 * The prompt is sealed to the pinned key (ble-seal.ts) before any byte goes out, and only a reply
 * that opens with the matching reply key counts, so a device that merely claims an allowed agent id
 * learns nothing and can't answer. A device advertising a different key, or none (an older version,
 * e.g. iOS before the sealed-request update), is skipped and never sent plain text; that is logged
 * once per device and key. No co-sign step, so no credit record: nothing is paid or charged.
 */

import { randomUUID } from "node:crypto";
import type { BLETaskRequest, BLETaskResponse } from "../../common/types.js";
import type { ForwarderBlePeer, LocalForwarderBle } from "../../swarm/local-forwarder.js";
import { bleOfflineAllowed, defaultDeviceName, loadBleOfflineConsent, pinnedSealKey, type BleOfflineConsent } from "./ble-offline-consent.js";
import { openBleResult, parseSealKey, sealBleTask, type SealKeyPair } from "./ble-seal.js";
import type { BLETransport } from "./ble-transport.js";

export interface BleOfflineLinkDeps {
  agentId: string;
  transport: Pick<BLETransport, "discoveredPeers" | "sendTaskRequest">;
  /** This agent's own seal key (bleSealKeyPairFromPem of its agent key). */
  ownKey: SealKeyPair;
  consent?: () => BleOfflineConsent;
  now?: () => number;
  log?: (line: string) => void;
}

export function bleOfflineLink(deps: BleOfflineLinkDeps): LocalForwarderBle {
  const consent = deps.consent ?? (() => loadBleOfflineConsent());
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const logged = new Set<string>();
  const once = (key: string, line: string) => {
    if (logged.has(key)) return;
    if (logged.size > 1000) logged.clear();
    logged.add(key);
    log(line);
  };
  return {
    nearby(): ForwarderBlePeer[] {
      const c = consent();
      return deps.transport.discoveredPeers().map((p) => {
        const pinned = c.devices.find((d) => d.agentId === p.agentId);
        return {
          agentId: p.agentId,
          name: pinned?.name ?? defaultDeviceName(p.agentId),
          model: p.model,
          modelParamSize: p.modelParamSize,
          deviceType: p.deviceType,
          rssi: p.rssi,
          ...(p.sealKey ? { sealKey: p.sealKey } : {}),
          // Allowed, sending on, and it still advertises the key pinned for it.
          allowed: bleOfflineAllowed(p.agentId, c) && !!pinned && pinned.sealKey === p.sealKey,
          ...(pinned ? { pinned: true, keyMatches: pinned.sealKey === p.sealKey } : {}),
        };
      });
    },
    async run(agentId, prompt) {
      const c = consent();
      const pinnedB64 = pinnedSealKey(agentId, c);
      if (!bleOfflineAllowed(agentId, c) || !pinnedB64) return { ok: false, error: "not_allowed" };
      const peer = deps.transport.discoveredPeers().find((p) => p.agentId === agentId);
      if (!peer) return { ok: false, error: "failed", detail: "not nearby" };
      if (!peer.sealKey) {
        once(`nokey|${agentId}`, `[BLE] skipping ${agentId}: it doesn't publish a seal key (needs a newer EdgeCoder version); nothing was sent`);
        return { ok: false, error: "key_mismatch", detail: "no seal key" };
      }
      if (peer.sealKey !== pinnedB64) {
        once(`mismatch|${agentId}|${peer.sealKey}`, `[BLE] skipping ${agentId}: it advertises a different key than the one pinned when it was allowed; nothing was sent`);
        return { ok: false, error: "key_mismatch" };
      }
      const responderKey = parseSealKey(pinnedB64);
      if (!responderKey) return { ok: false, error: "not_allowed" };
      const requestId = `ble-offline-${randomUUID()}`;
      const { message, replyKey } = sealBleTask({ responderKey, sender: deps.ownKey, requestId, requesterId: deps.agentId, task: prompt, issuedAtMs: now() });
      const started = now();
      let resp: BLETaskResponse;
      try {
        // The transport carries any JSON message; a sealed request in place of a plain task request.
        resp = await deps.transport.sendTaskRequest(agentId, message as unknown as BLETaskRequest);
      } catch (err) {
        return { ok: false, error: "failed", detail: String((err as Error)?.message ?? err).slice(0, 200) };
      }
      const body = openBleResult(resp, replyKey, requestId);
      if (!body) {
        // A plain refusal (not charging, not allowed there, an older version) or a reply that doesn't
        // open with the reply key: not from the pinned device, or nothing to use.
        const reason = (resp as { output?: unknown })?.output;
        return { ok: false, error: "failed", detail: typeof reason === "string" && reason.length < 120 ? reason : "no sealed reply" };
      }
      if (body.status !== "completed") return { ok: false, error: "failed", detail: body.output.slice(0, 200) };
      return { ok: true, output: body.output, ms: Math.max(0, now() - started) };
    },
  };
}

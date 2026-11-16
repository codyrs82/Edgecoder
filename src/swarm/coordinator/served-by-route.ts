// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** served-by.ts wired to this coordinator's agent table and mask key, for /inference/stream. */

import { rewardAccountForAgent } from "../../credits/store.js";
import { describeServed, type ServedBy } from "../served-by.js";
import { worldMaskKey } from "../network-world.js";
import { agentCapabilities } from "./agent-state.js";
import { coordinatorKeys } from "./context.js";
import { effectiveHardware } from "./economy.js";

let key: Buffer | null = null;

export async function servedBy(
  agentId: string,
  requesterAccountId: string | undefined,
  b: { pickupMs?: number; promptMs?: number; genMs?: number; promptTokens?: number; outputTokens?: number },
): Promise<ServedBy | undefined> {
  const cap = agentCapabilities.get(agentId);
  if (!cap) return undefined;
  key ??= worldMaskKey(coordinatorKeys.privateKeyPem);
  const hw = effectiveHardware(agentId, cap);
  const owner = await rewardAccountForAgent(agentId).catch(() => null);
  return describeServed(key, {
    agentId,
    ownerAccountId: owner ?? null,
    requesterAccountId: requesterAccountId ?? "",
    os: cap.os,
    clientType: cap.clientType,
    computeClass: hw?.computeClass ?? cap.computeClass,
    tier: hw?.tier ?? null,
    hardwareProfile: cap.hardwareProfile,
    region: cap.region ?? null,
    countryCode: cap.countryCode ?? null,
    timings: { pickupMs: b.pickupMs, promptMs: b.promptMs, genMs: b.genMs, promptTokens: b.promptTokens, outputTokens: b.outputTokens },
  });
}

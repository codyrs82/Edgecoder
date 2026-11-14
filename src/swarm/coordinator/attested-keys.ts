// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent signing keys this coordinator has attested.
 */
import { pgStore } from "../../db/store.js";
import { app } from "./app.js";
import { identity } from "./context.js";
import { agentCapabilities } from "./agent-state.js";

/** #122: agent keys this coordinator trusts: its own registration plus the shared key table. */
export async function trustedAgentSigningKeys(agentId: string): Promise<string[]> {
  const keys = new Set<string>((await pgStore?.listAgentSigningKeys(agentId)) ?? []);
  const local = agentCapabilities.get(agentId)?.publicKeyPem;
  if (local) keys.add(local);
  return [...keys];
}

const attestedAgentKeys = new Set<string>();
export function attestAgentSigningKey(agentId: string, publicKeyPem: string): void {
  if (!pgStore) return;
  const k = `${agentId}\n${publicKeyPem}`;
  if (attestedAgentKeys.has(k)) return;
  attestedAgentKeys.add(k);
  void pgStore.recordAgentSigningKey(agentId, publicKeyPem, identity.peerId).catch((error) => {
    attestedAgentKeys.delete(k);
    app.log.warn({ error, agentId }, "agent_signing_key_record_failed");
  });
}

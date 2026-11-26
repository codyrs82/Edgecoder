// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Which key opens an envelope result (src/security/envelope.ts).
 *
 * A subtask's envelope key is derived from the coordinator's per-subtask ephemeral key and the
 * claiming agent's X25519 key, so each agent that claims the same subtask has its own key. The
 * coordinator caches the key of the latest claim per subtask. Network run 17
 * (inf-1795701785966-351be87d): the first host handed its claim back (critical memory pressure)
 * while its finished result was on the way, a second host claimed the call and its key replaced
 * the first one's in the cache, and the first host's retries were then checked against the
 * second host's key: two AES-GCM authentication failures for a valid result.
 *
 * The cached key is used only for the agent it was made for. Otherwise (or when it does not open
 * the result) the key is re-derived for the agent that signed the result, from its registered
 * key. Every candidate is a key that agent legitimately shares for this subtask, and each is still
 * checked by AES-GCM: a result that authenticates under neither is refused as before.
 */

import { decryptResult, rederiveEnvelopeSharedKey, type EncryptedResult } from "../security/envelope.js";

export interface CachedEnvelopeKey {
  key: Buffer;
  createdAtMs: number;
  /** The agent whose claim this key was made for (entries from before this field: unknown). */
  agentId?: string;
}

export type EnvelopeKeySource = "cache" | "rederived";

export interface EnvelopeKeyCandidate {
  key: Buffer;
  source: EnvelopeKeySource;
}

/** The keys to try, in order, for a result from `agentId`. Empty when none can be had. */
export function envelopeResultKeyCandidates(args: {
  cached: CachedEnvelopeKey | undefined;
  subtaskId: string;
  agentId: string | undefined;
  /** The submitting agent's registered X25519 public key (base64), if known. */
  agentX25519?: string;
  rootSecret: Buffer;
}): EnvelopeKeyCandidate[] {
  const out: EnvelopeKeyCandidate[] = [];
  const { cached } = args;
  // An entry without an agent id (made before the field existed) is used as before.
  if (cached && (cached.agentId === undefined || cached.agentId === args.agentId)) out.push({ key: cached.key, source: "cache" });
  if (args.agentId && args.agentX25519) {
    try {
      const key = rederiveEnvelopeSharedKey(args.rootSecret, args.subtaskId, Buffer.from(args.agentX25519, "base64"));
      if (!out.some((c) => c.key.equals(key))) out.push({ key, source: "rederived" });
    } catch {
      // a malformed registered key: nothing to re-derive
    }
  }
  return out;
}

export type OpenEnvelopeResult =
  | { ok: true; result: ReturnType<typeof decryptResult>; source: EnvelopeKeySource }
  | { ok: false; error: string; tried: EnvelopeKeySource[] };

/** Opens the result with the first candidate key that authenticates it. */
export function openEnvelopeResult(encrypted: EncryptedResult, candidates: EnvelopeKeyCandidate[]): OpenEnvelopeResult & { key?: Buffer } {
  let error = "no_key";
  for (const c of candidates) {
    try {
      return { ok: true, result: decryptResult(encrypted, c.key), source: c.source, key: c.key };
    } catch (err) {
      error = String(err);
    }
  }
  return { ok: false, error, tried: candidates.map((c) => c.source) };
}

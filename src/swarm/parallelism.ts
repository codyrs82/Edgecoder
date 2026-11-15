// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Model calls a machine runs at once (and the OLLAMA_NUM_PARALLEL its Ollama is started with:
 * src/install/services.ts, the desktop app's local_compute.rs). Serving several requests together
 * raises tokens per second and, more to the point for a requester, a second request starts at once
 * instead of waiting behind the first.
 *
 * Without the model: by memory, 4 with 32 GB or more, 2 with 16 GB, else 1 (what the desktop app
 * starts Ollama with). With the model (its size from the tag, e.g. "qwen2.5-coder:1.5b"): as many
 * slots as fit next to the model in the usable memory, at most 2 below 31 GB and 4 above:
 *   usable   = memory × 0.6 (RAM: the OS and the agent need the rest) or × 0.9 (a GPU's VRAM)
 *   model    = params(B) × 0.6 GB (4-bit weights) + 0.5 GB (runtime)
 *   per slot = max(0.25 GB, params(B) × 0.12 GB): the KV cache of an 8k-token context
 *   slots    = clamp(floor((usable − model) / per slot), 1, cap)
 * So a 4 GB CPU agent with a 1.5B model runs 2 calls; 8 GB with a 7B model, 1.
 *
 * AGENT_PARALLEL_INFERENCE (1-16) overrides. When OLLAMA_NUM_PARALLEL is set (the same machine's
 * Ollama), the computed default never exceeds it: a call past Ollama's slots queues inside Ollama.
 */
export function parallelInferenceFor(
  totalMemBytes: number,
  override?: string,
  opts: { modelParamsB?: number; gpu?: boolean; ollamaNumParallel?: string } = {}
): number {
  const n = Number(override);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  const gb = totalMemBytes / 1024 ** 3;
  let slots: number;
  const b = opts.modelParamsB;
  if (b !== undefined && Number.isFinite(b) && b > 0) {
    const usable = gb * (opts.gpu ? 0.9 : 0.6);
    const modelGb = b * 0.6 + 0.5;
    const perSlotGb = Math.max(0.25, b * 0.12);
    const cap = gb >= 31 ? 4 : 2;
    slots = Math.max(1, Math.min(cap, Math.floor((usable - modelGb) / perSlotGb)));
  } else {
    slots = gb >= 31 ? 4 : gb >= 15 ? 2 : 1;
  }
  const ollama = Number(opts.ollamaNumParallel);
  if (Number.isInteger(ollama) && ollama >= 1) slots = Math.min(slots, ollama);
  return slots;
}

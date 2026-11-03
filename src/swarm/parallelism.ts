// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Model calls a machine runs at once. The desktop app starts Ollama with the same number of
 * parallel slots (local_compute.rs): 4 with 32 GB or more, 2 with 16 GB, else 1. Serving several
 * requests together raises tokens per second, which lowers what each token costs to make.
 * AGENT_PARALLEL_INFERENCE overrides.
 */
export function parallelInferenceFor(totalMemBytes: number, override?: string): number {
  const n = Number(override);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  const gb = totalMemBytes / 1024 ** 3;
  return gb >= 31 ? 4 : gb >= 15 ? 2 : 1;
}

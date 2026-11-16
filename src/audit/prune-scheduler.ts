// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { moduleLogger } from "../common/logger.js";

const logger = moduleLogger("prune-scheduler");

export interface PrunableStore {
  noncePrune(): Promise<number>;
  meshMessagePrune(): Promise<number>;
}

export function startPruneScheduler(
  store: PrunableStore,
  intervalMs: number = 5 * 60_000
): NodeJS.Timeout {
  return setInterval(async () => {
    const nonces = await store.noncePrune();
    const messages = await store.meshMessagePrune();
    if (nonces > 0 || messages > 0) {
      logger.info({ nonces, messages }, "pruned nonces and mesh messages");
    }
  }, intervalMs);
}

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
      console.log(`pruned ${nonces} nonces, ${messages} mesh messages`);
    }
  }, intervalMs);
}

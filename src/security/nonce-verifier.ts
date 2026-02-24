export interface NonceStore {
  exists(nonce: string): Promise<boolean>;
  insert(nonce: string, sourceId: string, expiresAtMs: number): Promise<void>;
  prune(): Promise<void>;
}

export interface NonceCheckParams {
  nonce: string;
  sourceId: string;
  timestampMs: number;
  maxSkewMs: number;
  ttlMs?: number;
}

export interface NonceCheckResult {
  valid: boolean;
  reason?: "replay" | "timestamp_skew";
}

const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes

export async function verifyNonce(
  store: NonceStore,
  params: NonceCheckParams
): Promise<NonceCheckResult> {
  const { nonce, sourceId, timestampMs, maxSkewMs, ttlMs = DEFAULT_TTL_MS } = params;
  const now = Date.now();
  const skew = Math.abs(now - timestampMs);

  if (skew > maxSkewMs) {
    return { valid: false, reason: "timestamp_skew" };
  }

  if (await store.exists(nonce)) {
    return { valid: false, reason: "replay" };
  }

  await store.insert(nonce, sourceId, now + ttlMs);
  return { valid: true };
}

/**
 * In-memory implementation for tests and development.
 * Production uses PostgresNonceStore.
 */
export class InMemoryNonceStore implements NonceStore {
  private entries = new Map<string, { sourceId: string; expiresAtMs: number }>();

  async exists(nonce: string): Promise<boolean> {
    return this.entries.has(nonce);
  }

  async insert(nonce: string, sourceId: string, expiresAtMs: number): Promise<void> {
    this.entries.set(nonce, { sourceId, expiresAtMs });
  }

  async prune(): Promise<void> {
    const now = Date.now();
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAtMs < now) {
        this.entries.delete(nonce);
      }
    }
  }
}

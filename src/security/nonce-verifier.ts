// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export interface NonceStore {
  exists(nonce: string): Promise<boolean>;
  insert(nonce: string, sourceId: string, expiresAtMs: number): Promise<void>;
  /**
   * Atomic check-and-record: true when the nonce was new and is now stored, false when it was
   * already present. Stores shared by several coordinators must make this a single operation
   * (Postgres: INSERT ... ON CONFLICT DO NOTHING), or two instances could both accept a replay.
   */
  insertIfAbsent?(nonce: string, sourceId: string, expiresAtMs: number): Promise<boolean>;
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

/**
 * A request is accepted while |now - timestamp| <= maxSkewMs, so one signed at the far edge of
 * the window stays acceptable for up to 2 x maxSkewMs after it is first seen. The nonce must be
 * remembered at least that long, whatever TTL is configured.
 */
export function effectiveNonceTtlMs(ttlMs: number, maxSkewMs: number): number {
  return Math.max(ttlMs, 2 * maxSkewMs + 1_000);
}

export async function verifyNonce(
  store: NonceStore,
  params: NonceCheckParams
): Promise<NonceCheckResult> {
  const { nonce, sourceId, timestampMs, maxSkewMs, ttlMs = DEFAULT_TTL_MS } = params;
  const now = Date.now();
  const skew = Math.abs(now - timestampMs);

  if (!Number.isFinite(skew) || skew > maxSkewMs) {
    return { valid: false, reason: "timestamp_skew" };
  }

  const expiresAtMs = now + effectiveNonceTtlMs(ttlMs, maxSkewMs);
  if (store.insertIfAbsent) {
    return (await store.insertIfAbsent(nonce, sourceId, expiresAtMs)) ? { valid: true } : { valid: false, reason: "replay" };
  }
  if (await store.exists(nonce)) {
    return { valid: false, reason: "replay" };
  }

  await store.insert(nonce, sourceId, expiresAtMs);
  return { valid: true };
}

/**
 * In-memory implementation for tests, development and coordinators without Postgres.
 * Production with DATABASE_URL uses PostgresNonceStore (src/db/postgres.ts), which survives
 * restarts and is shared by every coordinator on the same database.
 */
export class InMemoryNonceStore implements NonceStore {
  private entries = new Map<string, { sourceId: string; expiresAtMs: number }>();

  async exists(nonce: string): Promise<boolean> {
    const entry = this.entries.get(nonce);
    return entry !== undefined && entry.expiresAtMs >= Date.now();
  }

  async insert(nonce: string, sourceId: string, expiresAtMs: number): Promise<void> {
    this.entries.set(nonce, { sourceId, expiresAtMs });
  }

  async insertIfAbsent(nonce: string, sourceId: string, expiresAtMs: number): Promise<boolean> {
    if (await this.exists(nonce)) return false;
    this.entries.set(nonce, { sourceId, expiresAtMs });
    return true;
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

/**
 * Durable store with an in-memory fallback: if the database is unreachable a request is checked
 * against (and recorded in) the local cache instead of failing every agent call, and the error is
 * reported once per outage. Replays across instances are only caught while the database is up.
 */
export class FallbackNonceStore implements NonceStore {
  private readonly local = new InMemoryNonceStore();
  private degraded = false;

  constructor(
    private readonly primary: NonceStore & { insertIfAbsent(nonce: string, sourceId: string, expiresAtMs: number): Promise<boolean> },
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  private fail(error: unknown): void {
    if (!this.degraded) this.onError(error);
    this.degraded = true;
  }

  async exists(nonce: string): Promise<boolean> {
    if (await this.local.exists(nonce)) return true;
    try {
      const found = await this.primary.exists(nonce);
      this.degraded = false;
      return found;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async insert(nonce: string, sourceId: string, expiresAtMs: number): Promise<void> {
    await this.insertIfAbsent(nonce, sourceId, expiresAtMs);
  }

  async insertIfAbsent(nonce: string, sourceId: string, expiresAtMs: number): Promise<boolean> {
    // The local cache also catches a replay to this instance while the database is down.
    if (!(await this.local.insertIfAbsent(nonce, sourceId, expiresAtMs))) return false;
    try {
      const fresh = await this.primary.insertIfAbsent(nonce, sourceId, expiresAtMs);
      this.degraded = false;
      return fresh;
    } catch (error) {
      this.fail(error);
      return true;
    }
  }

  async prune(): Promise<void> {
    await this.local.prune();
    try {
      await this.primary.prune();
    } catch (error) {
      this.fail(error);
    }
  }
}

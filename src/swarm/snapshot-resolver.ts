// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Frozen Snapshot Resolver — Design Decision #8
 *
 * Every swarm job receives a commit hash or tarball reference.
 * No live filesystem access is allowed, ensuring reproducible builds.
 */

export interface ResolvedSnapshot {
  type: "git_commit" | "tarball";
  ref: string;              // commit hash or URL
  localPath?: string;       // path to checked-out/extracted snapshot
  resolvedAtMs: number;
}

const SHA1_HEX_RE = /^[0-9a-f]{40}$/i;
const HTTPS_URL_RE = /^https:\/\/.+/;

/** In-memory cache keyed by the raw snapshotRef string. */
const resolvedCache = new Map<string, ResolvedSnapshot>();

/**
 * Validate that a snapshotRef string conforms to one of the accepted formats:
 *  - 40-character hexadecimal SHA-1 commit hash
 *  - HTTPS tarball URL
 *
 * Returns true if the ref is valid, false otherwise.
 */
export function isValidSnapshotRef(ref: string): boolean {
  if (!ref || typeof ref !== "string") return false;
  return SHA1_HEX_RE.test(ref) || HTTPS_URL_RE.test(ref);
}

/**
 * Classify a validated snapshot ref into its type.
 * Throws if the ref is invalid.
 */
function classifyRef(ref: string): "git_commit" | "tarball" {
  if (SHA1_HEX_RE.test(ref)) return "git_commit";
  if (HTTPS_URL_RE.test(ref)) return "tarball";
  throw new Error(`Invalid snapshotRef: must be a 40-char hex commit hash or an https:// tarball URL. Got: "${ref}"`);
}

/**
 * Resolve a snapshot reference into a ResolvedSnapshot.
 *
 * For git commits (40 hex chars): validates format, records as git_commit type.
 * For tarball URLs (https://): validates URL format, records as tarball type.
 * Results are cached so the same ref is not re-resolved.
 */
export async function resolveSnapshot(snapshotRef: string): Promise<ResolvedSnapshot> {
  if (!snapshotRef || typeof snapshotRef !== "string") {
    throw new Error("snapshotRef must be a non-empty string");
  }

  // Return cached result if available
  const cached = resolvedCache.get(snapshotRef);
  if (cached) return cached;

  const type = classifyRef(snapshotRef);

  const resolved: ResolvedSnapshot = {
    type,
    ref: snapshotRef,
    resolvedAtMs: Date.now(),
  };

  resolvedCache.set(snapshotRef, resolved);
  return resolved;
}

/**
 * Clear the resolver cache. Useful for testing.
 */
export function clearSnapshotCache(): void {
  resolvedCache.clear();
}

/**
 * Return the current number of cached entries. Useful for testing.
 */
export function snapshotCacheSize(): number {
  return resolvedCache.size;
}

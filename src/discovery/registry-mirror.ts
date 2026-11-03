// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Coordinators mirror the portal's signed registry at their own GET /network/registry, so the one
// platform URL (coordinator.edgecoder.io, which lands on a seed) also hands it out. The mirror is
// untrusted by design: clients verify the signature, so it only caches and relays the document.

import type { FetchLike } from "./selector.js";

export interface RegistryMirrorOptions {
  upstreamUrl: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Reuse a fetched copy this long (default 30 s). */
  ttlMs?: number;
  timeoutMs?: number;
}

export interface RegistryMirror {
  /** The latest document (a stale copy when the upstream is down), or null when none was ever fetched. */
  get(): Promise<unknown | null>;
}

export function createRegistryMirror(opts: RegistryMirrorOptions): RegistryMirror {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 4000;
  let cached: { at: number; doc: unknown } | null = null;
  let inFlight: Promise<unknown | null> | null = null;
  const refresh = async (): Promise<unknown | null> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(opts.upstreamUrl, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal });
      if (res.status < 200 || res.status >= 300) return cached?.doc ?? null;
      const doc = (await res.json()) as { format?: unknown } | null;
      if (!doc || typeof doc !== "object" || typeof doc.format !== "string") return cached?.doc ?? null;
      cached = { at: now(), doc };
      return doc;
    } catch {
      return cached?.doc ?? null;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async get() {
      if (cached && now() - cached.at < ttl) return cached.doc;
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
  };
}

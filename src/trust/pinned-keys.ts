// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fingerprintMatches, publicKeyFingerprint } from "../security/key-fingerprint.js";

/*
 * Architecture step 4: pinned-key trust. An agent only works for coordinators whose
 * Ed25519 public key it trusts. Keys are identified by `peerId:fingerprint`, the system-wide
 * sha256 of the SPKI DER (src/security/key-fingerprint.ts; GET /identity reports it).
 *
 *   TRUSTED_COORDINATOR_KEYS   comma-separated peerId:fingerprint entries (always pinned)
 *   EDGECODER_TRUST_FILE       file with one entry per line ("#" comments); in tofu mode
 *                              first-seen keys are appended here
 *   EDGECODER_TRUST_MODE       tofu (default) | strict | open
 *
 *   tofu    first key seen for a peerId is pinned; a later different key is refused
 *   strict  only listed keys are trusted; nothing is pinned automatically
 *   open    every key is trusted (mismatches are reported but not enforced)
 */

export type TrustMode = "tofu" | "strict" | "open";

export type TrustReason =
  | "pinned_match"
  | "registry_match"
  | "pinned_mismatch"
  | "tofu_pinned"
  | "strict_unlisted"
  | "open"
  | "open_mismatch";

export interface TrustDecision {
  trusted: boolean;
  reason: TrustReason;
  mode: TrustMode;
  peerId: string;
  fingerprint: string;
  /** Fingerprint on file when it differs from the presented key. */
  pinnedFingerprint?: string;
  /** tofu only: whether the new pin reached the trust file. */
  persisted?: boolean;
}

export const DEFAULT_TRUST_FILE = join(homedir(), ".edgecoder", "trusted-coordinators");

/**
 * The system-wide key fingerprint: sha256 hex of the SPKI DER (src/security/key-fingerprint.ts).
 * Pins written by older builds (sha256 of the PEM text) still match; see fingerprintMatches.
 */
export function fingerprint(publicKeyPem: string): string {
  return publicKeyFingerprint(publicKeyPem);
}

export function parseTrustMode(value: string | undefined, fallback: TrustMode = "tofu"): TrustMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "tofu" || v === "strict" || v === "open") return v;
  if (v !== "") throw new Error(`EDGECODER_TRUST_MODE must be tofu, strict or open, got "${value}"`);
  return fallback;
}

const ENTRY_RE = /^([^:\s,]+):([0-9a-fA-F]{64})$/;

/** Parse "peerId:fingerprint" entries separated by commas and/or newlines; "#" starts a comment. */
export function parseTrustEntries(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = ENTRY_RE.exec(line);
    if (!m) throw new Error(`invalid trusted coordinator entry "${line}" (expected peerId:sha256hex)`);
    out.set(m[1], m[2].toLowerCase());
  }
  return out;
}

export interface PinnedKeyStoreOptions {
  mode?: TrustMode;
  /** Static entries (env list); these win over the file and are never rewritten. */
  entries?: Map<string, string> | string;
  /** Trust file read at construction and, in tofu mode, appended to. */
  pinFile?: string | null;
  now?: () => number;
}

export class PinnedKeyStore {
  readonly mode: TrustMode;
  readonly pinFile: string | null;
  private readonly staticEntries: Map<string, string>;
  private readonly pinned = new Map<string, string>();
  private registryEntries = new Map<string, string>();
  private readonly now: () => number;

  constructor(opts: PinnedKeyStoreOptions = {}) {
    this.mode = opts.mode ?? "tofu";
    this.pinFile = opts.pinFile === undefined ? DEFAULT_TRUST_FILE : opts.pinFile;
    this.staticEntries = typeof opts.entries === "string" ? parseTrustEntries(opts.entries) : new Map(opts.entries ?? []);
    this.now = opts.now ?? Date.now;
    if (this.pinFile && existsSync(this.pinFile)) {
      for (const [peerId, fp] of parseTrustEntries(readFileSync(this.pinFile, "utf8"))) this.pinned.set(peerId, fp);
    }
  }

  /** Build from TRUSTED_COORDINATOR_KEYS / EDGECODER_TRUST_FILE / EDGECODER_TRUST_MODE. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, defaults: { pinFile?: string } = {}): PinnedKeyStore {
    return new PinnedKeyStore({
      mode: parseTrustMode(env.EDGECODER_TRUST_MODE),
      entries: env.TRUSTED_COORDINATOR_KEYS,
      pinFile: env.EDGECODER_TRUST_FILE || defaults.pinFile || DEFAULT_TRUST_FILE
    });
  }

  /** Every known entry: static ones first, then pins from the file. */
  list(): Array<{ peerId: string; fingerprint: string; source: "static" | "pinned" }> {
    const out: Array<{ peerId: string; fingerprint: string; source: "static" | "pinned" }> = [];
    for (const [peerId, fp] of this.staticEntries) out.push({ peerId, fingerprint: fp, source: "static" });
    for (const [peerId, fp] of this.pinned) {
      if (!this.staticEntries.has(peerId)) out.push({ peerId, fingerprint: fp, source: "pinned" });
    }
    return out;
  }

  /**
   * Keys from the signed coordinator registry (src/discovery/steering.ts), replaced on every
   * verified registry. They count as listed (strict mode trusts them); a static entry for the same
   * peerId still wins, and they are never written to the trust file.
   */
  setRegistryEntries(entries: Map<string, string>): void {
    this.registryEntries = new Map([...entries].map(([peerId, fp]) => [peerId, fp.toLowerCase()]));
  }

  knownFingerprint(peerId: string): string | undefined {
    return this.staticEntries.get(peerId) ?? this.registryEntries.get(peerId) ?? this.pinned.get(peerId);
  }

  private knownSource(peerId: string): "static" | "registry" | "pinned" | undefined {
    if (this.staticEntries.has(peerId)) return "static";
    if (this.registryEntries.has(peerId)) return "registry";
    if (this.pinned.has(peerId)) return "pinned";
    return undefined;
  }

  /** Number of keys this store can match (static entries plus file pins). */
  size(): number {
    return this.list().length;
  }

  /**
   * Configuration that cannot work, reported at startup instead of refusing every coordinator:
   * strict mode with nothing listed.
   */
  configProblem(): string | null {
    if (this.mode === "strict" && this.size() === 0) {
      return "EDGECODER_TRUST_MODE=strict but no coordinator keys are listed: set TRUSTED_COORDINATOR_KEYS=peerId:fingerprint[,...] (GET /identity on each coordinator reports its trustEntry) or list them in EDGECODER_TRUST_FILE";
    }
    return null;
  }

  /**
   * Whether `isTrusted` would accept this key, without pinning anything (candidate filtering).
   * A key-less candidate is not known to be trusted.
   */
  wouldTrust(peerId: string | undefined, publicKeyPem: string | undefined): boolean {
    if (!peerId || !publicKeyPem) return false;
    const known = this.knownFingerprint(peerId);
    if (known !== undefined) return this.mode === "open" || fingerprintMatches(known, publicKeyPem);
    return this.mode !== "strict";
  }

  isTrusted(peerId: string, publicKeyPem: string): TrustDecision {
    const fp = fingerprint(publicKeyPem);
    const base = { mode: this.mode, peerId, fingerprint: fp };
    const known = this.knownFingerprint(peerId);
    if (known !== undefined) {
      if (known === fp || fingerprintMatches(known, publicKeyPem)) {
        return { ...base, trusted: true, reason: this.knownSource(peerId) === "registry" ? "registry_match" : "pinned_match" };
      }
      if (this.mode === "open") return { ...base, trusted: true, reason: "open_mismatch", pinnedFingerprint: known };
      return { ...base, trusted: false, reason: "pinned_mismatch", pinnedFingerprint: known };
    }
    switch (this.mode) {
      case "open":
        return { ...base, trusted: true, reason: "open" };
      case "strict":
        return { ...base, trusted: false, reason: "strict_unlisted" };
      case "tofu": {
        this.pinned.set(peerId, fp);
        const persisted = this.persistPin(peerId, fp);
        return { ...base, trusted: true, reason: "tofu_pinned", persisted };
      }
    }
  }

  private persistPin(peerId: string, fp: string): boolean {
    if (!this.pinFile) return false;
    try {
      mkdirSync(dirname(this.pinFile), { recursive: true });
      appendFileSync(this.pinFile, `${peerId}:${fp} # pinned ${new Date(this.now()).toISOString()}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
}

let defaultStore: PinnedKeyStore | null = null;

/** Process-wide store built from the environment on first use. */
export function defaultPinnedKeyStore(): PinnedKeyStore {
  if (!defaultStore) defaultStore = PinnedKeyStore.fromEnv();
  return defaultStore;
}

export function isTrusted(peerId: string, publicKeyPem: string, store: PinnedKeyStore = defaultPinnedKeyStore()): TrustDecision {
  return store.isTrusted(peerId, publicKeyPem);
}

/* ------------------------------------------------------------------ */
/*  Agent side: check a coordinator before registering with it         */
/* ------------------------------------------------------------------ */

export type IdentityFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CoordinatorTrustCheck {
  trusted: boolean;
  coordinatorUrl: string;
  peerId?: string;
  decision?: TrustDecision;
  error?: string;
}

/** GET /identity on the coordinator and run its key through the store. Network errors are untrusted. */
export async function checkCoordinatorTrust(
  coordinatorUrl: string,
  opts: { store?: PinnedKeyStore; fetch?: IdentityFetch; timeoutMs?: number } = {}
): Promise<CoordinatorTrustCheck> {
  const store = opts.store ?? defaultPinnedKeyStore();
  const doFetch = opts.fetch ?? (globalThis.fetch as IdentityFetch);
  const base = coordinatorUrl.replace(/\/+$/, "");
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000) : undefined;
  try {
    const res = await doFetch(`${base}/identity`, { headers: { accept: "application/json" }, signal: controller?.signal });
    if (!res.ok) return { trusted: false, coordinatorUrl, error: `identity_http_${res.status}` };
    const body = (await res.json()) as { peerId?: unknown; publicKeyPem?: unknown };
    if (typeof body?.peerId !== "string" || typeof body?.publicKeyPem !== "string" || !body.publicKeyPem.includes("BEGIN PUBLIC KEY")) {
      return { trusted: false, coordinatorUrl, error: "identity_malformed" };
    }
    const decision = store.isTrusted(body.peerId, body.publicKeyPem);
    return { trusted: decision.trusted, coordinatorUrl, peerId: body.peerId, decision };
  } catch (error) {
    return { trusted: false, coordinatorUrl, error: String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Remembers which coordinator URLs already passed, so the worker loop re-checks a
 * coordinator only when it switches to a different URL (or after a failure).
 */
export class CoordinatorTrustGate {
  private readonly verified = new Set<string>();
  constructor(private readonly opts: { store?: PinnedKeyStore; fetch?: IdentityFetch; timeoutMs?: number } = {}) {}

  async check(coordinatorUrl: string): Promise<CoordinatorTrustCheck> {
    const key = coordinatorUrl.replace(/\/+$/, "");
    if (this.verified.has(key)) return { trusted: true, coordinatorUrl: key };
    const result = await checkCoordinatorTrust(key, this.opts);
    if (result.trusted) this.verified.add(key);
    return result;
  }

  forget(coordinatorUrl: string): void {
    this.verified.delete(coordinatorUrl.replace(/\/+$/, ""));
  }
}

export function describeTrustFailure(check: CoordinatorTrustCheck): string {
  if (check.error) return `could not verify coordinator identity (${check.error})`;
  const d = check.decision;
  if (!d) return "untrusted";
  switch (d.reason) {
    case "pinned_mismatch":
      return `key mismatch for ${d.peerId}: pinned ${d.pinnedFingerprint}, presented ${d.fingerprint} (mode=${d.mode})`;
    case "strict_unlisted":
      return `coordinator ${d.peerId} (${d.fingerprint}) is not in TRUSTED_COORDINATOR_KEYS (mode=strict)`;
    default:
      return `${d.reason} (mode=${d.mode})`;
  }
}

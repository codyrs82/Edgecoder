// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fingerprintMatches, publicKeyFingerprint } from "../security/key-fingerprint.js";
import { IDENTITY_CHALLENGE_PATH, newChallengeNonce, normalizeChallengeUrl, verifyIdentityChallenge } from "./identity-challenge.js";

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
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * required: the coordinator must prove possession of its key (POST /identity/challenge).
 * optional: a coordinator without the challenge route falls back to the public /identity check,
 *           with a warning. A challenge that is answered but fails verification is always refused.
 */
export type ChallengePolicy = "required" | "optional";

export interface CoordinatorTrustCheck {
  trusted: boolean;
  coordinatorUrl: string;
  peerId?: string;
  decision?: TrustDecision;
  error?: string;
  /** How possession of the key was established. */
  proof?: "challenge" | "identity_only";
  warning?: string;
}

export interface TrustCheckOptions {
  store?: PinnedKeyStore;
  fetch?: IdentityFetch;
  timeoutMs?: number;
  /** Default: required in strict mode, optional otherwise. */
  challenge?: ChallengePolicy;
}

/** Status codes an older coordinator returns for the challenge route it does not have. */
const CHALLENGE_UNSUPPORTED_STATUS = new Set([401, 404, 405, 501]);

/** EDGECODER_IDENTITY_CHALLENGE=required|optional; unset picks by trust mode. */
export function challengePolicyFromEnv(env: NodeJS.ProcessEnv, mode: TrustMode): ChallengePolicy {
  const v = (env.EDGECODER_IDENTITY_CHALLENGE ?? "").trim().toLowerCase();
  if (v === "required" || v === "optional") return v;
  if (v !== "") throw new Error(`EDGECODER_IDENTITY_CHALLENGE must be required or optional, got "${env.EDGECODER_IDENTITY_CHALLENGE}"`);
  return mode === "strict" ? "required" : "optional";
}

function validIdentity(body: { peerId?: unknown; publicKeyPem?: unknown } | null | undefined): body is { peerId: string; publicKeyPem: string } {
  return typeof body?.peerId === "string" && typeof body?.publicKeyPem === "string" && body.publicKeyPem.includes("BEGIN PUBLIC KEY");
}

/**
 * Verify a coordinator before working for it: it signs a fresh nonce (POST /identity/challenge)
 * and its key goes through the store. Nothing is pinned until the signature checks out. A
 * coordinator without the challenge route is refused under `challenge: "required"` and falls back
 * to the public GET /identity (warned) otherwise. Network errors are untrusted.
 */
export async function checkCoordinatorTrust(coordinatorUrl: string, opts: TrustCheckOptions = {}): Promise<CoordinatorTrustCheck> {
  const store = opts.store ?? defaultPinnedKeyStore();
  const policy = opts.challenge ?? (store.mode === "strict" ? "required" : "optional");
  const doFetch = opts.fetch ?? (globalThis.fetch as IdentityFetch);
  const base = normalizeChallengeUrl(coordinatorUrl);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000) : undefined;
  try {
    const sent = { nonce: newChallengeNonce(), url: base };
    // No mesh token here: the coordinator is not trusted yet.
    const res = await doFetch(`${base}${IDENTITY_CHALLENGE_PATH}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(sent),
      signal: controller?.signal
    });
    if (res.ok) {
      const answer = (await res.json()) as { peerId?: unknown; publicKeyPem?: unknown };
      if (!validIdentity(answer)) return { trusted: false, coordinatorUrl, error: "identity_malformed" };
      // Refusals (mismatch, unlisted) need no proof and must not pin.
      if (!store.wouldTrust(answer.peerId, answer.publicKeyPem)) {
        const decision = store.isTrusted(answer.peerId, answer.publicKeyPem);
        return { trusted: decision.trusted, coordinatorUrl, peerId: answer.peerId, decision, proof: "challenge" };
      }
      const verified = verifyIdentityChallenge(answer, sent, answer);
      if (!verified.ok) return { trusted: false, coordinatorUrl, peerId: answer.peerId, error: verified.error };
      const decision = store.isTrusted(answer.peerId, answer.publicKeyPem);
      return { trusted: decision.trusted, coordinatorUrl, peerId: answer.peerId, decision, proof: "challenge" };
    }
    if (!CHALLENGE_UNSUPPORTED_STATUS.has(res.status)) return { trusted: false, coordinatorUrl, error: `identity_challenge_http_${res.status}` };
    if (policy === "required") return { trusted: false, coordinatorUrl, error: "identity_challenge_unsupported" };

    const idRes = await doFetch(`${base}/identity`, { headers: { accept: "application/json" }, signal: controller?.signal });
    if (!idRes.ok) return { trusted: false, coordinatorUrl, error: `identity_http_${idRes.status}` };
    const body = (await idRes.json()) as { peerId?: unknown; publicKeyPem?: unknown };
    if (!validIdentity(body)) return { trusted: false, coordinatorUrl, error: "identity_malformed" };
    const decision = store.isTrusted(body.peerId, body.publicKeyPem);
    return {
      trusted: decision.trusted,
      coordinatorUrl,
      peerId: body.peerId,
      decision,
      proof: "identity_only",
      warning: `coordinator ${base} does not support ${IDENTITY_CHALLENGE_PATH}; its key was not proven (mode=${store.mode})`
    };
  } catch (error) {
    return { trusted: false, coordinatorUrl, error: String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default lifetime of a verification; after it the gate challenges the coordinator again. */
export const DEFAULT_TRUST_REVERIFY_MS = 10 * 60_000;

/**
 * Remembers which coordinator URLs passed, for at most `reverifyMs`: the worker loop re-checks a
 * coordinator when it switches URL, after forget() (reconnect, failure), and when the entry expires.
 */
export class CoordinatorTrustGate {
  private readonly verified = new Map<string, number>();
  private readonly reverifyMs: number;
  private readonly now: () => number;
  constructor(private readonly opts: TrustCheckOptions & { reverifyMs?: number; now?: () => number } = {}) {
    this.reverifyMs = Math.max(1_000, opts.reverifyMs ?? DEFAULT_TRUST_REVERIFY_MS);
    this.now = opts.now ?? Date.now;
  }

  async check(coordinatorUrl: string): Promise<CoordinatorTrustCheck> {
    const key = normalizeChallengeUrl(coordinatorUrl);
    const at = this.verified.get(key);
    if (at !== undefined && this.now() - at < this.reverifyMs) return { trusted: true, coordinatorUrl: key };
    this.verified.delete(key);
    const result = await checkCoordinatorTrust(key, this.opts);
    if (result.trusted) this.verified.set(key, this.now());
    return result;
  }

  forget(coordinatorUrl?: string): void {
    if (coordinatorUrl === undefined) this.verified.clear();
    else this.verified.delete(normalizeChallengeUrl(coordinatorUrl));
  }
}

export function describeTrustFailure(check: CoordinatorTrustCheck): string {
  if (check.error === "identity_challenge_unsupported") {
    return "coordinator does not prove possession of its key (no /identity/challenge); refused because the challenge is required (strict mode or EDGECODER_IDENTITY_CHALLENGE=required)";
  }
  if (check.error?.startsWith("challenge_")) return `coordinator failed the identity challenge (${check.error}): possible impersonation`;
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

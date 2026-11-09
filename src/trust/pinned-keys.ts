// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fingerprintMatches, publicKeyFingerprint } from "../security/key-fingerprint.js";
import { IDENTITY_CHALLENGE_PATH, canonicalCoordinatorUrl, newChallengeNonce, normalizeChallengeUrl, verifyIdentityChallenge } from "./identity-challenge.js";

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
 *   tofu    first key seen for a peerId is pinned; a later different key is refused. The first
 *           peerId trusted at a URL is bound to it (<trust file>.bindings.json): a different
 *           peerId at that URL is refused unless its key is listed (TRUSTED_COORDINATOR_KEYS or
 *           the signed registry)
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
  | "url_peer_mismatch"
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
  /** url_peer_mismatch: the peerId this URL is bound to. */
  boundPeerId?: string;
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
  /**
   * URL -> peerId bindings and the peers that proved their key with the identity challenge.
   * Default `<pinFile>.bindings.json`; null keeps them in memory only.
   */
  bindingFile?: string | null;
  now?: () => number;
}

export class PinnedKeyStore {
  readonly mode: TrustMode;
  readonly pinFile: string | null;
  private readonly staticEntries: Map<string, string>;
  private readonly pinned = new Map<string, string>();
  private registryEntries = new Map<string, string>();
  private readonly now: () => number;
  readonly bindingFile: string | null;
  private readonly urlPeers = new Map<string, string>();
  private readonly provenPeers = new Set<string>();

  constructor(opts: PinnedKeyStoreOptions = {}) {
    this.mode = opts.mode ?? "tofu";
    this.pinFile = opts.pinFile === undefined ? DEFAULT_TRUST_FILE : opts.pinFile;
    this.staticEntries = typeof opts.entries === "string" ? parseTrustEntries(opts.entries) : new Map(opts.entries ?? []);
    this.now = opts.now ?? Date.now;
    if (this.pinFile && existsSync(this.pinFile)) {
      for (const [peerId, fp] of parseTrustEntries(readFileSync(this.pinFile, "utf8"))) this.pinned.set(peerId, fp);
    }
    this.bindingFile = opts.bindingFile === undefined ? (this.pinFile ? `${this.pinFile}.bindings.json` : null) : opts.bindingFile;
    if (this.bindingFile && existsSync(this.bindingFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.bindingFile, "utf8")) as { urls?: unknown; proven?: unknown };
        if (raw.urls && typeof raw.urls === "object") {
          for (const [url, peerId] of Object.entries(raw.urls as Record<string, unknown>)) {
            if (typeof peerId === "string") this.urlPeers.set(url, peerId);
          }
        }
        if (Array.isArray(raw.proven)) for (const p of raw.proven) if (typeof p === "string") this.provenPeers.add(p);
      } catch {
        // A corrupt bindings file is ignored (bindings are rebuilt on use), never fatal.
      }
    }
  }

  /** The peerId first trusted at this coordinator URL, if any. */
  peerForUrl(url: string): string | undefined {
    const key = canonicalCoordinatorUrl(url);
    return key ? this.urlPeers.get(key) : undefined;
  }

  /** Whether this peer has proven its key with the identity challenge before. */
  hasProvenKey(peerId: string): boolean {
    return this.provenPeers.has(peerId);
  }

  /**
   * tofu: refuse a peerId other than the one bound to this URL, unless its key is explicitly listed
   * (static entry or signed registry), which rebinds the URL. Returns null when nothing is refused.
   */
  checkUrlBinding(url: string, peerId: string, publicKeyPem: string): TrustDecision | null {
    if (this.mode !== "tofu") return null;
    const bound = this.peerForUrl(url);
    if (bound === undefined || bound === peerId) return null;
    const src = this.knownSource(peerId);
    if ((src === "static" || src === "registry") && this.wouldTrust(peerId, publicKeyPem)) return null;
    return { trusted: false, reason: "url_peer_mismatch", mode: this.mode, peerId, fingerprint: fingerprint(publicKeyPem), boundPeerId: bound };
  }

  /** Record a trusted peer at a URL (first binding wins until rebound by a listed key) and, if proven, the proof. */
  recordTrusted(url: string, peerId: string, proven: boolean): void {
    const key = canonicalCoordinatorUrl(url);
    let changed = false;
    if (key && this.urlPeers.get(key) !== peerId) {
      this.urlPeers.set(key, peerId);
      changed = true;
    }
    if (proven && !this.provenPeers.has(peerId)) {
      this.provenPeers.add(peerId);
      changed = true;
    }
    if (changed) this.persistBindings();
  }

  private persistBindings(): void {
    if (!this.bindingFile) return;
    try {
      mkdirSync(dirname(this.bindingFile), { recursive: true });
      const tmp = `${this.bindingFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ urls: Object.fromEntries(this.urlPeers), proven: [...this.provenPeers] }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.bindingFile);
    } catch {
      // In-memory bindings still apply for this process.
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
  /** The verified key (set when trusted): responses are checked against it (response-signing.ts). */
  publicKeyPem?: string;
  /** The coordinator advertises signed responses (`responseSigning` >= 1). */
  responseSigning?: boolean;
}

export interface TrustCheckOptions {
  store?: PinnedKeyStore;
  fetch?: IdentityFetch;
  timeoutMs?: number;
  /** Default: required in strict mode, optional otherwise. */
  challenge?: ChallengePolicy;
  /** Key fingerprint the coordinator must present (e.g. a DNS seed's fp=); anything else is refused. */
  expectedFingerprint?: string;
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

function advertisesResponseSigning(body: unknown): boolean {
  const v = (body as { responseSigning?: unknown } | null)?.responseSigning;
  return typeof v === "number" && v >= 1;
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
      if (opts.expectedFingerprint && !fingerprintMatches(opts.expectedFingerprint, answer.publicKeyPem)) {
        return { trusted: false, coordinatorUrl, peerId: answer.peerId, error: "fingerprint_mismatch" };
      }
      const urlRefusal = store.checkUrlBinding(base, answer.peerId, answer.publicKeyPem);
      if (urlRefusal) return { trusted: false, coordinatorUrl, peerId: answer.peerId, decision: urlRefusal, proof: "challenge" };
      // Refusals (mismatch, unlisted) need no proof and must not pin.
      if (!store.wouldTrust(answer.peerId, answer.publicKeyPem)) {
        const decision = store.isTrusted(answer.peerId, answer.publicKeyPem);
        return { trusted: decision.trusted, coordinatorUrl, peerId: answer.peerId, decision, proof: "challenge" };
      }
      const verified = verifyIdentityChallenge(answer, sent, answer);
      if (!verified.ok) return { trusted: false, coordinatorUrl, peerId: answer.peerId, error: verified.error };
      const decision = store.isTrusted(answer.peerId, answer.publicKeyPem);
      if (decision.trusted) store.recordTrusted(base, answer.peerId, true);
      return {
        trusted: decision.trusted,
        coordinatorUrl,
        peerId: answer.peerId,
        decision,
        proof: "challenge",
        publicKeyPem: answer.publicKeyPem,
        responseSigning: advertisesResponseSigning(answer)
      };
    }
    if (!CHALLENGE_UNSUPPORTED_STATUS.has(res.status)) return { trusted: false, coordinatorUrl, error: `identity_challenge_http_${res.status}` };
    if (policy === "required") return { trusted: false, coordinatorUrl, error: "identity_challenge_unsupported" };

    const idRes = await doFetch(`${base}/identity`, { headers: { accept: "application/json" }, signal: controller?.signal });
    if (!idRes.ok) return { trusted: false, coordinatorUrl, error: `identity_http_${idRes.status}` };
    const body = (await idRes.json()) as { peerId?: unknown; publicKeyPem?: unknown };
    if (!validIdentity(body)) return { trusted: false, coordinatorUrl, error: "identity_malformed" };
    if (opts.expectedFingerprint && !fingerprintMatches(opts.expectedFingerprint, body.publicKeyPem)) {
      return { trusted: false, coordinatorUrl, peerId: body.peerId, error: "fingerprint_mismatch" };
    }
    const urlRefusal = store.checkUrlBinding(base, body.peerId, body.publicKeyPem);
    if (urlRefusal) return { trusted: false, coordinatorUrl, peerId: body.peerId, decision: urlRefusal, proof: "identity_only" };
    // A coordinator that has answered the challenge before does not lose it: refuse the downgrade
    // (an impostor replaying the public /identity of a known coordinator).
    const boundPeer = store.peerForUrl(base);
    if (store.hasProvenKey(body.peerId) || (boundPeer !== undefined && store.hasProvenKey(boundPeer))) {
      return { trusted: false, coordinatorUrl, peerId: body.peerId, error: "identity_challenge_downgrade" };
    }
    const decision = store.isTrusted(body.peerId, body.publicKeyPem);
    if (decision.trusted) store.recordTrusted(base, body.peerId, false);
    return {
      trusted: decision.trusted,
      coordinatorUrl,
      peerId: body.peerId,
      decision,
      proof: "identity_only",
      publicKeyPem: body.publicKeyPem,
      responseSigning: advertisesResponseSigning(body),
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
  private readonly verified = new Map<string, { at: number; result: CoordinatorTrustCheck }>();
  private readonly reverifyMs: number;
  private readonly now: () => number;
  constructor(private readonly opts: TrustCheckOptions & { reverifyMs?: number; now?: () => number } = {}) {
    this.reverifyMs = Math.max(1_000, opts.reverifyMs ?? DEFAULT_TRUST_REVERIFY_MS);
    this.now = opts.now ?? Date.now;
  }

  /** `expectedFingerprint`: the key this URL was discovered with (DNS fp=); a different key is refused. */
  async check(coordinatorUrl: string, expect: { expectedFingerprint?: string } = {}): Promise<CoordinatorTrustCheck> {
    const key = normalizeChallengeUrl(coordinatorUrl);
    const hit = this.verified.get(key);
    const hitMatches =
      !expect.expectedFingerprint || (hit?.result.publicKeyPem !== undefined && fingerprintMatches(expect.expectedFingerprint, hit.result.publicKeyPem));
    if (hit !== undefined && hitMatches && this.now() - hit.at < this.reverifyMs) {
      const { warning: _warned, ...cached } = hit.result;
      return { ...cached, coordinatorUrl: key };
    }
    this.verified.delete(key);
    const result = await checkCoordinatorTrust(key, { ...this.opts, ...(expect.expectedFingerprint ? { expectedFingerprint: expect.expectedFingerprint } : {}) });
    if (result.trusted) this.verified.set(key, { at: this.now(), result });
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
  if (check.error === "fingerprint_mismatch") return "coordinator key does not match the fingerprint it was discovered with (fp=): possible impersonation";
  if (check.error === "identity_challenge_downgrade") {
    return "coordinator answered the identity challenge before but now offers only the public /identity: possible impersonation";
  }
  if (check.error?.startsWith("challenge_")) return `coordinator failed the identity challenge (${check.error}): possible impersonation`;
  if (check.error) return `could not verify coordinator identity (${check.error})`;
  const d = check.decision;
  if (!d) return "untrusted";
  switch (d.reason) {
    case "pinned_mismatch":
      return `key mismatch for ${d.peerId}: pinned ${d.pinnedFingerprint}, presented ${d.fingerprint} (mode=${d.mode})`;
    case "url_peer_mismatch":
      return `coordinator URL is bound to ${d.boundPeerId} but presented ${d.peerId} (${d.fingerprint}); list the new key in TRUSTED_COORDINATOR_KEYS if this is intended (mode=${d.mode})`;
    case "strict_unlisted":
      return `coordinator ${d.peerId} (${d.fingerprint}) is not in TRUSTED_COORDINATOR_KEYS (mode=strict)`;
    default:
      return `${d.reason} (mode=${d.mode})`;
  }
}

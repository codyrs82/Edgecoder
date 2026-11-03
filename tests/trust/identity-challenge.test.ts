import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { PinnedKeyStore, checkCoordinatorTrust, challengePolicyFromEnv, describeTrustFailure, fingerprint } from "../../src/trust/pinned-keys.js";
import { answerIdentityChallenge, newChallengeNonce, verifyIdentityChallenge } from "../../src/trust/identity-challenge.js";
import { coordinatorFetch } from "./coordinator-fetch.js";

const seed = createPeerKeys("coord-seed");
const attacker = createPeerKeys("coord-attacker");
const entry = `${seed.peerId}:${fingerprint(seed.publicKeyPem)}`;
const self = { peerId: seed.peerId, publicKeyPem: seed.publicKeyPem, privateKeyPem: seed.privateKeyPem, publicUrl: "https://seed.example/" };

describe("identity challenge (coordinator proof of key possession)", () => {
  it("a signed answer verifies against the pinned key", () => {
    const sent = { nonce: newChallengeNonce(), url: "https://seed.example" };
    const answer = answerIdentityChallenge(sent, self)!;
    expect(answer.coordinatorUrl).toBe("https://seed.example");
    expect(verifyIdentityChallenge(answer, sent, seed)).toEqual({ ok: true });
  });

  it("rejects a replayed answer (old nonce), a different URL and a signature by another key", () => {
    const old = answerIdentityChallenge({ nonce: newChallengeNonce(), url: "https://seed.example" }, self)!;
    const sent = { nonce: newChallengeNonce(), url: "https://seed.example" };
    expect(verifyIdentityChallenge(old, sent, seed)).toEqual({ ok: false, error: "challenge_nonce_mismatch" });
    const otherUrl = answerIdentityChallenge({ ...sent, url: "https://elsewhere.example" }, self)!;
    expect(verifyIdentityChallenge(otherUrl, sent, seed)).toEqual({ ok: false, error: "challenge_url_mismatch" });
    // Claims the seed's identity, but only the attacker's private key is available to sign.
    const forged = answerIdentityChallenge(sent, { ...self, privateKeyPem: attacker.privateKeyPem })!;
    expect(verifyIdentityChallenge(forged, sent, seed)).toEqual({ ok: false, error: "challenge_bad_signature" });
    // A tampered nonce in an otherwise valid answer.
    const good = answerIdentityChallenge(sent, self)!;
    expect(verifyIdentityChallenge({ ...good, issuedAtMs: good.issuedAtMs + 1 }, sent, seed)).toEqual({ ok: false, error: "challenge_bad_signature" });
  });

  it("the coordinator refuses malformed challenges", () => {
    expect(answerIdentityChallenge({ nonce: "short", url: "https://x" }, self)).toBeNull();
    expect(answerIdentityChallenge({ nonce: newChallengeNonce() }, self)).toBeNull();
    expect(answerIdentityChallenge(null, self)).toBeNull();
  });
});

describe("agent trust check with the challenge", () => {
  it("strict: a coordinator that proves the listed key is trusted", async () => {
    const store = new PinnedKeyStore({ mode: "strict", entries: entry, pinFile: null });
    const res = await checkCoordinatorTrust("https://seed.example", { store, fetch: coordinatorFetch(seed) });
    expect(res).toMatchObject({ trusted: true, proof: "challenge", decision: { reason: "pinned_match" } });
  });

  it("a replayed /identity (public key without the private key) is refused", async () => {
    const store = new PinnedKeyStore({ mode: "strict", entries: entry, pinFile: null });
    // The impostor knows the seed's public identity and an old signed answer, not its private key.
    const recorded = answerIdentityChallenge({ nonce: newChallengeNonce(), url: "https://seed.example" }, self);
    const replay = await checkCoordinatorTrust("https://seed.example", { store, fetch: coordinatorFetch(seed, { challengeBody: recorded }) });
    expect(replay).toMatchObject({ trusted: false, error: "challenge_nonce_mismatch" });
    expect(describeTrustFailure(replay)).toMatch(/impersonation/);
    // Unsigned: the public /identity body served as the answer.
    const unsigned = await checkCoordinatorTrust("https://seed.example", { store, fetch: coordinatorFetch(seed, { challengeBody: { peerId: seed.peerId, publicKeyPem: seed.publicKeyPem } }) });
    expect(unsigned).toMatchObject({ trusted: false, error: "challenge_malformed" });
  });

  it("a signature by the wrong key is refused, and tofu pins nothing for it", async () => {
    const pinFile = join(mkdtempSync(join(tmpdir(), "ec-challenge-")), "trusted-coordinators");
    const store = new PinnedKeyStore({ mode: "tofu", pinFile });
    const res = await checkCoordinatorTrust("https://seed.example", { store, fetch: coordinatorFetch(seed, { signWith: attacker }) });
    expect(res).toMatchObject({ trusted: false, error: "challenge_bad_signature" });
    expect(store.knownFingerprint(seed.peerId)).toBeUndefined();
    expect(existsSync(pinFile)).toBe(false);
  });

  it("a coordinator without the challenge: refused when required (strict), warned in tofu", async () => {
    const strict = new PinnedKeyStore({ mode: "strict", entries: entry, pinFile: null });
    const refused = await checkCoordinatorTrust("https://seed.example", { store: strict, fetch: coordinatorFetch(seed, { challenge: false }) });
    expect(refused).toMatchObject({ trusted: false, error: "identity_challenge_unsupported" });
    expect(describeTrustFailure(refused)).toMatch(/does not prove possession/);

    const tofu = new PinnedKeyStore({ mode: "tofu", pinFile: null });
    const fetch = coordinatorFetch(seed, { challenge: false });
    const warned = await checkCoordinatorTrust("https://seed.example", { store: tofu, fetch });
    expect(warned).toMatchObject({ trusted: true, proof: "identity_only" });
    expect(warned.warning).toMatch(/not proven/);
    expect(fetch.calls).toEqual(["POST https://seed.example/identity/challenge", "GET https://seed.example/identity"]);

    // Strict with the explicit rollout override falls back too.
    const optional = await checkCoordinatorTrust("https://seed.example", { store: strict, fetch: coordinatorFetch(seed, { challenge: false }), challenge: "optional" });
    expect(optional).toMatchObject({ trusted: true, proof: "identity_only" });
  });

  it("challenge policy from the environment", () => {
    expect(challengePolicyFromEnv({}, "strict")).toBe("required");
    expect(challengePolicyFromEnv({}, "tofu")).toBe("optional");
    expect(challengePolicyFromEnv({ EDGECODER_IDENTITY_CHALLENGE: "required" }, "tofu")).toBe("required");
    expect(() => challengePolicyFromEnv({ EDGECODER_IDENTITY_CHALLENGE: "maybe" }, "tofu")).toThrow(/EDGECODER_IDENTITY_CHALLENGE/);
  });
});

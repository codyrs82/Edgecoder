import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSixDigitCode, secureCompare, sha256Hex } from "../../src/portal/portal-utils.js";
import { registerWalletRoutes } from "../../src/portal/routes/wallet.js";

/*
 * #17: wallet send MFA, against the real route module and the real WebAuthn verifier.
 *
 * A send needs two fresh factors bound to one single-use challenge: the six-digit code emailed
 * for that challenge, and a passkey assertion (user verification required) over the WebAuthn
 * challenge issued with it. tests/portal/wallet.test.ts covers a copy of these routes that skips
 * the passkey step; this file drives src/portal/routes/wallet.ts itself. The passkey is a
 * software authenticator (a P-256 key signing real assertions), so a forged, replayed or
 * mis-scoped assertion is rejected by @simplewebauthn/server, not by a stub.
 */

const RP_ID = "portal.example.test";
const ORIGIN = `https://${RP_ID}`;
const TTL_MS = 10 * 60 * 1000;
const DESTINATION = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

type AssertOptions = { challenge: string; origin?: string; rpId?: string; userVerified?: boolean; type?: string; key?: KeyObject; counter?: number };

/** A software passkey: an ES256 key pair that signs WebAuthn assertions the way an authenticator does. */
function makeAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  // COSE_Key: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y!, "base64url")
  ]);
  const credentialId = b64u(randomBytes(16));
  let signCount = 0;
  return {
    credentialId,
    publicKeyB64Url: b64u(cose),
    privateKey,
    assert({ challenge, origin = ORIGIN, rpId = RP_ID, userVerified = true, type = "webauthn.get", key = privateKey, counter }: AssertOptions) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter ?? ++signCount);
      // rpIdHash | flags (user present 0x01, user verified 0x04) | signature counter
      const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([0x01 | (userVerified ? 0x04 : 0)]), count]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), key);
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: { authenticatorData: b64u(authenticatorData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) }
      };
    }
  };
}
type Authenticator = ReturnType<typeof makeAuthenticator>;

type Challenge = { challengeId: string; userId: string; accountId: string; destination: string; amountSats: number; note?: string; emailCodeHash: string; passkeyChallenge: string; expiresAtMs: number; consumedAtMs?: number };
type Passkey = { credentialId: string; userId: string; publicKeyB64Url: string; counter: number; transports: string[] };

/** In-memory store with the semantics of the SQL (the consume statement itself is pinned in route-auth-inventory.test.ts). */
function makeStore() {
  const challenges = new Map<string, Challenge>();
  const passkeys = new Map<string, Passkey>();
  const sendRequests: Array<Record<string, unknown>> = [];
  return {
    challenges,
    passkeys,
    sendRequests,
    listPasskeysByUserId: async (userId: string) => [...passkeys.values()].filter((passkey) => passkey.userId === userId),
    findPasskeyByCredentialId: async (credentialId: string) => passkeys.get(credentialId) ?? null,
    updatePasskeyCounter: async (credentialId: string, counter: number) => {
      passkeys.get(credentialId)!.counter = counter;
    },
    createWalletSendMfaChallenge: async (input: Challenge) => {
      challenges.set(input.challengeId, { ...input });
    },
    // UPDATE ... SET consumed_at_ms = now WHERE challenge_id = $1 AND consumed_at_ms IS NULL AND expires_at_ms > now RETURNING ...
    consumeWalletSendMfaChallenge: async (challengeId: string) => {
      const challenge = challenges.get(challengeId);
      const now = Date.now();
      if (!challenge || challenge.consumedAtMs !== undefined || !(challenge.expiresAtMs > now)) return null;
      challenge.consumedAtMs = now;
      return { ...challenge };
    },
    createWalletSendRequest: async (input: Record<string, unknown>) => {
      sendRequests.push(input);
    },
    listWalletSendRequestsByAccount: async () => sendRequests,
    getWalletOnboardingByUserId: async () => null,
    getPayoutDestination: async () => null
  };
}

const USERS: Record<string, { userId: string; email: string; emailVerified: boolean }> = {
  alice: { userId: "u-alice", email: "alice@example.com", emailVerified: true },
  bob: { userId: "u-bob", email: "bob@example.com", emailVerified: true },
  carol: { userId: "u-carol", email: "carol@example.com", emailVerified: true }
};

let app: FastifyInstance;
let store: ReturnType<typeof makeStore>;
let emails: Array<{ email: string; code: string; amountSats: number; destination: string }>;
let alice: Authenticator;
let bob: Authenticator;

async function build(overrides: { RESEND_API_KEY?: string; RESEND_FROM_EMAIL?: string } = {}) {
  const instance = Fastify();
  registerWalletRoutes(instance, {
    PASSKEY_ALLOWED_ORIGINS: [ORIGIN],
    PASSKEY_RP_ID: RP_ID,
    RESEND_API_KEY: "re_test_key",
    RESEND_FROM_EMAIL: "wallet@example.com",
    WALLET_DEFAULT_NETWORK: "signet",
    WALLET_SEND_MFA_TTL_MS: TTL_MS,
    generateAuthenticationOptions,
    generateSixDigitCode,
    // The session lookup itself is covered by route-auth-inventory.test.ts against the real server.
    getCurrentUser: async (req: { headers: Record<string, unknown> }) => USERS[String(req.headers["x-test-user"] ?? "")] ?? null,
    secureCompare,
    sendWalletSendMfaCodeEmail: async (input: { email: string; code: string; amountSats: number; destination: string }) => {
      emails.push(input);
    },
    sha256Hex,
    store,
    uint8ArrayFromBase64Url: (value: string) => new Uint8Array(Buffer.from(value, "base64url")),
    verifyAuthenticationResponse,
    ...overrides
  } as never);
  await instance.ready();
  return instance;
}

const as = (user: string) => ({ "x-test-user": user });

/** Starts a send as `user` and returns what the user would hold: the challenge id, the emailed code and the WebAuthn challenge. */
async function start(user = "alice", body: Record<string, unknown> = { destination: DESTINATION, amountSats: 25_000, note: "rent" }) {
  const res = await app.inject({ method: "POST", url: "/wallet/send/mfa/start", headers: as(user), payload: body });
  expect(res.statusCode).toBe(200);
  const json = res.json() as { challengeId: string; expiresAtMs: number; passkeyOptions: { challenge: string; userVerification: string; allowCredentials: Array<{ id: string }> } };
  return { ...json, code: emails.at(-1)!.code, passkeyChallenge: json.passkeyOptions.challenge, raw: res.body };
}

function confirm(user: string | null, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/wallet/send/mfa/confirm", headers: user ? as(user) : {}, payload: body });
}

beforeEach(async () => {
  store = makeStore();
  emails = [];
  alice = makeAuthenticator();
  bob = makeAuthenticator();
  store.passkeys.set(alice.credentialId, { credentialId: alice.credentialId, userId: "u-alice", publicKeyB64Url: alice.publicKeyB64Url, counter: 0, transports: ["internal"] });
  store.passkeys.set(bob.credentialId, { credentialId: bob.credentialId, userId: "u-bob", publicKeyB64Url: bob.publicKeyB64Url, counter: 0, transports: ["internal"] });
  app = await build();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe("POST /wallet/send/mfa/start", () => {
  it("refuses without a session and creates nothing", async () => {
    const res = await app.inject({ method: "POST", url: "/wallet/send/mfa/start", payload: { destination: DESTINATION, amountSats: 25_000 } });
    expect(res.statusCode).toBe(401);
    expect(store.challenges.size).toBe(0);
    expect(emails).toEqual([]);
  });

  it("refuses an account with no passkey: there is no second factor to ask for", async () => {
    const res = await app.inject({ method: "POST", url: "/wallet/send/mfa/start", headers: as("carol"), payload: { destination: DESTINATION, amountSats: 25_000 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "passkey_required_for_wallet_send" });
    expect(store.challenges.size).toBe(0);
    expect(emails).toEqual([]);
  });

  it("refuses when the email factor cannot be delivered, instead of falling back to the passkey alone", async () => {
    for (const overrides of [{ RESEND_API_KEY: "" }, { RESEND_FROM_EMAIL: "" }]) {
      const instance = await build(overrides);
      const res = await instance.inject({ method: "POST", url: "/wallet/send/mfa/start", headers: as("alice"), payload: { destination: DESTINATION, amountSats: 25_000 } });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "email_mfa_not_configured" });
      await instance.close();
    }
    expect(store.challenges.size).toBe(0);
    expect(emails).toEqual([]);
  });

  it("issues one challenge holding both factors: the code only as a hash, the passkey scoped to the caller with user verification", async () => {
    const before = Date.now();
    const started = await start("alice");
    const stored = store.challenges.get(started.challengeId)!;

    expect(emails).toEqual([{ email: "alice@example.com", code: started.code, amountSats: 25_000, destination: DESTINATION }]);
    expect(started.code).toMatch(/^\d{6}$/);
    // The code goes to the mailbox only: not in the response, and stored hashed and bound to this challenge.
    expect(started.raw).not.toContain(started.code);
    expect(JSON.stringify(stored)).not.toContain(started.code);
    expect(stored.emailCodeHash).toBe(sha256Hex(`${started.challengeId}:${started.code}`));

    expect(stored).toMatchObject({ userId: "u-alice", accountId: "acct-u-alice", destination: DESTINATION, amountSats: 25_000, note: "rent", passkeyChallenge: started.passkeyChallenge });
    expect(stored.expiresAtMs).toBeGreaterThanOrEqual(before + TTL_MS);
    expect(stored.expiresAtMs).toBeLessThanOrEqual(Date.now() + TTL_MS);
    expect(started.passkeyOptions.userVerification).toBe("required");
    expect(started.passkeyOptions.allowCredentials.map((credential) => credential.id)).toEqual([alice.credentialId]);
  });

  it("gives every start its own code hash and WebAuthn challenge", async () => {
    const first = await start("alice");
    const second = await start("alice");
    expect(second.challengeId).not.toBe(first.challengeId);
    expect(second.passkeyChallenge).not.toBe(first.passkeyChallenge);
    expect(store.challenges.get(second.challengeId)!.emailCodeHash).not.toBe(store.challenges.get(first.challengeId)!.emailCodeHash);
  });
});

describe("POST /wallet/send/mfa/confirm", () => {
  const goodBody = (started: { challengeId: string; code: string; passkeyChallenge: string }, authenticator = alice) => ({
    challengeId: started.challengeId,
    emailCode: started.code,
    credentialId: authenticator.credentialId,
    response: authenticator.assert({ challenge: started.passkeyChallenge })
  });

  it("with both factors, records a send for manual review with the amount and destination fixed at start", async () => {
    const started = await start("alice");
    // Extra fields in the confirm body cannot change what was approved by the two factors.
    const res = await confirm("alice", { ...goodBody(started), destination: "bc1qattackerattackerattackerattackerattacker", amountSats: 99_000_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().request).toMatchObject({ accountId: "acct-u-alice", destination: DESTINATION, amountSats: 25_000, note: "rent", status: "pending_manual_review" });
    expect(store.sendRequests).toEqual([
      expect.objectContaining({ userId: "u-alice", accountId: "acct-u-alice", destination: DESTINATION, amountSats: 25_000, status: "pending_manual_review", mfaChallengeId: started.challengeId })
    ]);
    expect(store.passkeys.get(alice.credentialId)!.counter).toBe(1);
  });

  it("refuses without a session, and does not spend the challenge", async () => {
    const started = await start("alice");
    const body = goodBody(started);
    const res = await confirm(null, body);
    expect(res.statusCode).toBe(401);
    expect(store.sendRequests).toEqual([]);
    expect(store.challenges.get(started.challengeId)!.consumedAtMs).toBeUndefined();
    expect((await confirm("alice", body)).statusCode).toBe(200);
  });

  it("refuses when a factor is left out of the request", async () => {
    for (const omit of ["emailCode", "credentialId", "response"] as const) {
      const started = await start("alice");
      const body: Record<string, unknown> = goodBody(started);
      delete body[omit];
      const res = await confirm("alice", body);
      expect(res.statusCode, omit).toBeGreaterThanOrEqual(400);
    }
    expect(store.sendRequests).toEqual([]);
  });

  it("a wrong email code fails and burns the challenge, so the six digits cannot be guessed one by one", async () => {
    const started = await start("alice");
    const wrong = started.code === "000000" ? "000001" : "000000";
    const res = await confirm("alice", { ...goodBody(started), emailCode: wrong });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "wallet_send_email_code_invalid" });

    // The right code and a valid passkey assertion no longer work for this challenge.
    const retry = await confirm("alice", goodBody(started));
    expect(retry.statusCode).toBe(400);
    expect(retry.json()).toEqual({ error: "wallet_send_mfa_challenge_invalid" });
    expect(store.sendRequests).toEqual([]);
  });

  it("the email code of another challenge does not work", async () => {
    const first = await start("alice");
    const second = await start("alice");
    const res = await confirm("alice", { ...goodBody(second), emailCode: first.code === second.code ? "x".repeat(6) : first.code });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "wallet_send_email_code_invalid" });
    expect(store.sendRequests).toEqual([]);
  });

  it("a confirmed challenge cannot be replayed", async () => {
    const started = await start("alice");
    const body = goodBody(started);
    expect((await confirm("alice", body)).statusCode).toBe(200);

    const replay = await confirm("alice", body);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: "wallet_send_mfa_challenge_invalid" });
    // Nor with a fresh assertion over the same WebAuthn challenge.
    expect((await confirm("alice", goodBody(started))).statusCode).toBe(400);
    expect(store.sendRequests).toHaveLength(1);
  });

  it("an expired challenge fails; one confirmed just inside the window succeeds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const late = await start("alice");
    const inTime = await start("alice");

    vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + TTL_MS - 1));
    expect((await confirm("alice", goodBody(inTime))).statusCode).toBe(200);

    vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + TTL_MS));
    const res = await confirm("alice", goodBody(late));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "wallet_send_mfa_challenge_invalid" });
    expect(store.sendRequests).toHaveLength(1);
  });

  it("an unknown challenge id fails", async () => {
    const started = await start("alice");
    const res = await confirm("alice", { ...goodBody(started), challengeId: "00000000-0000-4000-8000-000000000000" });
    expect(res.statusCode).toBe(400);
    expect(store.sendRequests).toEqual([]);
  });

  it("another user's challenge fails, even with that user's code and the caller's own valid passkey", async () => {
    const started = await start("alice");
    const res = await confirm("bob", goodBody(started, bob));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "wallet_send_mfa_challenge_invalid" });
    expect(store.sendRequests).toEqual([]);
  });

  it("another user's passkey, or an unknown one, cannot stand in for the caller's", async () => {
    const withBobs = await start("alice");
    const res = await confirm("alice", goodBody(withBobs, bob));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "passkey_credential_not_found" });

    const unknown = await start("alice");
    const stranger = makeAuthenticator();
    expect((await confirm("alice", goodBody(unknown, stranger))).statusCode).toBe(404);
    expect(store.sendRequests).toEqual([]);
    expect(store.passkeys.get(bob.credentialId)!.counter).toBe(0);
  });

  const forged: Array<[string, (started: { passkeyChallenge: string }) => unknown]> = [
    ["signed over a different WebAuthn challenge", () => alice.assert({ challenge: b64u(randomBytes(32)) })],
    ["made for another origin (phishing page)", (s) => alice.assert({ challenge: s.passkeyChallenge, origin: "https://portal.example.test.evil.example" })],
    ["made for another relying party", (s) => alice.assert({ challenge: s.passkeyChallenge, rpId: "evil.example" })],
    ["without user verification (presence only)", (s) => alice.assert({ challenge: s.passkeyChallenge, userVerified: false })],
    ["a registration ceremony, not an assertion", (s) => alice.assert({ challenge: s.passkeyChallenge, type: "webauthn.create" })],
    ["signed by a different key", (s) => alice.assert({ challenge: s.passkeyChallenge, key: makeAuthenticator().privateKey })],
    ["with a tampered signature", (s) => {
      const assertion = alice.assert({ challenge: s.passkeyChallenge });
      const signature = Buffer.from(assertion.response.signature, "base64url");
      signature[signature.length - 1] ^= 0xff;
      return { ...assertion, response: { ...assertion.response, signature: b64u(signature) } };
    }],
    ["an empty object", () => ({})],
    ["a bare string", () => "approved"]
  ];
  it.each(forged)("a passkey assertion %s fails, with the correct email code", async (_label, makeResponse) => {
    const started = await start("alice");
    const res = await confirm("alice", { ...goodBody(started), response: makeResponse(started) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "wallet_send_passkey_verification_failed" });
    expect(store.sendRequests).toEqual([]);
    expect(store.passkeys.get(alice.credentialId)!.counter).toBe(0);
    // The failed attempt spent the challenge: the genuine assertion cannot be tried against it afterwards.
    expect((await confirm("alice", goodBody(started))).statusCode).toBe(400);
  });

  it("an assertion captured from an earlier send cannot approve a later one", async () => {
    const first = await start("alice");
    const captured = goodBody(first);
    expect((await confirm("alice", captured)).statusCode).toBe(200);

    const second = await start("alice", { destination: "bc1qattackerattackerattackerattackerattacker", amountSats: 90_000 });
    const res = await confirm("alice", { ...goodBody(second), response: captured.response });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "wallet_send_passkey_verification_failed" });
    expect(store.sendRequests).toHaveLength(1);
  });

  it("an assertion whose signature counter does not advance is refused (cloned authenticator)", async () => {
    store.passkeys.get(alice.credentialId)!.counter = 7;
    const started = await start("alice");
    const res = await confirm("alice", { ...goodBody(started), response: alice.assert({ challenge: started.passkeyChallenge, counter: 7 }) });
    expect(res.statusCode).toBe(401);
    expect(store.sendRequests).toEqual([]);
    expect(store.passkeys.get(alice.credentialId)!.counter).toBe(7);

    const again = await start("alice");
    const ok = await confirm("alice", { ...goodBody(again), response: alice.assert({ challenge: again.passkeyChallenge, counter: 8 }) });
    expect(ok.statusCode).toBe(200);
    expect(store.passkeys.get(alice.credentialId)!.counter).toBe(8);
  });
});

describe("GET /wallet/send/requests and /wallet/onboarding", () => {
  it("refuse without a session", async () => {
    for (const url of ["/wallet/send/requests", "/wallet/onboarding"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});

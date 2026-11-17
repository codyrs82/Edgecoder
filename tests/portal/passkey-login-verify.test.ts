import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPasskeyRoutes } from "../../src/portal/routes/passkey.js";
import { deriveCredentialIdFromVerifyBody, normalizePasskeyResponsePayload } from "../../src/portal/portal-utils.js";

const uint8ArrayFromBase64Url = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

// The iOS app (ios/EdgeCoderIOS/EdgeCoderIOS/Auth/PasskeyProtocol.swift) posts WebAuthn JSON with
// base64url fields; these pin how /auth/passkey/login/verify finds the credential and answers.
const STORED_ID = "-_-_AQIDBAUGBwg"; // base64url of fb ff bf 01..08, the form the store keys by

function setup(opts: { challengeUserId?: string; credentialUserId?: string; stored?: boolean } = {}) {
  const calls: { verify: any[]; lookups: string[]; sessions: string[] } = { verify: [], lookups: [], sessions: [] };
  const app = Fastify();
  registerPasskeyRoutes(app, {
    PASSKEY_ALLOWED_ORIGINS: ["https://edgecoder.io"],
    PASSKEY_CHALLENGE_TTL_MS: 60_000,
    PASSKEY_RP_ID: "edgecoder.io",
    deriveCredentialIdFromVerifyBody,
    normalizePasskeyResponsePayload,
    uint8ArrayFromBase64Url,
    verifyAuthenticationResponse: async (args: any) => {
      calls.verify.push(args);
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    },
    createSessionForUser: async (userId: string) => {
      calls.sessions.push(userId);
    },
    store: {
      consumePasskeyChallenge: async () => ({ challenge: "AAEC", flowType: "authentication", userId: opts.challengeUserId }),
      findPasskeyByCredentialId: async (id: string) => {
        calls.lookups.push(id);
        if (opts.stored === false || id !== STORED_ID) return null;
        return { credentialId: STORED_ID, userId: opts.credentialUserId ?? "u-cody", publicKeyB64Url: "AAEC", counter: 0, transports: ["internal"] };
      },
      updatePasskeyCounter: async () => undefined,
      getUserById: async (userId: string) => ({ userId, email: "cody@edgecoder.io", emailVerified: true }),
    },
  } as any);
  return { app, calls };
}

function body(id: string, extra: Record<string, unknown> = {}) {
  return {
    challengeId: "chal-1234567890",
    credentialId: id,
    response: {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: "e30", authenticatorData: "__79AA", signature: "MEX77w", userHandle: "Pj8" },
    },
    ...extra,
  };
}

describe("passkey login verify", () => {
  it("signs in with the iOS app's base64url body and checks the edgecoder.io origin and rpId", async () => {
    const { app, calls } = setup({ challengeUserId: "u-cody" });
    const res = await app.inject({ method: "POST", url: "/auth/passkey/login/verify", payload: body(STORED_ID) });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("cody@edgecoder.io");
    expect(calls.lookups).toEqual([STORED_ID]);
    expect(calls.sessions).toEqual(["u-cody"]);
    expect(calls.verify[0].expectedOrigin).toEqual(["https://edgecoder.io"]);
    expect(calls.verify[0].expectedRPID).toBe("edgecoder.io");
    expect(calls.verify[0].response.id).toBe(STORED_ID);
  });

  it("finds the credential when the id arrives in standard base64 with padding", async () => {
    const { app, calls } = setup();
    const res = await app.inject({ method: "POST", url: "/auth/passkey/login/verify", payload: body("+/+/AQIDBAUGBwg=") });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(calls.lookups).toEqual([STORED_ID]);
  });

  it("answers passkey_credential_not_found for a passkey the portal has no row for", async () => {
    const { app, calls } = setup({ stored: false });
    const res = await app.inject({ method: "POST", url: "/auth/passkey/login/verify", payload: body(STORED_ID) });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("passkey_credential_not_found");
    expect(calls.sessions).toEqual([]);
  });

  it("refuses a passkey of another account when the options were asked for by email", async () => {
    const { app, calls } = setup({ challengeUserId: "u-cody", credentialUserId: "u-other" });
    const res = await app.inject({ method: "POST", url: "/auth/passkey/login/verify", payload: body(STORED_ID) });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("passkey_account_mismatch");
    expect(calls.verify).toEqual([]);
    expect(calls.sessions).toEqual([]);
  });
});

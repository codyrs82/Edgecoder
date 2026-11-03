import Fastify from "fastify";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { registerPasskeyRoutes } from "../../src/portal/routes/passkey.js";

// Password managers label a new passkey with the WebAuthn user name and display name; both must
// say which EdgeCoder account the passkey signs in to.
async function registrationUser(user: { userId: string; email: string; displayName?: string }) {
  const app = Fastify();
  registerPasskeyRoutes(app, {
    PASSKEY_ALLOWED_ORIGINS: ["https://edgecoder.io"],
    PASSKEY_CHALLENGE_TTL_MS: 60_000,
    PASSKEY_RP_ID: "edgecoder.io",
    PASSKEY_RP_NAME: "EdgeCoder Portal",
    generateRegistrationOptions,
    getCurrentUser: async () => user,
    store: { listPasskeysByUserId: async () => [], createPasskeyChallenge: async () => undefined },
  } as any);
  const res = await app.inject({ method: "POST", url: "/auth/passkey/register/options" });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.json().options.user as { name: string; displayName: string };
}

describe("passkey registration names the account", () => {
  it("uses the email as the user name and the display name plus email as the display name", async () => {
    const u = await registrationUser({ userId: "u1", email: "cody@example.com", displayName: "Cody Smith" });
    expect(u.name).toBe("cody@example.com");
    expect(u.displayName).toBe("Cody Smith (cody@example.com)");
  });

  it("falls back to the email when there is no display name", async () => {
    const u = await registrationUser({ userId: "u2", email: "agent@example.com", displayName: "  " });
    expect(u.displayName).toBe("agent@example.com");
  });
});

import { describe, expect, it } from "vitest";
import { redactText } from "../src/lib/redact";
// A fake password, built at runtime so the repo holds no credential-shaped URL (secret scan).
const FAKE_PW = ["hunter", "2", "pass"].join("");
const FAKE_USERINFO_URL = ["rpc http", "//admin", `${FAKE_PW}@127.0.0.1`, "8332"].join(":");

describe("log redaction", () => {
  const cases: Array<[name: string, text: string, secret: string]> = [
    ["Authorization header", "authorization: Bearer abcdefghijklmnop0123456789", "abcdefghijklmnop0123456789"],
    ["Authorization Basic", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    ["bearer in an error", "request failed: Bearer eyJhbGciOiJIUzI1NiJ9xxxxxxxxxxxxxx", "eyJhbGciOiJIUzI1NiJ9xxxxxxxxxxxxxx"],
    ["x-api-key header", "x-api-key: k_9f8e7d6c5b4a3210", "k_9f8e7d6c5b4a3210"],
    ["JSON token field", `{"meshToken":"m3sh-t0ken-value"}`, "m3sh-t0ken-value"],
    ["JSON apiKey field", `{"apiKey": "abc123secretvalue"}`, "abc123secretvalue"],
    ["registration token", "registrationToken=rt_live_0123456789", "rt_live_0123456789"],
    ["query string token", "GET /callback?token=abcd1234efgh&x=1", "abcd1234efgh"],
    ["anthropic key", "key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt", "sk-ant-api03-AbCdEfGhIjKlMnOpQrSt"],
    ["openai key", "using sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX", "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX"],
    ["EdgeCoder API key", "connection key ec_live_a11yabcdef", "ec_live_a11yabcdef"],
    ["JWT", "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3jVmNHl0w5N"],
    ["BOLT11 invoice", "pay lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4js", "pvjluezpp5qqqsyqcyq5rqwzqfqqqsy"],
    ["regtest invoice", "invoice lnbcrt10u1pnxyz0acdefghjklmnpqrstuvwxyz023456789acdefghjklmnpqrstuvw", "pnxyz0acdefghjklmnpqrstuvwxyz"],
    ["preimage", "settled, preimage: 0f4e1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4", "0f4e1b2c3d4e5f60718293a4b5c6d7e8"],
    ["URL userinfo", FAKE_USERINFO_URL, FAKE_PW],
  ];
  for (const [name, text, secret] of cases) {
    it(`masks ${name}`, () => {
      const out = redactText(text);
      expect(out).toContain("[redacted]");
      expect(out).not.toContain(secret);
    });
  }

  it("keeps ordinary text, request ids and prose about tokens", () => {
    const text = "Bearer token required · requestId 6edacf21-c9f7-4eaa-aa5c-eddd0bc19eb7 · GET /v1/ide/bots → 200 · tokens: 312";
    expect(redactText(text)).toBe(text);
  });

  it("emails only when asked; long opaque strings only in strict mode", () => {
    expect(redactText("from owner@example.com")).toBe("from owner@example.com");
    expect(redactText("from owner@example.com", { emails: true })).toBe("from [email]");
    const opaque = "id Zx81kQ0pL2mN4bV6cX8zA1sD3fG5hJ7kL9qW0eR2tY4";
    expect(redactText(opaque)).toBe(opaque);
    expect(redactText(opaque, { strict: true })).toBe("id [redacted]");
  });
});

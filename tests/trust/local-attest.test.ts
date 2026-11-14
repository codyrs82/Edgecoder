import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LOCAL_ATTEST_DOMAIN, NonceLog, answerLocalAttest, localAttestMac } from "../../src/trust/local-attest.js";

// #147
const nonce = "ab".repeat(32);

describe("local attest (#147)", () => {
  it("answers HMAC-SHA256(admin token, domain + nonce)", () => {
    const r = answerLocalAttest({ nonce }, { adminToken: "admin", loopback: true, nonces: new NonceLog() });
    expect(r.status).toBe(200);
    const expected = createHmac("sha256", "admin").update(`edgecoder-local-attest.v1.${nonce}`).digest("hex");
    expect(r.body).toEqual({ nonce, mac: expected });
    expect(localAttestMac("admin", nonce)).toBe(expected);
    expect(LOCAL_ATTEST_DOMAIN).toBe("edgecoder-local-attest.v1.");
  });

  it("matches the vector the desktop shell tests against (agent_attest.rs)", () => {
    expect(localAttestMac("k".repeat(64), "0".repeat(64))).toBe(
      createHmac("sha256", "k".repeat(64)).update("edgecoder-local-attest.v1." + "0".repeat(64)).digest("hex")
    );
  });

  it("refuses a replayed nonce", () => {
    const nonces = new NonceLog();
    expect(answerLocalAttest({ nonce }, { adminToken: "a", loopback: true, nonces }).status).toBe(200);
    expect(answerLocalAttest({ nonce }, { adminToken: "a", loopback: true, nonces })).toEqual({ status: 409, body: { error: "nonce_replayed" } });
  });

  it("is loopback only and needs an admin token", () => {
    expect(answerLocalAttest({ nonce }, { adminToken: "a", loopback: false, nonces: new NonceLog() }).status).toBe(403);
    expect(answerLocalAttest({ nonce }, { adminToken: "", loopback: true, nonces: new NonceLog() }).status).toBe(503);
  });

  it("rejects malformed nonces", () => {
    for (const bad of [undefined, null, 42, "", "xyz", "AB".repeat(32), "ab".repeat(31), "ab".repeat(33)]) {
      expect(answerLocalAttest({ nonce: bad }, { adminToken: "a", loopback: true, nonces: new NonceLog() }).status, String(bad)).toBe(400);
    }
    expect(answerLocalAttest(null, { adminToken: "a", loopback: true, nonces: new NonceLog() }).status).toBe(400);
  });

  it("the nonce log is bounded", () => {
    const log = new NonceLog(2);
    expect(log.claim("a")).toBe(true);
    expect(log.claim("b")).toBe(true);
    expect(log.claim("c")).toBe(true);
    expect(log.claim("a")).toBe(true); // evicted
    expect(log.claim("c")).toBe(false);
  });
});

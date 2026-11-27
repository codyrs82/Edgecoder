import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkPortalInboundToken,
  legacyPortalTokenAccepted,
  portalOutboundHeaders,
  portalOwnerKnown,
  portalRequestAudiences,
  portalSignatureAtGate,
  portalSignatureOutcome,
  verifyPortalInFull
} from "../../src/swarm/coordinator/portal-credentials.js";
import { signPortalRequest, verifyCoordinatorPortalSignature } from "../../src/security/service-request-signing.js";
import { tokenSet } from "../../src/common/token-rotation.js";
import { bootstrapRegisterLogLevel } from "../../src/mesh/peer-trust.js";

describe("coordinator inbound portal token", () => {
  const service = tokenSet("portal-service-token", undefined, undefined);

  it("accepts the portal's service token", () => {
    expect(checkPortalInboundToken(service, "shared-coordinator-token", "portal-service-token", true)).toBe("ok");
    expect(checkPortalInboundToken(service, "", "portal-service-token", true)).toBe("ok");
  });

  it("never accepts the outbound-only coordinator token as the portal", () => {
    expect(checkPortalInboundToken(service, "shared-coordinator-token", "shared-coordinator-token", true)).toBe("unauthorized");
    // Even when PORTAL_SERVICE_TOKEN was set to the same value.
    const same = tokenSet("shared-coordinator-token", undefined, undefined);
    expect(checkPortalInboundToken(same, "shared-coordinator-token", "shared-coordinator-token", true)).toBe("unauthorized");
    expect(checkPortalInboundToken(service, "shared-coordinator-token", "wrong", true)).toBe("unauthorized");
  });

  it("keeps the unset behaviour (closed in production)", () => {
    expect(checkPortalInboundToken(tokenSet("", undefined, undefined), "", "x", true)).toBe("not_configured");
  });
});

describe("coordinator outbound portal headers", () => {
  it("names the coordinator when it is enrolled", () => {
    expect(portalOutboundHeaders("coord-a", "coord-a-registration", "tok")).toEqual({
      "content-type": "application/json",
      "x-portal-service-token": "tok",
      "x-coordinator-node-id": "coord-a",
      "x-coordinator-registration-token": "coord-a-registration"
    });
    expect(portalOutboundHeaders("coord-a", "", "")).toEqual({ "content-type": "application/json" });
  });
});

describe("mesh_bootstrap_registered log level", () => {
  it("warns when the peer refused the registration", () => {
    expect(bootstrapRegisterLogLevel(200)).toBe("info");
    expect(bootstrapRegisterLogLevel(204)).toBe("info");
    expect(bootstrapRegisterLogLevel(401)).toBe("warn");
    expect(bootstrapRegisterLogLevel(403)).toBe("warn");
    expect(bootstrapRegisterLogLevel(500)).toBe("warn");
  });
});

describe("portal-validated owner", () => {
  it("counts the owner's user id when the portal withholds the email", () => {
    expect(portalOwnerKnown({ ownerEmail: "a@x.io" })).toBe(true);
    expect(portalOwnerKnown({ ownerUserId: "user-1" })).toBe(true);
    expect(portalOwnerKnown({})).toBe(false);
  });
});

describe("coordinator inbound: portal-signed requests and the migration flag", () => {
  const portal = generateKeyPairSync("ed25519");
  const seedCfg = { keys: [portal.publicKey], audiences: portalRequestAudiences("https://coordinator.edgecoder.io", "", true) };
  const outsideCfg = { keys: [portal.publicKey], audiences: portalRequestAudiences("https://coord.outside.example", undefined, true) };
  const body = JSON.stringify({ accountId: "acct-u1" });
  const signedFor = (base: string) => ({ ...signPortalRequest({ key: portal.privateKey, url: `${base}/account/summary`, method: "POST", body, account: "acct-u1" }), "x-edgecoder-account": "acct-u1" });
  const once = () => {
    const seen = new Set<string>();
    return (nonce: string) => (seen.has(nonce) ? false : (seen.add(nonce), true));
  };

  it("audiences come from COORDINATOR_PUBLIC_URL and PORTAL_REQUEST_AUDIENCES", () => {
    expect([...portalRequestAudiences("https://a.example/", "https://b.example:8443, junk", true)!]).toEqual(["https://a.example", "https://b.example:8443"]);
    expect(portalRequestAudiences(undefined, undefined, false)).toBeNull();
    expect(portalRequestAudiences(undefined, undefined, true)!.size).toBe(0);
  });

  it("accepts the portal's signed call once, at the gate and in full", async () => {
    const headers = signedFor("https://coord.outside.example");
    expect(await portalSignatureAtGate(headers, "POST", "/account/summary", outsideCfg)).toBe(true);
    const replay = once();
    expect((await verifyPortalInFull(headers, "POST", "/account/summary", body, outsideCfg, replay)).ok).toBe(true);
    expect(await verifyPortalInFull(headers, "POST", "/account/summary", body, outsideCfg, replay)).toMatchObject({ ok: false, code: 409 });
  });

  it("a seed refuses what the portal sent an outside coordinator", async () => {
    const headers = signedFor("https://coord.outside.example");
    expect(await portalSignatureAtGate(headers, "POST", "/account/summary", seedCfg)).toBe(false);
    const decision = await verifyPortalInFull(headers, "POST", "/account/summary", body, seedCfg, once());
    expect(decision).toMatchObject({ ok: false, error: "portal_audience_mismatch" });
    // Without the seed's service token (the portal never sends it to outside hosts) it is refused.
    expect(portalSignatureOutcome(decision, false)).toBe("refuse");
  });

  it("PORTAL_SERVICE_TOKEN_INBOUND: on, the token still counts; off, only a signature does", () => {
    const service = tokenSet("portal-service-token", undefined, undefined);
    expect(legacyPortalTokenAccepted(service, "", "portal-service-token", true, true)).toBe(true);
    expect(legacyPortalTokenAccepted(service, "", "portal-service-token", true, false)).toBe(false);
    // The outbound-only coordinator token never counts, flag or not.
    expect(legacyPortalTokenAccepted(tokenSet("shared", undefined, undefined), "shared", "shared", true, true)).toBe(false);
    // A bad signature next to a token the flag still accepts: the token decides (logged).
    expect(portalSignatureOutcome({ ok: false, code: 401, error: "portal_signature_invalid" }, true)).toBe("token");
    expect(portalSignatureOutcome({ ok: true, audience: "a", nonce: "n", issuedAtMs: 1, account: "" }, false)).toBe("signed");
  });

  it("ignores signatures when no portal key is configured", async () => {
    expect(await portalSignatureAtGate(signedFor("https://coordinator.edgecoder.io"), "POST", "/account/summary", { keys: [], audiences: null })).toBe(false);
  });
});

describe("coordinator outbound: signed with its own key", () => {
  it("signs the call and sends no token when none is configured", () => {
    const k = generateKeyPairSync("ed25519");
    const priv = k.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = k.publicKey.export({ type: "spki", format: "pem" }).toString();
    const url = "https://edgecoder.io/internal/nodes/validate";
    const body = JSON.stringify({ nodeId: "agent-1" });
    const headers = portalOutboundHeaders("coord-a", "coord-a-registration", "", { privateKeyPem: priv, publicKeyPem: pub, method: "POST", url, body });
    expect(headers["x-portal-service-token"]).toBeUndefined();
    expect(headers["x-coordinator-node-id"]).toBe("coord-a");
    expect(verifyCoordinatorPortalSignature({ headers, method: "POST", path: "/internal/nodes/validate", rawBody: body })).toMatchObject({ ok: true, coordinatorId: "coord-a" });
  });
});

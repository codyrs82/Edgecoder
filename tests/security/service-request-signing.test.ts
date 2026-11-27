import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  audienceOf,
  hasPortalRequestSignature,
  PORTAL_REQUEST_HEADERS,
  signCoordinatorPortalRequest,
  signPortalRequest,
  verifyCoordinatorPortalSignature,
  verifyPortalRequest
} from "../../src/security/service-request-signing.js";
import { publicKeyFingerprint } from "../../src/security/key-fingerprint.js";

/*
 * Signed portal <-> coordinator calls (no shared secret):
 * - the portal signs for one coordinator's origin; another coordinator refuses the same request,
 * - method, path with query, body and the account header are covered,
 * - stale and replayed requests are refused,
 * - a coordinator's signature binds its id, key and request.
 */

const portal = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const SEED = "https://coordinator.edgecoder.io";
const OUTSIDE = "https://outside.example.org";
const seedAudiences = new Set([SEED]);

function portalCall(url: string, body = JSON.stringify({ accountId: "acct-u1" }), account = "acct-u1", nowMs?: number) {
  return { ...signPortalRequest({ key: portal.privateKey, url, method: "POST", body, account, nowMs }), "x-edgecoder-account": account };
}

describe("portal -> coordinator signatures", () => {
  it("verifies a request signed for this coordinator, then refuses the same nonce again", async () => {
    const headers = portalCall(`${SEED}/account/summary`);
    const seen = new Set<string>();
    const replay = (nonce: string) => (seen.has(nonce) ? false : (seen.add(nonce), true));
    const input = { headers, method: "POST", path: "/account/summary", rawBody: JSON.stringify({ accountId: "acct-u1" }), keys: [portal.publicKey], audiences: seedAudiences, replay };
    const first = await verifyPortalRequest(input);
    expect(first).toMatchObject({ ok: true, audience: SEED, account: "acct-u1" });
    expect(await verifyPortalRequest(input)).toEqual({ ok: false, code: 409, error: "portal_signature_replayed" });
  });

  it("an outside coordinator cannot replay what the portal sent it against a seed", async () => {
    // The portal called the outside coordinator; it forwards the exact request to the seed.
    const headers = portalCall(`${OUTSIDE}/account/summary`);
    const atSeed = await verifyPortalRequest({ headers, method: "POST", path: "/account/summary", rawBody: JSON.stringify({ accountId: "acct-u1" }), keys: [portal.publicKey], audiences: seedAudiences });
    expect(atSeed).toEqual({ ok: false, code: 401, error: "portal_audience_mismatch" });
    // Rewriting the audience header breaks the signature.
    const rewritten = { ...headers, [PORTAL_REQUEST_HEADERS.aud]: SEED };
    expect(await verifyPortalRequest({ headers: rewritten, method: "POST", path: "/account/summary", rawBody: JSON.stringify({ accountId: "acct-u1" }), keys: [portal.publicKey], audiences: seedAudiences })).toMatchObject({ ok: false, error: "portal_signature_invalid" });
  });

  it("covers the account, the body, the path with query and the method", async () => {
    const body = JSON.stringify({ accountId: "acct-u1" });
    const headers = portalCall(`${SEED}/network/world?accountId=acct-u1`, body);
    const base = { headers, method: "POST", path: "/network/world?accountId=acct-u1", rawBody: body, keys: [portal.publicKey], audiences: seedAudiences };
    expect((await verifyPortalRequest(base)).ok).toBe(true);
    expect(await verifyPortalRequest({ ...base, headers: { ...headers, "x-edgecoder-account": "acct-victim" } })).toMatchObject({ ok: false, error: "portal_signature_invalid" });
    expect(await verifyPortalRequest({ ...base, path: "/network/world?accountId=acct-victim" })).toMatchObject({ ok: false, error: "portal_signature_invalid" });
    expect(await verifyPortalRequest({ ...base, method: "GET" })).toMatchObject({ ok: false, error: "portal_signature_invalid" });
    expect(await verifyPortalRequest({ ...base, rawBody: JSON.stringify({ accountId: "acct-victim" }) })).toMatchObject({ ok: false, error: "portal_body_mismatch" });
  });

  it("refuses stale signatures, unknown keys and missing headers", async () => {
    const stale = portalCall(`${SEED}/account/summary`, "", "", Date.now() - 10 * 60_000);
    expect(await verifyPortalRequest({ headers: stale, method: "POST", path: "/account/summary", keys: [portal.publicKey], audiences: seedAudiences })).toMatchObject({ ok: false, error: "portal_signature_stale" });
    const fresh = portalCall(`${SEED}/account/summary`, "", "");
    expect(await verifyPortalRequest({ headers: fresh, method: "POST", path: "/account/summary", keys: [other.publicKey], audiences: seedAudiences })).toMatchObject({ ok: false, error: "portal_signature_invalid" });
    expect(await verifyPortalRequest({ headers: fresh, method: "POST", path: "/account/summary", keys: [], audiences: seedAudiences })).toMatchObject({ ok: false, error: "portal_keys_not_configured" });
    expect(await verifyPortalRequest({ headers: {}, method: "POST", path: "/x", keys: [portal.publicKey], audiences: null })).toMatchObject({ ok: false, error: "portal_signature_required" });
    expect(hasPortalRequestSignature(fresh)).toBe(true);
    expect(hasPortalRequestSignature({ "x-portal-service-token": "t" })).toBe(false);
  });

  it("accepts any audience only when the coordinator has none configured (development)", async () => {
    const headers = portalCall(`http://127.0.0.1:4301/account/summary`, "", "");
    expect((await verifyPortalRequest({ headers, method: "POST", path: "/account/summary", keys: [portal.publicKey], audiences: null })).ok).toBe(true);
    expect(audienceOf("https://Coordinator.EdgeCoder.io:443/x?y")).toBe(SEED);
    expect(audienceOf("ftp://x")).toBeNull();
  });
});

describe("coordinator -> portal signatures", () => {
  const coord = generateKeyPairSync("ed25519");
  const pub = coord.publicKey.export({ type: "spki", format: "pem" }).toString();
  const priv = coord.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("binds the coordinator id, its key and the request", () => {
    const body = JSON.stringify({ nodeIds: ["a"] });
    const headers = signCoordinatorPortalRequest({ coordinatorId: "coord-x", privateKeyPem: priv, publicKeyPem: pub, method: "POST", url: "https://edgecoder.io/internal/nodes/lookup", body });
    const ok = verifyCoordinatorPortalSignature({ headers, method: "POST", path: "/internal/nodes/lookup", rawBody: body });
    expect(ok).toMatchObject({ ok: true, coordinatorId: "coord-x", fingerprint: publicKeyFingerprint(pub) });
    expect(verifyCoordinatorPortalSignature({ headers: { ...headers, "x-coord-id": "coord-y" }, method: "POST", path: "/internal/nodes/lookup", rawBody: body })).toMatchObject({ ok: false, error: "coordinator_signature_invalid" });
    expect(verifyCoordinatorPortalSignature({ headers, method: "POST", path: "/internal/nodes/validate", rawBody: body })).toMatchObject({ ok: false, error: "coordinator_signature_invalid" });
    expect(verifyCoordinatorPortalSignature({ headers, method: "POST", path: "/internal/nodes/lookup", rawBody: "{}" })).toMatchObject({ ok: false, error: "coordinator_body_mismatch" });
    const stale = signCoordinatorPortalRequest({ coordinatorId: "coord-x", privateKeyPem: priv, publicKeyPem: pub, method: "GET", url: "https://edgecoder.io/internal/stats/counts", nowMs: Date.now() - 10 * 60_000 });
    expect(verifyCoordinatorPortalSignature({ headers: stale, method: "GET", path: "/internal/stats/counts", rawBody: "" })).toMatchObject({ ok: false, error: "coordinator_signature_stale" });
  });

  it("a coordinator signature is never a portal signature (and the reverse)", async () => {
    const headers = signCoordinatorPortalRequest({ coordinatorId: "coord-x", privateKeyPem: priv, publicKeyPem: pub, method: "GET", url: `${SEED}/account/summary` });
    expect(await verifyPortalRequest({ headers, method: "GET", path: "/account/summary", keys: [coord.publicKey], audiences: null })).toMatchObject({ ok: false, error: "portal_signature_required" });
  });
});

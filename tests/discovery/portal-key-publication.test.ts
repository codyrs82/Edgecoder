import { generateKeyPairSync } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { verifySignedRegistry } from "../../src/discovery/registry.js";
import { RegistryTrust } from "../../src/discovery/registry-trust.js";
import { portalActionKeysFromEnv, registryServiceFromEnv } from "../../src/portal/coordinator-registry.js";
import { registerRegistryRoutes } from "../../src/portal/coordinator-registry-routes.js";
import { parseSigningKey, parseVerifyKeys, publicKeyBase64, signPortalAction, verifyPortalAction } from "../../src/security/portal-action.js";
import { portalVerifyKeySource } from "../../src/swarm/coordinator/portal-credentials.js";
import { COORDINATOR_PORTAL_INBOUND_ENV, requireCoordinatorPortalInbound } from "../../src/common/env-guard.js";

/*
 * The portal's action-signing public key is published inside the signed coordinator registry, so a
 * coordinator without PORTAL_ACTION_VERIFY_KEYS verifies portal calls with the registry's keys.
 */

const pem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const registryKey = pem();
const registryPublic = registryServiceFromEnv({ REGISTRY_SIGNING_KEY_PEM: registryKey }).publicKey()!.publicKeyPem;

function service(env: Record<string, string>, now = () => 1_800_000_000_000) {
  return registryServiceFromEnv({ REGISTRY_SIGNING_KEY_PEM: registryKey, ...env }, { now });
}

const expected = { accountId: "acct-1", action: "payout.withdraw" as const, body: { bolt11: "lnbc1" } };
const nonceOnce = async () => true;
async function verifies(signing: string, keys: ReturnType<ReturnType<typeof portalVerifyKeySource>>): Promise<boolean> {
  const header = signPortalAction(parseSigningKey(signing), expected);
  return (await verifyPortalAction(header, expected, { keys, nonceOnce })).ok;
}

function trustFor(doc: () => unknown, now = () => 1_800_000_000_000) {
  return new RegistryTrust({ load: async () => doc(), publicKeys: [registryPublic], now });
}

describe("portal key in the signed registry", () => {
  it("carries the public key only, under a valid registry signature", async () => {
    const portal = pem();
    const s = service({ PORTAL_ACTION_SIGNING_KEY: portal });
    const doc = s.signed()!;
    const v = verifySignedRegistry(doc, { publicKeys: [registryPublic], now: () => 1_800_000_000_000 });
    expect(v.ok).toBe(true);
    const pub = publicKeyBase64(parseSigningKey(portal));
    expect(v.ok && v.registry.portalActionKeys).toEqual([pub]);
    expect(doc.payload).not.toContain("PRIVATE KEY");

    const f = Fastify();
    registerRegistryRoutes(f, { service: s, passkey: null, currentUser: async () => null, requireAdmin: async () => null });
    const res = await f.inject({ method: "GET", url: "/network/portal-keys" });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toEqual([pub]);
    await f.close();
  });

  it("omits the field when the portal has no signing key", () => {
    const v = verifySignedRegistry(service({}).signed(), { publicKeys: [registryPublic], now: () => 1_800_000_000_000 });
    expect(v.ok && v.registry.portalActionKeys).toBeUndefined();
  });

  it("a coordinator with only the registry verifies portal calls", async () => {
    const portal = pem();
    const s = service({ PORTAL_ACTION_SIGNING_KEY: portal });
    const trust = trustFor(() => s.signed());
    const keys = portalVerifyKeySource([], () => trust.portalActionKeys());
    expect(keys()).toHaveLength(0);
    expect(await trust.refresh()).toBe(true);
    expect(await verifies(portal, keys())).toBe(true);
    expect(await verifies(pem(), keys())).toBe(false);
  });

  it("ignores a registry signed by an unpinned key", async () => {
    const forged = registryServiceFromEnv({ REGISTRY_SIGNING_KEY_PEM: pem(), PORTAL_ACTION_SIGNING_KEY: pem() }, { now: () => 1_800_000_000_000 });
    const trust = trustFor(() => forged.signed());
    expect(await trust.refresh()).toBe(false);
    expect(trust.portalActionKeys()).toEqual([]);
  });

  it("PORTAL_ACTION_VERIFY_KEYS, when set, wins over the registry", async () => {
    const portal = pem();
    const other = pem();
    const trust = trustFor(() => service({ PORTAL_ACTION_SIGNING_KEY: other }).signed());
    await trust.refresh();
    const keys = portalVerifyKeySource(parseVerifyKeys(publicKeyBase64(parseSigningKey(portal))), () => trust.portalActionKeys());
    expect(await verifies(portal, keys())).toBe(true);
    expect(await verifies(other, keys())).toBe(false);
  });

  it("rotation: current and previous keys are both listed and both verify during overlap", async () => {
    const oldKey = pem();
    const newKey = pem();
    const oldPub = publicKeyBase64(parseSigningKey(oldKey));
    const newPub = publicKeyBase64(parseSigningKey(newKey));
    expect(portalActionKeysFromEnv({ PORTAL_ACTION_SIGNING_KEY: newKey, PORTAL_ACTION_PREVIOUS_VERIFY_KEYS: oldPub })).toEqual([newPub, oldPub]);

    let t = 1_800_000_000_000;
    const now = () => t;
    let current = service({ PORTAL_ACTION_SIGNING_KEY: newKey, PORTAL_ACTION_PREVIOUS_VERIFY_KEYS: oldPub }, now);
    const trust = trustFor(() => current.signed(), now);
    const keys = portalVerifyKeySource([], () => trust.portalActionKeys());
    await trust.refresh();
    expect(await verifies(oldKey, keys())).toBe(true);
    expect(await verifies(newKey, keys())).toBe(true);

    // Overlap ends: the portal drops the previous key and the next registry no longer lists it.
    t += 60 * 60_000;
    current = service({ PORTAL_ACTION_SIGNING_KEY: newKey }, now);
    await trust.refresh();
    expect(await verifies(newKey, keys())).toBe(true);
    expect(await verifies(oldKey, keys())).toBe(false);
  });
});

describe("production env check", () => {
  const prod = { NODE_ENV: "production" };
  it("passes without PORTAL_SERVICE_TOKEN or PORTAL_ACTION_VERIFY_KEYS when registry keys are pinned", () => {
    expect(() => requireCoordinatorPortalInbound(prod, true)).not.toThrow();
  });
  it("still needs one of them when no registry key is pinned", () => {
    expect(() => requireCoordinatorPortalInbound(prod, false)).toThrow(COORDINATOR_PORTAL_INBOUND_ENV.join(", "));
    expect(() => requireCoordinatorPortalInbound({ ...prod, PORTAL_ACTION_VERIFY_KEYS: "a2V5" }, false)).not.toThrow();
  });
});

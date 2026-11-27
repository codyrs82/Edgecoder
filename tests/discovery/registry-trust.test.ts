import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { loadRegistrySigningKey, signRegistry, type RegistryEntry, type RegistryMemberStatus, type SignedRegistry } from "../../src/discovery/registry.js";
import { RegistryTrust } from "../../src/discovery/registry-trust.js";
import { admitPeer, checkPeerRegistration, parsePeerAllowlist, peerKeyTrust, publicKeyFingerprint, signPeerRequest, signRegistration, verifyPeerRequest } from "../../src/mesh/peer-trust.js";

/*
 * Peer trust through the signed registry: a coordinator trusts registry members on probation or
 * active (never suspended) on top of its allowlist, refreshes on the signed TTL, and drops a
 * suspended member at the next refresh.
 */

const signing = loadRegistrySigningKey(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
const T0 = 1_800_000_000_000;
const TTL = 15 * 60_000;

const seed = createPeerKeys("coord-seed");
const probation = createPeerKeys("coord-community-p");
const active = createPeerKeys("coord-community-a");
const suspended = createPeerKeys("coord-community-s");

function entry(keys: PeerKeys, kind: "edgecoder" | "community", status: RegistryMemberStatus | undefined, url: string): RegistryEntry {
  return {
    peerId: keys.peerId,
    publicKeyFingerprint: publicKeyFingerprint(keys.publicKeyPem),
    urls: [url],
    region: "us",
    operator: { id: kind === "edgecoder" ? "edgecoder" : "op", name: "", kind },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: T0,
    health: { status: "healthy", checkedAtMs: T0, latencyMs: 10 },
    ...(status ? { status } : {})
  };
}

function doc(issuedAtMs: number, statuses: { p?: RegistryMemberStatus } = {}, key = signing): SignedRegistry {
  return signRegistry(
    {
      v: 1,
      network: "edgecoder",
      issuedAtMs,
      expiresAtMs: issuedAtMs + TTL,
      coordinators: [
        entry(seed, "edgecoder", undefined, "https://seed.example"),
        entry(probation, "community", statuses.p ?? "probation", "https://p.example/"),
        entry(active, "community", "active", "https://a.example"),
        entry(suspended, "community", "suspended", "https://s.example")
      ],
      fallbackUrls: []
    },
    key
  );
}

function setup(publicKeys = [signing.publicKeyPem]) {
  let t = T0;
  let served: SignedRegistry | null = doc(T0);
  let loads = 0;
  const revoked: string[][] = [];
  const trust = new RegistryTrust({
    load: async () => {
      loads++;
      return served;
    },
    publicKeys,
    now: () => t,
    onRevoked: (ids) => revoked.push(ids)
  });
  return { trust, revoked, loads: () => loads, serve: (d: SignedRegistry | null) => (served = d), advance: (ms: number) => (t += ms), now: () => t };
}

describe("RegistryTrust", () => {
  it("trusts members on probation or active with their key, never suspended, unknown or another key", async () => {
    const { trust } = setup();
    expect(await trust.refresh()).toBe(true);
    expect(trust.trusts(probation.peerId, probation.publicKeyPem)).toBe(true);
    expect(trust.trusts(active.peerId, active.publicKeyPem)).toBe(true);
    // a registry without statuses (older portal) lists active members
    expect(trust.trusts(seed.peerId, seed.publicKeyPem)).toBe(true);
    expect(trust.trusts(suspended.peerId, suspended.publicKeyPem)).toBe(false);
    expect(trust.trusts(probation.peerId, active.publicKeyPem)).toBe(false);
    expect(trust.trusts("coord-unknown", probation.publicKeyPem)).toBe(false);
    expect(trust.listing(seed.peerId)).toBe("platform");
    expect(trust.listing(probation.peerId)).toBe("probation");
    expect(trust.listing(suspended.peerId)).toBe("suspended");
    expect(trust.listing("coord-unknown")).toBeNull();
    expect(trust.urlPins().get(probation.peerId)).toBe("https://p.example");
    expect(trust.urlPins().has(suspended.peerId)).toBe(false);
  });

  it("adds nothing without a pinned key, and refuses a registry signed by another key", async () => {
    const off = setup([]);
    expect(off.trust.enabled).toBe(false);
    expect(await off.trust.refresh()).toBe(false);
    expect(off.loads()).toBe(0);
    expect(off.trust.trusts(probation.peerId, probation.publicKeyPem)).toBe(false);
    const other = loadRegistrySigningKey(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const forged = setup();
    forged.serve(doc(T0, {}, other));
    expect(await forged.trust.refresh()).toBe(false);
    expect(forged.trust.trusts(probation.peerId, probation.publicKeyPem)).toBe(false);
  });

  it("refreshes on the signed TTL: halfway through the lifetime, never past expiry", async () => {
    const { trust, loads, advance, serve } = setup();
    await trust.refresh();
    expect(loads()).toBe(1);
    advance(TTL / 2 - 1000);
    trust.maybeRefresh();
    expect(loads()).toBe(1);
    advance(1000);
    serve(null); // the portal is down
    trust.maybeRefresh();
    await Promise.resolve();
    expect(loads()).toBe(2);
    // still inside its lifetime: kept
    expect(trust.trusts(active.peerId, active.publicKeyPem)).toBe(true);
    advance(TTL);
    expect(trust.current()).toBeNull();
    expect(trust.trusts(active.peerId, active.publicKeyPem)).toBe(false);
  });

  it("suspension removes trust at the next refresh and names the peer; an older document is ignored", async () => {
    const { trust, revoked, serve, advance, now } = setup();
    await trust.refresh();
    expect(trust.trusts(probation.peerId, probation.publicKeyPem)).toBe(true);
    advance(60_000);
    serve(doc(now(), { p: "suspended" }));
    await trust.refresh();
    expect(trust.trusts(probation.peerId, probation.publicKeyPem)).toBe(false);
    expect(trust.listing(probation.peerId)).toBe("suspended");
    expect(revoked).toEqual([[probation.peerId]]);
    // a replay of the earlier document (probation) does not bring it back
    serve(doc(T0));
    await trust.refresh();
    expect(trust.trusts(probation.peerId, probation.publicKeyPem)).toBe(false);
  });
});

describe("peer trust = allowlist ∪ registry", () => {
  const allowed = createPeerKeys("coord-allowlisted");
  const allowlist = parsePeerAllowlist(`${allowed.peerId}:${publicKeyFingerprint(allowed.publicKeyPem)}@https://allowed.example`);

  function signedGet(keys: PeerKeys, nowMs: number) {
    return signPeerRequest({ peerId: keys.peerId, privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem, method: "GET", url: "/network/world/local", nowMs });
  }

  it("a probation member's signed request passes; after suspension it is refused", async () => {
    const { trust, serve, advance, now } = setup();
    await trust.refresh();
    const trusted = peerKeyTrust(allowlist, trust.trusts);
    const ok = await verifyPeerRequest({ headers: signedGet(probation, now()), method: "GET", path: "/network/world/local", trusted, nowMs: now() });
    expect(ok).toMatchObject({ ok: true, peerId: probation.peerId });
    expect(await verifyPeerRequest({ headers: signedGet(allowed, now()), method: "GET", path: "/network/world/local", trusted, nowMs: now() })).toMatchObject({ ok: true });
    expect(await verifyPeerRequest({ headers: signedGet(suspended, now()), method: "GET", path: "/network/world/local", trusted, nowMs: now() })).toMatchObject({ ok: false, code: 403 });
    advance(60_000);
    serve(doc(now(), { p: "suspended" }));
    await trust.refresh();
    expect(await verifyPeerRequest({ headers: signedGet(probation, now()), method: "GET", path: "/network/world/local", trusted, nowMs: now() })).toMatchObject({ ok: false, code: 403, error: "peer_not_allowlisted" });
    // the allowlist is unaffected
    expect(await verifyPeerRequest({ headers: signedGet(allowed, now()), method: "GET", path: "/network/world/local", trusted, nowMs: now() })).toMatchObject({ ok: true });
  });

  it("admits a registry member to the peer table at its verified URL, and registration works with no allowlist", async () => {
    const { trust } = setup();
    await trust.refresh();
    const trusted = peerKeyTrust(allowlist, trust.trusts);
    const pins = new Map([...trust.urlPins()]);
    const peer = { peerId: probation.peerId, publicKeyPem: probation.publicKeyPem, coordinatorUrl: "https://p.example" };
    expect(admitPeer({ allowlist, trusted, pins, production: true, peer, source: "register" })).toMatchObject({ coordinatorUrl: "https://p.example" });
    expect(admitPeer({ allowlist, trusted, pins, production: true, peer: { ...peer, coordinatorUrl: "https://elsewhere.example" }, source: "register" })).toBeNull();
    expect(admitPeer({ allowlist, pins, production: true, peer, source: "register" })).toBeNull(); // allowlist alone does not know it
    const sus = { peerId: suspended.peerId, publicKeyPem: suspended.publicKeyPem, coordinatorUrl: "https://s.example" };
    expect(admitPeer({ allowlist, trusted, pins, production: true, peer: sus, source: "bootstrap" })).toBeNull();

    const fields = { peerId: active.peerId, publicKeyPem: active.publicKeyPem, coordinatorUrl: "https://a.example", networkMode: "public_mesh" };
    const body = { ...fields, ...signRegistration(fields, active.privateKeyPem, T0) };
    const empty = parsePeerAllowlist(undefined);
    expect(checkPeerRegistration({ body, allowlist: empty, production: true, trusted: peerKeyTrust(empty, trust.trusts), nowMs: T0 })).toMatchObject({ ok: false, error: "peer_allowlist_required" });
    expect(checkPeerRegistration({ body, allowlist: empty, production: true, trusted: peerKeyTrust(empty, trust.trusts), registryTrust: true, nowMs: T0 })).toEqual({ ok: true, mode: "allowlist" });
  });
});

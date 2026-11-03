import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { verifySignedRegistry } from "../../src/discovery/registry.js";
import type { FetchLike } from "../../src/discovery/selector.js";
import { publicKeyFingerprint } from "../../src/security/key-fingerprint.js";
import {
  CoordinatorRegistryService,
  RegistryHealthChecker,
  admissionProblems,
  parseRegistrySeeds,
  registerRegistryRoutes,
  registryServiceFromEnv,
  type PoolMember
} from "../../src/portal/coordinator-registry.js";

function signingKeyPem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

interface FakeCoord {
  keys: PeerKeys;
  down?: boolean;
  health?: number;
  healthOk?: boolean;
  present?: PeerKeys;
}

function fakeFetch(coords: Record<string, FakeCoord>, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    const base = Object.keys(coords).find((b) => url.startsWith(`${b}/`));
    const c = base ? coords[base] : undefined;
    if (!c || c.down) throw new Error("ECONNREFUSED");
    if (url.endsWith("/identity")) {
      const k = c.present ?? c.keys;
      return { status: 200, json: async () => ({ peerId: k.peerId, publicKeyPem: k.publicKeyPem }) };
    }
    if (url.endsWith("/health/runtime")) return { status: c.health ?? 200, json: async () => ({ ok: c.healthOk ?? true }) };
    return { status: 404, json: async () => ({}) };
  };
}

function member(keys: PeerKeys, url: string, over: Partial<PoolMember> = {}): PoolMember {
  return {
    peerId: keys.peerId,
    publicKeyFingerprint: publicKeyFingerprint(keys.publicKeyPem),
    urls: [url],
    region: "ord",
    operator: { id: "edgecoder", name: "EdgeCoder", kind: "edgecoder" },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: 1,
    ...over
  };
}

describe("REGISTRY_SEEDS and admission rules", () => {
  it("parses seeds, merging repeated peers into one member with several URLs", () => {
    const fp = "b".repeat(64);
    const seeds = parseRegistrySeeds(`coord-1:${fp}@https://seed.example=ord, coord-1:${fp}@https://seed-2.example/, coord-2:${"c".repeat(64)}@https://eu.example=ams`, 5);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toMatchObject({ peerId: "coord-1", urls: ["https://seed.example", "https://seed-2.example"], region: "ord", admittedAtMs: 5, operator: { kind: "edgecoder" } });
    expect(seeds[1].region).toBe("ams");
    expect(parseRegistrySeeds(undefined)).toEqual([]);
    expect(() => parseRegistrySeeds("coord-1@https://x")).toThrow(/REGISTRY_SEEDS/);
    expect(() => parseRegistrySeeds(`a:${fp}@https://x,a:${"d".repeat(64)}@https://y`)).toThrow(/two keys/);
  });

  it("requires a verified operator, a published key and https for community coordinators", () => {
    const k = createPeerKeys("community-1");
    const base = member(k, "https://c.example", { operator: { id: "op", name: "Op", kind: "community" } });
    expect(admissionProblems(base)).toEqual([]);
    expect(admissionProblems({ ...base, admission: { ...base.admission, verifiedOperator: false } })).toContain("operator_not_verified");
    expect(admissionProblems({ ...base, admission: { ...base.admission, publishedKey: false } })).toContain("key_not_published");
    expect(admissionProblems({ ...base, urls: ["http://c.example"] })[0]).toMatch(/^url_not_https/);
    // a seed may be plain http (local stacks) and needs no operator verification flag beyond the seed's own
    expect(admissionProblems(member(k, "http://127.0.0.1:4301"))).toEqual([]);
  });
});

describe("RegistryHealthChecker", () => {
  it("marks a coordinator healthy when /identity matches and health answers", async () => {
    const k = createPeerKeys("coord-a");
    const checker = new RegistryHealthChecker({ fetch: fakeFetch({ "https://a.example": { keys: k } }) });
    const r = await checker.checkMember(member(k, "https://a.example"));
    expect(r.health).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
    expect(r.passingUrls).toEqual(["https://a.example"]);
  });

  it("marks a wrong peerId or key unhealthy at once", async () => {
    const k = createPeerKeys("coord-a");
    const impostor = createPeerKeys("coord-a");
    const r = await new RegistryHealthChecker({ fetch: fakeFetch({ "https://a.example": { keys: k, present: impostor } }) }).checkMember(member(k, "https://a.example"));
    expect(r.health).toMatchObject({ status: "unhealthy", reason: "identity_key_mismatch" });
    const other = createPeerKeys("coord-b");
    const r2 = await new RegistryHealthChecker({ fetch: fakeFetch({ "https://a.example": { keys: k, present: other } }) }).checkMember(member(k, "https://a.example"));
    expect(r2.health).toMatchObject({ status: "unhealthy", reason: "identity_peer_mismatch" });
  });

  it("needs consecutive failures before a healthy coordinator is marked unhealthy", async () => {
    const k = createPeerKeys("coord-a");
    const coords = { "https://a.example": { keys: k } as FakeCoord };
    const checker = new RegistryHealthChecker({ fetch: fakeFetch(coords), failThreshold: 2 });
    const m = member(k, "https://a.example");
    const ok = await checker.checkMember(m);
    coords["https://a.example"].health = 503;
    const once = await checker.checkMember(m, ok);
    expect(once.health).toMatchObject({ status: "healthy", reason: "health_503", consecutiveFailures: 1 });
    const twice = await checker.checkMember(m, once);
    expect(twice.health).toMatchObject({ status: "unhealthy", consecutiveFailures: 2 });
    expect(twice.passingUrls).toEqual([]);
    // health ok:false counts as a failure too; never-checked members stay unknown on the first failure
    coords["https://a.example"].health = 200;
    coords["https://a.example"].healthOk = false;
    expect((await checker.checkMember(m)).health).toMatchObject({ status: "unknown", reason: "health_not_ok" });
    coords["https://a.example"].down = true;
    expect((await checker.checkMember(m)).health.reason).toBe("unreachable");
  });

  it("publishes only the URLs that passed", async () => {
    const k = createPeerKeys("coord-a");
    const checker = new RegistryHealthChecker({ fetch: fakeFetch({ "https://a.example": { keys: k }, "https://a2.example": { keys: k, down: true } }) });
    const r = await checker.checkMember(member(k, "https://a.example", { urls: ["https://a2.example", "https://a.example"] }));
    expect(r).toMatchObject({ health: { status: "healthy" }, passingUrls: ["https://a.example"] });
  });
});

describe("CoordinatorRegistryService", () => {
  function setup() {
    const a = createPeerKeys("coord-a");
    const b = createPeerKeys("coord-b");
    const coords: Record<string, FakeCoord> = { "https://a.example": { keys: a }, "https://b.example": { keys: b, health: 503 } };
    const pem = signingKeyPem();
    let t = 1_800_000_000_000;
    const now = () => t;
    const service = new CoordinatorRegistryService({
      seeds: [member(a, "https://a.example"), member(b, "https://b.example", { region: "fra" })],
      signingKeyPem: pem,
      checker: new RegistryHealthChecker({ fetch: fakeFetch(coords), now, failThreshold: 1 }),
      now
    });
    return { a, b, coords, service, pem, advance: (ms: number) => (t += ms), now };
  }

  it("signs a registry that clients verify, with unhealthy members marked", async () => {
    const { service, now } = setup();
    await service.runChecks();
    const doc = service.signed();
    expect(doc).not.toBeNull();
    const v = verifySignedRegistry(doc, { publicKeys: [service.publicKey()!.publicKeyPem], now });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const byPeer = Object.fromEntries(v.registry.coordinators.map((c) => [c.peerId, c]));
    expect(byPeer["coord-a"].health.status).toBe("healthy");
    expect(byPeer["coord-b"].health).toMatchObject({ status: "unhealthy", reason: "health_503" });
    expect(v.registry.fallbackUrls).toEqual([]);
    expect(registryServiceFromEnv({ REGISTRY_SIGNING_KEY_PEM: signingKeyPem().replace(/\n/g, "\\n") }).snapshot().fallbackUrls).toEqual(["https://coordinator.edgecoder.io"]);
  });

  it("re-signs after a health round and when the document ages", async () => {
    const { service, coords, advance } = setup();
    await service.runChecks();
    const first = service.signed();
    expect(service.signed()).toBe(first);
    coords["https://b.example"].health = 200;
    await service.runChecks();
    const second = service.signed();
    expect(second).not.toBe(first);
    advance(6 * 60_000);
    expect(service.signed()).not.toBe(second);
  });

  it("is not served without a signing key", () => {
    expect(new CoordinatorRegistryService({}).signed()).toBeNull();
    expect(registryServiceFromEnv({}).configured).toBe(false);
  });

  it("admits community coordinators that pass the rules, persists them, and can suspend them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-pool-"));
    const poolFile = join(dir, "pool.json");
    const c = createPeerKeys("community-1");
    const service = new CoordinatorRegistryService({ signingKeyPem: signingKeyPem(), poolFile, checker: new RegistryHealthChecker({ fetch: fakeFetch({ "https://c.example": { keys: c } }) }) });
    const m = member(c, "https://c.example", { operator: { id: "op", name: "Op", kind: "community" } });
    expect(service.admit({ ...m, admission: { ...m.admission, verifiedOperator: false } })).toEqual(["operator_not_verified"]);
    expect(service.admit(m)).toEqual([]);
    expect(JSON.parse(readFileSync(poolFile, "utf8"))[0].peerId).toBe("community-1");
    await service.runChecks();
    expect(service.snapshot().coordinators[0].health.status).toBe("healthy");
    expect(service.setSuspended("community-1", true)).toBe(true);
    expect(service.snapshot().coordinators).toHaveLength(0);
    // reloaded from the file
    const again = new CoordinatorRegistryService({ poolFile });
    expect(again.members()[0]).toMatchObject({ peerId: "community-1", suspended: true });
  });

  it("serves the routes: public signed registry, admin-only admissions", async () => {
    const { service } = setup();
    await service.runChecks();
    const app = Fastify();
    let admin = false;
    registerRegistryRoutes(app, {
      service,
      requireAdmin: async (_req, reply) => {
        if (!admin) reply.code(403).send({ error: "system_admin_required" });
        return admin;
      }
    });
    const reg = await app.inject({ method: "GET", url: "/network/registry" });
    expect(reg.statusCode).toBe(200);
    expect(reg.headers["cache-control"]).toContain("max-age=30");
    expect(reg.json().format).toBe("edgecoder-registry/1");
    expect((await app.inject({ method: "GET", url: "/network/registry/public-key" })).json().keyId).toMatch(/^[0-9a-f]{64}$/);

    const c = createPeerKeys("community-2");
    const body = { peerId: c.peerId, publicKeyFingerprint: publicKeyFingerprint(c.publicKeyPem), urls: ["https://c2.example"], operator: { id: "op2" }, admission: { verifiedOperator: true, publishedKey: true } };
    expect((await app.inject({ method: "POST", url: "/admin/network/registry/admissions", payload: body })).statusCode).toBe(403);
    admin = true;
    expect((await app.inject({ method: "POST", url: "/admin/network/registry/admissions", payload: { ...body, admission: { verifiedOperator: false, publishedKey: true } } })).statusCode).toBe(422);
    // the body cannot claim to be an EdgeCoder seed
    const ok = await app.inject({ method: "POST", url: "/admin/network/registry/admissions", payload: { ...body, operator: { id: "op2", kind: "edgecoder" } } });
    expect(ok.statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: "/admin/network/registry" })).json();
    expect(list.members.find((m: { peerId: string }) => m.peerId === "community-2").operator.kind).toBe("community");
    expect((await app.inject({ method: "POST", url: "/admin/network/registry/suspend", payload: { peerId: "coord-a" } })).statusCode).toBe(404);

    const bare = Fastify();
    registerRegistryRoutes(bare, { service: new CoordinatorRegistryService({}), requireAdmin: async () => true });
    expect((await bare.inject({ method: "GET", url: "/network/registry" })).statusCode).toBe(503);
  });
});

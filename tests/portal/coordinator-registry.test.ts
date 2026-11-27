import { generateKeyPairSync } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createPeerKeys, signPayload, type PeerKeys } from "../../src/mesh/peer.js";
import { verifySignedRegistry } from "../../src/discovery/registry.js";
import { publicKeyFingerprint } from "../../src/security/key-fingerprint.js";
import { answerIdentityChallenge } from "../../src/trust/identity-challenge.js";
import { MemoryRegistryStore, verifyAuditChain } from "../../src/portal/coordinator-registry-store.js";
import {
  CoordinatorRegistryService,
  DAY_MS,
  RegistryHealthChecker,
  admissionProblems,
  keyRotationPayload,
  parseRegistrySeeds,
  registerRegistryRoutes,
  registryServiceFromEnv,
  type PoolMember,
  type RegistryFetch,
  type RegistryPasskey
} from "../../src/portal/coordinator-registry.js";

function signingKeyPem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

interface FakeCoord {
  keys: PeerKeys;
  down?: boolean;
  health?: number;
  healthOk?: boolean;
  /** The identity /identity reports (default: keys). */
  present?: PeerKeys;
  /** The key the challenge is signed with (default: present ?? keys). */
  signer?: PeerKeys;
  /** Answer every challenge with this one recorded answer (a replay). */
  replay?: unknown;
  /** The coordinator's own public URL (default: the URL it is reached on). */
  publicUrl?: string;
  lastAnswer?: unknown;
}

function fakeFetch(coords: Record<string, FakeCoord>, calls: string[] = []): RegistryFetch {
  return async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const base = Object.keys(coords).find((b) => url.startsWith(`${b}/`));
    const c = base ? coords[base] : undefined;
    if (!base || !c || c.down) throw new Error("ECONNREFUSED");
    const shown = c.present ?? c.keys;
    if (url.endsWith("/identity/challenge")) {
      if (c.replay) return { status: 200, json: async () => c.replay };
      const signer = c.signer ?? shown;
      const answer = answerIdentityChallenge(JSON.parse(init.body ?? "{}"), {
        peerId: shown.peerId,
        publicKeyPem: shown.publicKeyPem,
        privateKeyPem: signer.privateKeyPem,
        publicUrl: c.publicUrl ?? base
      });
      c.lastAnswer = answer;
      return { status: answer ? 200 : 400, json: async () => answer ?? { error: "invalid_challenge" } };
    }
    if (url.endsWith("/identity")) return { status: 200, json: async () => ({ peerId: shown.peerId, publicKeyPem: shown.publicKeyPem }) };
    if (url.endsWith("/health/runtime")) return { status: c.health ?? 200, json: async () => ({ ok: c.healthOk ?? true }) };
    return { status: 404, json: async () => ({}) };
  };
}

function seed(keys: PeerKeys, url: string, over: Partial<PoolMember> = {}): PoolMember {
  return {
    peerId: keys.peerId,
    publicKeyFingerprint: publicKeyFingerprint(keys.publicKeyPem),
    urls: [url],
    region: "us",
    operator: { id: "edgecoder", name: "EdgeCoder", kind: "edgecoder" },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: 1,
    ...over
  };
}

const goodAccount = async () => ({ exists: true, emailVerified: true, passkeys: 1 });

function application(keys: PeerKeys, url: string) {
  return { nodeId: keys.peerId, publicKeyFingerprint: publicKeyFingerprint(keys.publicKeyPem), urls: [url], region: "sin", contact: "ops@example.org", operatorName: "Op" };
}

function setup(over: { coords?: Record<string, FakeCoord>; operatorAccount?: typeof goodAccount; maxMembersPerOperator?: number } = {}) {
  const us = createPeerKeys("coord-us");
  const coords: Record<string, FakeCoord> = { "https://us.example": { keys: us }, ...(over.coords ?? {}) };
  let t = Date.UTC(2026, 10, 1, 12, 0, 0);
  const now = () => t;
  const store = new MemoryRegistryStore();
  const service = new CoordinatorRegistryService({
    seeds: [seed(us, "https://us.example")],
    store,
    signingKeyPem: signingKeyPem(),
    checker: new RegistryHealthChecker({ fetch: fakeFetch(coords), now, failThreshold: 1 }),
    now,
    operatorAccount: over.operatorAccount ?? goodAccount,
    maxMembersPerOperator: over.maxMembersPerOperator
  });
  return { us, coords, store, service, now, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
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
    const base = seed(k, "https://c.example", { operator: { id: "op", name: "Op", kind: "community" } });
    expect(admissionProblems(base)).toEqual([]);
    expect(admissionProblems({ ...base, admission: { ...base.admission, verifiedOperator: false } })).toContain("operator_not_verified");
    expect(admissionProblems({ ...base, admission: { ...base.admission, publishedKey: false } })).toContain("key_not_published");
    expect(admissionProblems({ ...base, urls: ["http://c.example"] })[0]).toMatch(/^url_not_https/);
    expect(admissionProblems(seed(k, "http://127.0.0.1:4301"))).toEqual([]);
  });
});

describe("address challenge", () => {
  const fp = (k: PeerKeys) => publicKeyFingerprint(k.publicKeyPem);

  it("passes when /identity/challenge is signed by the enrolled key for a fresh nonce", async () => {
    const k = createPeerKeys("coord-a");
    const calls: string[] = [];
    const checker = new RegistryHealthChecker({ fetch: fakeFetch({ "https://a.example": { keys: k } }, calls) });
    const r = await checker.checkMember({ peerId: k.peerId, publicKeyFingerprint: fp(k), urls: ["https://a.example"] });
    expect(r.health).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
    expect(calls).toContain("POST https://a.example/identity/challenge");
  });

  it("fails at once when the challenge is signed by another key (wrong key)", async () => {
    const k = createPeerKeys("coord-a");
    const other = createPeerKeys("coord-a");
    const checker = new RegistryHealthChecker({ fetch: fakeFetch({ "https://a.example": { keys: k, signer: other } }) });
    const r = await checker.checkMember({ peerId: k.peerId, publicKeyFingerprint: fp(k), urls: ["https://a.example"] });
    expect(r).toMatchObject({ health: { status: "unhealthy", reason: "challenge_bad_signature" }, identityFailure: true });
    // a key that does not match the enrolled fingerprint never gets as far as the challenge
    const r2 = await new RegistryHealthChecker({ fetch: fakeFetch({ "https://a.example": { keys: k, present: other } }) }).checkMember({ peerId: k.peerId, publicKeyFingerprint: fp(k), urls: ["https://a.example"] });
    expect(r2.health).toMatchObject({ status: "unhealthy", reason: "identity_key_mismatch" });
  });

  it("refuses a replayed answer (an earlier nonce)", async () => {
    const k = createPeerKeys("coord-a");
    const coord: FakeCoord = { keys: k };
    let n = 0;
    const checker = new RegistryHealthChecker({ fetch: fakeFetch({ "https://a.example": coord }), newNonce: () => `nonce-${++n}-${"x".repeat(24)}` });
    const m = { peerId: k.peerId, publicKeyFingerprint: fp(k), urls: ["https://a.example"] };
    expect((await checker.checkMember(m)).health.status).toBe("healthy");
    coord.replay = coord.lastAnswer; // an impostor replays the real coordinator's signed answer
    const r = await checker.checkMember(m);
    expect(r).toMatchObject({ health: { status: "unhealthy", reason: "challenge_nonce_mismatch" }, identityFailure: true });
  });

  it("fails only the URL whose coordinator names another public URL", async () => {
    const k = createPeerKeys("coord-a");
    const coords = { "https://a.example": { keys: k }, "https://relay.example": { keys: k, publicUrl: "https://a.example" } };
    const r = await new RegistryHealthChecker({ fetch: fakeFetch(coords) }).checkMember({ peerId: k.peerId, publicKeyFingerprint: fp(k), urls: ["https://relay.example", "https://a.example"] });
    expect(r).toMatchObject({ health: { status: "healthy" }, passingUrls: ["https://a.example"] });
  });

  it("needs consecutive network failures before a healthy coordinator is marked unhealthy", async () => {
    const k = createPeerKeys("coord-a");
    const coords = { "https://a.example": { keys: k } as FakeCoord };
    const checker = new RegistryHealthChecker({ fetch: fakeFetch(coords), failThreshold: 2 });
    const m = { peerId: k.peerId, publicKeyFingerprint: fp(k), urls: ["https://a.example"] };
    const ok = await checker.checkMember(m);
    coords["https://a.example"].health = 503;
    const once = await checker.checkMember(m, ok);
    expect(once.health).toMatchObject({ status: "healthy", reason: "health_503", consecutiveFailures: 1 });
    expect((await checker.checkMember(m, once)).health).toMatchObject({ status: "unhealthy", consecutiveFailures: 2 });
  });
});

describe("CoordinatorRegistryService", () => {
  it("writes the seeds as active platform members and signs a registry clients verify", async () => {
    const { service, now, store } = setup();
    await service.runChecks();
    expect(service.members()[0]).toMatchObject({ nodeId: "coord-us", operatorKind: "edgecoder", status: "active" });
    const v = verifySignedRegistry(service.signed(), { publicKeys: [service.publicKey()!.publicKeyPem], now });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.registry.coordinators[0]).toMatchObject({ peerId: "coord-us", status: "active", health: { status: "healthy" } });
    // seeding again changes nothing
    await service.load();
    expect((await store.listAudit()).map((e) => e.action)).toEqual(["seeded"]);
    expect(registryServiceFromEnv({}).configured).toBe(false);
  });

  it("admits a verified operator after the key challenge: pending, then probation on approval", async () => {
    const c = createPeerKeys("community-1");
    const { service } = setup({ coords: { "https://c.example": { keys: c } } });
    const r = await service.apply(application(c, "https://c.example"), "user-op");
    expect(r).toMatchObject({ ok: true, member: { status: "pending", operatorUserId: "user-op", admission: { publishedKey: true, verifiedOperator: true } } });
    // pending is not published
    expect(service.snapshot().coordinators.map((x) => x.peerId)).toEqual(["coord-us"]);
    const a = await service.approve("community-1", "owner");
    expect(a).toMatchObject({ ok: true, member: { status: "probation" } });
    expect(service.snapshot().coordinators.find((x) => x.peerId === "community-1")).toMatchObject({ status: "probation", operator: { kind: "community", id: "user-op" } });
  });

  it("refuses applicants without a verified email and passkey, plain http, or a failing challenge", async () => {
    const c = createPeerKeys("community-1");
    const impostor = createPeerKeys("community-1");
    const noPasskey = setup({ coords: { "https://c.example": { keys: c } }, operatorAccount: async () => ({ exists: true, emailVerified: true, passkeys: 0 }) });
    expect(await noPasskey.service.apply(application(c, "https://c.example"), "u")).toMatchObject({ ok: false, problems: ["operator_passkey_required"] });
    const unverified = setup({ coords: { "https://c.example": { keys: c } }, operatorAccount: async () => ({ exists: true, emailVerified: false, passkeys: 1 }) });
    expect(await unverified.service.apply(application(c, "https://c.example"), "u")).toMatchObject({ ok: false, problems: ["operator_email_not_verified"] });
    const { service } = setup({ coords: { "http://c.example": { keys: c }, "https://bad.example": { keys: c, signer: impostor } } });
    const http = await service.apply(application(c, "http://c.example"), "u");
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.problems?.[0]).toMatch(/^url_not_https/);
    expect(await service.apply(application(c, "https://bad.example"), "u")).toMatchObject({ ok: false, error: "identity_challenge_failed" });
    expect(await service.apply(application(createPeerKeys("coord-us"), "https://us.example"), "u")).toMatchObject({ ok: false, error: "node_is_a_platform_coordinator" });
  });

  it("caps members per operator", async () => {
    const keys = [createPeerKeys("op-1"), createPeerKeys("op-2"), createPeerKeys("op-3")];
    const coords = Object.fromEntries(keys.map((k) => [`https://${k.peerId}.example`, { keys: k }]));
    const { service } = setup({ coords, maxMembersPerOperator: 2 });
    expect((await service.apply(application(keys[0], "https://op-1.example"), "u")).ok).toBe(true);
    expect((await service.apply(application(keys[1], "https://op-2.example"), "u")).ok).toBe(true);
    expect(await service.apply(application(keys[2], "https://op-3.example"), "u")).toMatchObject({ ok: false, error: "operator_cap_reached" });
    // another operator is not affected; a suspended member frees a slot, so it can be reinstated
    expect((await service.apply(application(keys[2], "https://op-3.example"), "u2")).ok).toBe(true);
    await service.approve("op-1", "owner");
    await service.suspend("op-1", "owner", "test");
    expect(await service.approve("op-1", "owner")).toMatchObject({ ok: true });
  });

  it("moves probation to active after 7 clean UTC days, and a failing day resets the count", async () => {
    const c = createPeerKeys("community-1");
    const { service, coords, advance, store } = setup({ coords: { "https://c.example": { keys: c } } });
    await service.apply(application(c, "https://c.example"), "user-op");
    await service.approve("community-1", "owner");
    const status = () => service.members().find((m) => m.nodeId === "community-1")!;
    // day 0 (approval day) does not count; days 1..3 are clean
    for (let h = 0; h < 4 * 24; h += 6) {
      advance(6 * 3_600_000);
      await service.runChecks();
    }
    expect(status()).toMatchObject({ status: "probation", cleanDays: 3 });
    // a failure on day 4 makes that day dirty and resets the count when it ends
    coords["https://c.example"].health = 503;
    advance(3_600_000);
    await service.runChecks();
    coords["https://c.example"].health = 200;
    advance(DAY_MS);
    await service.runChecks();
    expect(status()).toMatchObject({ status: "probation", cleanDays: 0 });
    for (let d = 0; d < 7; d++) {
      expect(status().status).toBe("probation");
      advance(DAY_MS);
      await service.runChecks();
    }
    expect(status()).toMatchObject({ status: "active", cleanDays: 7 });
    expect((await store.listAudit()).map((e) => e.action)).toContain("promoted");
  });

  it("suspends a community member whose identity keeps failing past the threshold", async () => {
    const c = createPeerKeys("community-1");
    const impostor = createPeerKeys("community-1");
    const { service, coords, advance } = setup({ coords: { "https://c.example": { keys: c } } });
    await service.apply(application(c, "https://c.example"), "u");
    await service.approve("community-1", "owner");
    coords["https://c.example"].signer = impostor;
    await service.runChecks();
    expect(service.members().find((m) => m.nodeId === "community-1")).toMatchObject({ status: "probation" });
    expect(service.memberHealth("community-1")?.health.status).toBe("unhealthy");
    advance(11 * 60_000);
    await service.runChecks();
    const m = service.members().find((x) => x.nodeId === "community-1")!;
    expect(m.status).toBe("suspended");
    expect(m.suspensionReason).toMatch(/^identity_mismatch/);
    expect(service.snapshot().coordinators.find((x) => x.peerId === "community-1")).toMatchObject({ status: "suspended", health: { status: "unhealthy", reason: "suspended" } });
  });

  it("rotates a key only with the old key's signature, else through the owner", async () => {
    const c = createPeerKeys("community-1");
    const next = createPeerKeys("community-1");
    const { service, coords, now, store } = setup({ coords: { "https://c.example": { keys: c } } });
    await service.apply(application(c, "https://c.example"), "u");
    await service.approve("community-1", "owner");
    const oldFp = publicKeyFingerprint(c.publicKeyPem);
    const newFp = publicKeyFingerprint(next.publicKeyPem);
    const body = (signer: PeerKeys) => ({
      nodeId: "community-1",
      oldPublicKeyPem: c.publicKeyPem,
      newPublicKeyPem: next.publicKeyPem,
      issuedAtMs: now(),
      signature: signPayload(keyRotationPayload({ nodeId: "community-1", oldFingerprint: oldFp, newFingerprint: newFp, issuedAtMs: now() }), signer.privateKeyPem)
    });
    // signed by the new key (not the old one): refused
    expect(await service.rotateKey(body(next), "u")).toMatchObject({ ok: false, error: "rotation_signature_invalid" });
    expect(await service.rotateKey(body(c), "someone-else")).toMatchObject({ ok: false, error: "not_your_coordinator" });
    const r = await service.rotateKey(body(c), "u");
    expect(r).toMatchObject({ ok: true, member: { status: "probation", keyFingerprints: [newFp, oldFp] } });
    coords["https://c.example"].keys = next;
    await service.runChecks();
    expect(service.memberHealth("community-1")?.health.status).toBe("healthy");
    // owner re-approval under yet another key (the old one is lost)
    const third = createPeerKeys("community-1");
    coords["https://c.example"].keys = third;
    const o = await service.approve("community-1", "owner", { publicKeyFingerprint: publicKeyFingerprint(third.publicKeyPem) });
    expect(o).toMatchObject({ ok: true, member: { status: "probation", keyFingerprints: [publicKeyFingerprint(third.publicKeyPem), newFp, oldFp] } });
    const actions = (await store.listAudit()).filter((e) => e.action === "key_rotated").map((e) => e.detail.via);
    expect(actions).toEqual(["old_key", "owner"]);
  });

  it("chains every audit row to the one before, and a changed row breaks the chain", async () => {
    const c = createPeerKeys("community-1");
    const { service, store } = setup({ coords: { "https://c.example": { keys: c } } });
    await service.runChecks();
    await service.apply(application(c, "https://c.example"), "u");
    await service.approve("community-1", "owner");
    await service.suspend("community-1", "owner", "abuse report");
    const { entries, chain } = await service.auditTrail();
    expect(entries.map((e) => e.action)).toEqual(["seeded", "applied", "approved", "suspended"]);
    expect(chain).toEqual({ ok: true, length: 4 });
    expect(entries[1].prevHash).toBe(entries[0].hash);
    const rows = store.auditRowsForTest();
    rows[2].detail = { ...rows[2].detail, from: "active" };
    expect(verifyAuditChain(await store.listAudit())).toMatchObject({ ok: false, brokenAtSeq: 3, reason: "hash" });
  });
});

describe("registry routes", () => {
  function app(passkeyOk: boolean) {
    const c = createPeerKeys("community-1");
    const ctx = setup({ coords: { "https://c.example": { keys: c } } });
    const verified: unknown[] = [];
    const passkey: RegistryPasskey = {
      options: async () => ({ ok: true, challengeId: "challenge-123456", options: { challenge: "x" } }),
      verify: async (_user, body) => {
        verified.push(body);
        return passkeyOk ? { ok: true } : { ok: false, status: 401, error: "passkey_verification_failed" };
      }
    };
    let admin = true;
    const f = Fastify();
    registerRegistryRoutes(f, {
      service: ctx.service,
      passkey,
      currentUser: async () => ({ userId: "user-op" }),
      requireAdmin: async (_req, reply) => {
        if (!admin) {
          reply.code(403).send({ error: "system_admin_required" });
          return null;
        }
        return { userId: "owner" };
      }
    });
    return { f, c, ctx, verified, setAdmin: (v: boolean) => (admin = v) };
  }

  it("approval needs the owner's passkey assertion for that approval", async () => {
    const { f, c, ctx, verified } = app(true);
    const applied = await f.inject({ method: "POST", url: "/portal/api/coordinators/registry/apply", payload: application(c, "https://c.example") });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().member.status).toBe("pending");
    // no assertion: refused
    const bare = await f.inject({ method: "POST", url: "/admin/network/registry/approve", payload: { nodeId: "community-1" } });
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error).toBe("passkey_required");
    expect(ctx.service.members().find((m) => m.nodeId === "community-1")!.status).toBe("pending");
    const opts = await f.inject({ method: "POST", url: "/admin/network/registry/passkey-options" });
    expect(opts.json().challengeId).toBe("challenge-123456");
    const ok = await f.inject({ method: "POST", url: "/admin/network/registry/approve", payload: { nodeId: "community-1", challengeId: "challenge-123456", response: { id: "cred" } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().member.status).toBe("probation");
    expect(verified).toHaveLength(1);
    const audit = (await f.inject({ method: "GET", url: "/admin/network/registry/audit" })).json();
    expect(audit.chain.ok).toBe(true);
    expect(audit.entries.find((e: { action: string }) => e.action === "approved").detail.confirmedWith).toBe("passkey");
    const reg = await f.inject({ method: "GET", url: "/network/registry" });
    expect(reg.statusCode).toBe(200);
    expect((await f.inject({ method: "GET", url: "/portal/api/coordinators/registry/mine" })).json().members[0].status).toBe("probation");
  });

  it("a failed assertion approves nothing; non-admins are refused", async () => {
    const { f, c, ctx, setAdmin } = app(false);
    await f.inject({ method: "POST", url: "/portal/api/coordinators/registry/apply", payload: application(c, "https://c.example") });
    const bad = await f.inject({ method: "POST", url: "/admin/network/registry/approve", payload: { nodeId: "community-1", challengeId: "challenge-123456", response: {} } });
    expect(bad.statusCode).toBe(401);
    expect(ctx.service.members().find((m) => m.nodeId === "community-1")!.status).toBe("pending");
    setAdmin(false);
    expect((await f.inject({ method: "POST", url: "/admin/network/registry/suspend", payload: { nodeId: "community-1" } })).statusCode).toBe(403);
    expect((await f.inject({ method: "GET", url: "/admin/network/registry" })).statusCode).toBe(403);
  });

  it("suspends by node id; platform coordinators cannot be suspended", async () => {
    const { f, c } = app(true);
    await f.inject({ method: "POST", url: "/portal/api/coordinators/registry/apply", payload: application(c, "https://c.example") });
    expect((await f.inject({ method: "POST", url: "/admin/network/registry/suspend", payload: { nodeId: "coord-us" } })).statusCode).toBe(409);
    const s = await f.inject({ method: "POST", url: "/admin/network/registry/suspend", payload: { nodeId: "community-1", reason: "test" } });
    expect(s.json().member).toMatchObject({ status: "suspended", suspensionReason: "test" });
    const bare = Fastify();
    registerRegistryRoutes(bare, { service: new CoordinatorRegistryService({}), passkey: null, currentUser: async () => null, requireAdmin: async () => ({ userId: "x" }) });
    expect((await bare.inject({ method: "GET", url: "/network/registry" })).statusCode).toBe(503);
  });
});

describe("ledger-service billing per member (phase 4)", () => {
  function app(passkeyOk: boolean) {
    const c = createPeerKeys("community-1");
    const ctx = setup({ coords: { "https://c.example": { keys: c } } });
    const passkey: RegistryPasskey = {
      options: async () => ({ ok: true, challengeId: "challenge-123456", options: {} }),
      verify: async () => (passkeyOk ? { ok: true } : { ok: false, status: 401, error: "passkey_verification_failed" })
    };
    const f = Fastify();
    registerRegistryRoutes(f, { service: ctx.service, passkey, currentUser: async () => ({ userId: "user-op" }), requireAdmin: async () => ({ userId: "owner" }) });
    return { f, c, ctx };
  }
  const listed = (ctx: ReturnType<typeof setup>) => ctx.service.snapshot().coordinators.find((x) => x.peerId === "community-1");

  it("is off by default, turned on only with the owner's passkey, published in the signed registry", async () => {
    const { f, c, ctx } = app(true);
    await ctx.service.apply(application(c, "https://c.example"), "user-op");
    // Not admitted yet: nothing to bill for.
    expect(await ctx.service.setBilling("community-1", "owner", true)).toMatchObject({ ok: false, error: "not_admitted" });
    await ctx.service.approve("community-1", "owner");
    expect(listed(ctx)?.billingEnabled).toBeUndefined();
    const bare = await f.inject({ method: "POST", url: "/admin/network/registry/billing", payload: { nodeId: "community-1", enabled: true } });
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error).toBe("passkey_required");
    const on = await f.inject({ method: "POST", url: "/admin/network/registry/billing", payload: { nodeId: "community-1", enabled: true, challengeId: "challenge-123456", response: { id: "cred" } } });
    expect(on.statusCode).toBe(200);
    expect(on.json().member.billingEnabled).toBe(true);
    expect(listed(ctx)).toMatchObject({ status: "probation", billingEnabled: true });
    const doc = ctx.service.signed()!;
    const v = verifySignedRegistry(doc, { publicKeys: [ctx.service.publicKey()!.publicKeyPem], now: ctx.now });
    expect(v.ok && v.registry.coordinators.find((x) => x.peerId === "community-1")?.billingEnabled).toBe(true);
    const audit = await ctx.service.auditTrail();
    expect(audit.entries.at(-1)).toMatchObject({ action: "billing_enabled", detail: { confirmedWith: "passkey" } });
    expect(audit.chain.ok).toBe(true);
    // Off needs no passkey.
    const off = await f.inject({ method: "POST", url: "/admin/network/registry/billing", payload: { nodeId: "community-1", enabled: false } });
    expect(off.json().member.billingEnabled).toBe(false);
    expect(listed(ctx)?.billingEnabled).toBeUndefined();
  });

  it("a failed assertion changes nothing; suspension and reinstatement clear the flag", async () => {
    const { f, c, ctx } = app(false);
    await ctx.service.apply(application(c, "https://c.example"), "user-op");
    await ctx.service.approve("community-1", "owner");
    const bad = await f.inject({ method: "POST", url: "/admin/network/registry/billing", payload: { nodeId: "community-1", enabled: true, challengeId: "challenge-123456", response: {} } });
    expect(bad.statusCode).toBe(401);
    expect(listed(ctx)?.billingEnabled).toBeUndefined();
    await ctx.service.setBilling("community-1", "owner", true);
    await ctx.service.suspend("community-1", "owner", "test");
    expect(ctx.service.members().find((m) => m.nodeId === "community-1")!.billingEnabled).toBe(false);
    await ctx.service.approve("community-1", "owner");
    expect(ctx.service.members().find((m) => m.nodeId === "community-1")!.billingEnabled).toBe(false);
    expect(await ctx.service.setBilling("coord-us", "owner", true)).toMatchObject({ ok: false, error: "platform_coordinator" });
  });
});

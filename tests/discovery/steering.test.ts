import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { loadRegistrySigningKey, signRegistry, type RegistryEntry, type RegistryPayload } from "../../src/discovery/registry.js";
import {
  chooseCandidate,
  createCoordinatorSteering,
  loadRegistry,
  probeRegistryEntry,
  registryUrlsFor,
  type MeasuredCandidate,
  type RegistryCache
} from "../../src/discovery/steering.js";
import { createRegistryMirror } from "../../src/discovery/registry-mirror.js";
import type { FetchLike } from "../../src/discovery/selector.js";
import { publicKeyFingerprint } from "../../src/security/key-fingerprint.js";
import { PinnedKeyStore } from "../../src/trust/pinned-keys.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function registryKey() {
  const kp = generateKeyPairSync("ed25519");
  return loadRegistrySigningKey(kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

interface FakeCoordinator {
  keys: PeerKeys;
  latencyMs: number;
  down?: boolean;
  /** Present a different key at /identity (impersonation). */
  presentKeys?: PeerKeys;
}

function entry(c: FakeCoordinator, url: string, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    peerId: c.keys.peerId,
    publicKeyFingerprint: publicKeyFingerprint(c.keys.publicKeyPem),
    urls: [url],
    region: url.includes("fra") ? "fra" : "ord",
    operator: { id: "edgecoder", name: "EdgeCoder", kind: "edgecoder" },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: 1,
    health: { status: "healthy", checkedAtMs: Date.now(), latencyMs: 10 },
    ...over
  };
}

function registryPayload(coordinators: RegistryEntry[], issuedAtMs = Date.now()): RegistryPayload {
  return { v: 1, network: "edgecoder", issuedAtMs, expiresAtMs: issuedAtMs + 15 * 60_000, coordinators, fallbackUrls: ["https://coordinator.edgecoder.io"] };
}

/** Fake network: coordinators answer /identity after their latency (real time, so parallel probes measure independently); registry URLs serve documents. */
function fakeNet(coords: Record<string, FakeCoordinator>, registries: Record<string, unknown | (() => unknown)> = {}, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    if (url in registries) {
      const doc = registries[url];
      const body = typeof doc === "function" ? (doc as () => unknown)() : doc;
      if (body === undefined) throw new Error("ECONNREFUSED");
      if (typeof body === "number") return { status: body, json: async () => ({ error: "x" }) };
      return { status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    }
    const base = Object.keys(coords).find((b) => url.startsWith(`${b}/`));
    const c = base ? coords[base] : undefined;
    if (!c || c.down) throw new Error("ECONNREFUSED");
    await sleep(c.latencyMs);
    if (url.endsWith("/identity")) {
      const k = c.presentKeys ?? c.keys;
      return { status: 200, json: async () => ({ peerId: k.peerId, publicKeyPem: k.publicKeyPem }) };
    }
    return { status: 404, json: async () => ({}) };
  };
}

function memCache(initial: string | null = null): RegistryCache & { value: string | null } {
  const c = {
    value: initial,
    read: () => c.value,
    write: (t: string) => {
      c.value = t;
    }
  };
  return c;
}

const PLATFORM = "https://coordinator.edgecoder.io";
const REG_URL = `${PLATFORM}/network/registry`;
const PORTAL_REG = "https://edgecoder.io/network/registry";

describe("loadRegistry", () => {
  it("skips a badly signed registry and takes the next URL's valid one, caching it", async () => {
    const key = registryKey();
    const attacker = registryKey();
    const a = { keys: createPeerKeys("coord-a"), latencyMs: 1 };
    const good = signRegistry(registryPayload([entry(a, "https://a.example")]), key);
    const evil = signRegistry(registryPayload([entry(a, "https://evil.example")]), attacker);
    const cache = memCache();
    const r = await loadRegistry({ urls: [REG_URL, PORTAL_REG], publicKeys: [key.publicKeyPem], fetch: fakeNet({}, { [REG_URL]: evil, [PORTAL_REG]: good }), cache });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.loaded.from).toBe(PORTAL_REG);
    expect(r.errors[0]).toContain("unknown_key");
    expect(cache.value).toBe(JSON.stringify(good));
  });

  it("never accepts an unsigned registry", async () => {
    const key = registryKey();
    const a = { keys: createPeerKeys("coord-a"), latencyMs: 1 };
    const r = await loadRegistry({ urls: [REG_URL], publicKeys: [key.publicKeyPem], fetch: fakeNet({}, { [REG_URL]: registryPayload([entry(a, "https://a.example")]) }) });
    expect(r.ok).toBe(false);
  });

  it("falls back to a still-valid cache, re-verified, when the network fails", async () => {
    const key = registryKey();
    const a = { keys: createPeerKeys("coord-a"), latencyMs: 1 };
    const good = JSON.stringify(signRegistry(registryPayload([entry(a, "https://a.example")]), key));
    const r = await loadRegistry({ urls: [REG_URL], publicKeys: [key.publicKeyPem], fetch: fakeNet({}, { [REG_URL]: 503 }), cache: memCache(good) });
    expect(r.ok && r.loaded.from).toBe("cache");
    // an expired cache is not used
    const old = JSON.stringify(signRegistry(registryPayload([entry(a, "https://a.example")], Date.now() - 60 * 60_000), key));
    const r2 = await loadRegistry({ urls: [REG_URL], publicKeys: [key.publicKeyPem], fetch: fakeNet({}, { [REG_URL]: undefined }), cache: memCache(old) });
    expect(r2.ok).toBe(false);
    // a tampered cache is not used
    const tampered = good.replace("https://a.example", "https://b.example");
    const r3 = await loadRegistry({ urls: [], publicKeys: [key.publicKeyPem], cache: memCache(tampered) });
    expect(r3.ok).toBe(false);
  });

  it("refuses a replayed registry older than the one already known", async () => {
    const key = registryKey();
    const a = { keys: createPeerKeys("coord-a"), latencyMs: 1 };
    const older = signRegistry(registryPayload([entry(a, "https://a.example")], Date.now() - 60_000), key);
    const newer = JSON.stringify(signRegistry(registryPayload([entry(a, "https://a.example")], Date.now()), key));
    const r = await loadRegistry({ urls: [REG_URL], publicKeys: [key.publicKeyPem], fetch: fakeNet({}, { [REG_URL]: older }), cache: memCache(newer) });
    expect(r.ok && r.loaded.from).toBe("cache");
    expect(r.errors.join()).toContain("older_than_known");
  });
});

describe("probeRegistryEntry", () => {
  it("measures the median /identity round trip", async () => {
    const a = { keys: createPeerKeys("coord-a"), latencyMs: 15 };
    const r = await probeRegistryEntry(entry(a, "https://a.example"), "https://a.example", { fetch: fakeNet({ "https://a.example": a }) });
    expect(r.ok).toBe(true);
    expect(r.samples).toBe(3);
    expect(r.latencyMs).toBeGreaterThanOrEqual(10);
  });

  it("disqualifies a coordinator whose key or peerId does not match the registry", async () => {
    const a = { keys: createPeerKeys("coord-a"), latencyMs: 1, presentKeys: createPeerKeys("coord-a") };
    const r = await probeRegistryEntry(entry(a, "https://a.example"), "https://a.example", { fetch: fakeNet({ "https://a.example": a }) });
    expect(r).toMatchObject({ ok: false, error: "identity_mismatch" });
    const b = { keys: createPeerKeys("coord-b"), latencyMs: 1, presentKeys: createPeerKeys("coord-other") };
    const r2 = await probeRegistryEntry(entry(b, "https://b.example"), "https://b.example", { fetch: fakeNet({ "https://b.example": b }) });
    expect(r2.error).toBe("identity_mismatch");
  });

  it("fails an unreachable coordinator", async () => {
    const a = { keys: createPeerKeys("coord-a"), latencyMs: 1, down: true };
    const r = await probeRegistryEntry(entry(a, "https://a.example"), "https://a.example", { fetch: fakeNet({ "https://a.example": a }) });
    expect(r).toMatchObject({ ok: false, error: "unreachable" });
  });
});

describe("chooseCandidate", () => {
  const mk = (peerId: string, latencyMs: number): MeasuredCandidate => ({
    entry: { ...entry({ keys: createPeerKeys(peerId), latencyMs: 0 }, `https://${peerId}.example`) },
    url: `https://${peerId}.example`,
    latencyMs
  });
  const fast = mk("fast", 20);
  const mid = mk("mid", 40);
  const slow = mk("slow", 200);

  it("picks the lowest latency with no current coordinator", () => {
    expect(chooseCandidate([slow, mid, fast], null)?.pick.entry.peerId).toBe("fast");
    expect(chooseCandidate([], null)).toBeNull();
  });

  it("keeps the current coordinator when the best is not clearly faster (hysteresis)", () => {
    const r = chooseCandidate([fast, mid], { peerId: "mid", url: mid.url });
    expect(r).toMatchObject({ kept: true });
    expect(r?.pick.entry.peerId).toBe("mid");
  });

  it("switches when the best beats the current by both margins", () => {
    const r = chooseCandidate([fast, slow], { peerId: "slow", url: slow.url });
    expect(r).toMatchObject({ kept: false });
    expect(r?.pick.entry.peerId).toBe("fast");
  });

  it("needs both the ratio and the absolute gain", () => {
    const a = mk("a", 4);
    const b = mk("b", 20); // 5x slower but only 16 ms
    expect(chooseCandidate([a, b], { peerId: "b" })?.pick.entry.peerId).toBe("b");
    expect(chooseCandidate([a, b], { peerId: "b" }, { ratio: 0.25, minGainMs: 5 })?.pick.entry.peerId).toBe("a");
  });

  it("moves off a current coordinator that is no longer a candidate", () => {
    expect(chooseCandidate([fast, mid], { peerId: "gone", url: "https://gone.example" })?.pick.entry.peerId).toBe("fast");
  });
});

describe("createCoordinatorSteering", () => {
  function world() {
    const key = registryKey();
    const ord = { keys: createPeerKeys("coord-ord"), latencyMs: 5 };
    const fra = { keys: createPeerKeys("coord-fra"), latencyMs: 90 };
    const coords: Record<string, FakeCoordinator> = { "https://ord.example": ord, "https://fra.example": fra };
    return { key, ord, fra, coords };
  }

  it("picks the fastest healthy coordinator and verifies its identity against the registry", async () => {
    const { key, ord, fra, coords } = world();
    const doc = signRegistry(registryPayload([entry(fra, "https://fra.example"), entry(ord, "https://ord.example")]), key);
    const s = createCoordinatorSteering({ registryUrls: [REG_URL], publicKeys: [key.publicKeyPem], fallbackUrl: PLATFORM, fetch: fakeNet(coords, { [REG_URL]: doc }) });
    const r = await s.steer();
    expect(r).toMatchObject({ source: "registry", url: "https://ord.example", peerId: "coord-ord", region: "ord", reason: "" });
    expect(r.latencyMs).toBeGreaterThanOrEqual(1);
    expect(r.registry).toMatchObject({ coordinators: 2, healthy: 2, verified: 2, from: REG_URL });
    expect(s.trustedEntries().get("coord-fra")).toBe(publicKeyFingerprint(fra.keys.publicKeyPem));
  });

  it("excludes unhealthy coordinators without probing them", async () => {
    const { key, ord, fra, coords } = world();
    const calls: string[] = [];
    const doc = signRegistry(
      registryPayload([entry(ord, "https://ord.example", { health: { status: "unhealthy", checkedAtMs: 1, latencyMs: null, reason: "health_503" } }), entry(fra, "https://fra.example")]),
      key
    );
    const s = createCoordinatorSteering({ registryUrls: [REG_URL], publicKeys: [key.publicKeyPem], fallbackUrl: PLATFORM, fetch: fakeNet(coords, { [REG_URL]: doc }, calls) });
    const r = await s.steer();
    expect(r.url).toBe("https://fra.example");
    expect(calls.some((u) => u.startsWith("https://ord.example"))).toBe(false);
  });

  it("skips a listed coordinator that presents another key", async () => {
    const { key, ord, fra, coords } = world();
    ord.presentKeys = createPeerKeys("coord-ord");
    const doc = signRegistry(registryPayload([entry(ord, "https://ord.example"), entry(fra, "https://fra.example")]), key);
    const s = createCoordinatorSteering({ registryUrls: [REG_URL], publicKeys: [key.publicKeyPem], fallbackUrl: PLATFORM, fetch: fakeNet(coords, { [REG_URL]: doc }) });
    expect((await s.steer()).url).toBe("https://fra.example");
  });

  it("falls back to the configured URL when the registry is missing, unsigned, badly signed, or empty of usable coordinators", async () => {
    const { key, ord, coords } = world();
    const base = { registryUrls: [REG_URL], publicKeys: [key.publicKeyPem], fallbackUrl: `${PLATFORM}/` };
    const down = await createCoordinatorSteering({ ...base, fetch: fakeNet(coords, { [REG_URL]: undefined }) }).steer();
    expect(down).toMatchObject({ source: "fallback", url: PLATFORM });
    expect(down.reason).toContain("registry_unavailable");
    const unsigned = await createCoordinatorSteering({ ...base, fetch: fakeNet(coords, { [REG_URL]: registryPayload([entry(ord, "https://ord.example")]) }) }).steer();
    expect(unsigned.source).toBe("fallback");
    const forged = signRegistry(registryPayload([entry(ord, "https://ord.example")]), registryKey());
    expect((await createCoordinatorSteering({ ...base, fetch: fakeNet(coords, { [REG_URL]: forged }) }).steer()).source).toBe("fallback");
    const allDown = signRegistry(registryPayload([entry({ ...ord, down: true }, "https://nowhere.example")]), key);
    const r = await createCoordinatorSteering({ ...base, fetch: fakeNet(coords, { [REG_URL]: allDown }) }).steer();
    expect(r).toMatchObject({ source: "fallback", reason: "no_verified_coordinators" });
    const noneHealthy = signRegistry(registryPayload([entry(ord, "https://ord.example", { health: { status: "unknown", checkedAtMs: null, latencyMs: null } })]), key);
    expect((await createCoordinatorSteering({ ...base, fetch: fakeNet(coords, { [REG_URL]: noneHealthy }) }).steer()).reason).toBe("no_healthy_coordinators");
    expect((await createCoordinatorSteering({ ...base, publicKeys: [] }).steer()).reason).toBe("no_registry_key");
  });

  it("does not flap between rounds (hysteresis) but leaves a coordinator that went away", async () => {
    const { key, ord, fra, coords } = world();
    ord.latencyMs = 40;
    fra.latencyMs = 5;
    const doc = signRegistry(registryPayload([entry(ord, "https://ord.example"), entry(fra, "https://fra.example")]), key);
    const s = createCoordinatorSteering({ registryUrls: [REG_URL], publicKeys: [key.publicKeyPem], fallbackUrl: PLATFORM, fetch: fakeNet(coords, { [REG_URL]: doc }), hysteresis: { ratio: 1, minGainMs: 100 } });
    expect((await s.steer()).url).toBe("https://fra.example");
    // ord becomes a little faster than fra: not enough to switch
    ord.latencyMs = 3;
    fra.latencyMs = 12;
    const second = await s.steer();
    expect(second).toMatchObject({ url: "https://fra.example", kept: true });
    // fra goes down: move
    fra.down = true;
    expect((await s.steer()).url).toBe("https://ord.example");
  });

  it("feeds registry keys to the trust store, which then trusts them in strict mode", async () => {
    const { key, ord, coords } = world();
    const doc = signRegistry(registryPayload([entry(ord, "https://ord.example")]), key);
    const s = createCoordinatorSteering({ registryUrls: [REG_URL], publicKeys: [key.publicKeyPem], fallbackUrl: PLATFORM, fetch: fakeNet(coords, { [REG_URL]: doc }) });
    await s.steer();
    const store = new PinnedKeyStore({ mode: "strict", entries: "", pinFile: null });
    expect(store.isTrusted("coord-ord", ord.keys.publicKeyPem).trusted).toBe(false);
    store.setRegistryEntries(s.trustedEntries());
    expect(store.isTrusted("coord-ord", ord.keys.publicKeyPem)).toMatchObject({ trusted: true, reason: "registry_match" });
    expect(store.isTrusted("coord-ord", createPeerKeys("coord-ord").publicKeyPem)).toMatchObject({ trusted: false, reason: "pinned_mismatch" });
  });
});

describe("registry URLs and the coordinator mirror", () => {
  it("derives the registry URLs from the platform URL and the portal", () => {
    expect(registryUrlsFor(`${PLATFORM}/`, "https://edgecoder.io", {})).toEqual([REG_URL, PORTAL_REG]);
    expect(registryUrlsFor(PLATFORM, undefined, { EDGECODER_REGISTRY_URLS: "https://mirror.example/r, nope" })).toEqual(["https://mirror.example/r"]);
  });

  it("caches the upstream document and serves the last good copy while the upstream is down", async () => {
    let up: unknown = { format: "edgecoder-registry/1", keyId: "k", payload: "{}", signature: "s" };
    let t = 0;
    const calls: string[] = [];
    const mirror = createRegistryMirror({ upstreamUrl: PORTAL_REG, now: () => t, ttlMs: 1000, fetch: fakeNet({}, { [PORTAL_REG]: () => up }, calls) });
    expect(await mirror.get()).toMatchObject({ keyId: "k" });
    await mirror.get();
    expect(calls.length).toBe(1);
    t = 5000;
    up = undefined;
    expect(await mirror.get()).toMatchObject({ keyId: "k" });
    expect(calls.length).toBe(2);
    const empty = createRegistryMirror({ upstreamUrl: PORTAL_REG, fetch: fakeNet({}, { [PORTAL_REG]: 503 }) });
    expect(await empty.get()).toBeNull();
  });
});

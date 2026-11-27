import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { loadRegistrySigningKey, signRegistry, type RegistryEntry, type RegistryPayload } from "../../src/discovery/registry.js";
import { createCoordinatorSteering, explicitCoordinatorUrl } from "../../src/discovery/steering.js";
import { applyStartupDiscovery, describeSteering } from "../../src/discovery/configured-coordinator.js";
import type { FetchLike } from "../../src/discovery/selector.js";
import { publicKeyFingerprint } from "../../src/security/key-fingerprint.js";

// Outside operators point their agents at their own coordinator (COORDINATOR_URL); steering must
// keep it while it answers and is trusted, and default installs keep steering to the platform pool.

const PLATFORM = "https://coordinator.edgecoder.io";
const OWN = "https://edgecoder-coord-sin.fly.dev";
const OWN_REG = `${OWN}/network/registry`;
const US = "https://coord-us.edgecoder.io";

interface Fake {
  keys: PeerKeys;
  down?: boolean;
}

function registryKey() {
  const kp = generateKeyPairSync("ed25519");
  return loadRegistrySigningKey(kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

function entry(c: Fake, url: string, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    peerId: c.keys.peerId,
    publicKeyFingerprint: publicKeyFingerprint(c.keys.publicKeyPem),
    urls: [url],
    region: "us",
    operator: { id: "edgecoder", name: "EdgeCoder", kind: "edgecoder" },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: 1,
    health: { status: "healthy", checkedAtMs: Date.now(), latencyMs: 10 },
    ...over
  };
}

function payload(coordinators: RegistryEntry[]): RegistryPayload {
  const now = Date.now();
  return { v: 1, network: "edgecoder", issuedAtMs: now, expiresAtMs: now + 15 * 60_000, coordinators, fallbackUrls: [PLATFORM] };
}

function net(coords: Record<string, Fake>, registries: Record<string, unknown>): FetchLike {
  return async (url) => {
    if (url in registries) return { status: 200, json: async () => JSON.parse(JSON.stringify(registries[url])) };
    const base = Object.keys(coords).find((b) => url.startsWith(`${b}/`));
    const c = base ? coords[base] : undefined;
    if (!c || c.down) throw new Error("ECONNREFUSED");
    if (url.endsWith("/identity")) return { status: 200, json: async () => ({ peerId: c.keys.peerId, publicKeyPem: c.keys.publicKeyPem }) };
    return { status: 404, json: async () => ({}) };
  };
}

function setup(opts: { ownDown?: boolean; ownListed?: boolean } = {}) {
  const key = registryKey();
  const us: Fake = { keys: createPeerKeys("coord-us") };
  const own: Fake = { keys: createPeerKeys("coord-sin"), down: opts.ownDown };
  const entries = [entry(us, US)];
  if (opts.ownListed) entries.push(entry(own, OWN, { region: "sin", operator: { id: "op-sin", name: "SIN", kind: "community" } }));
  const doc = signRegistry(payload(entries), key);
  return { key, us, own, fetch: net({ [US]: us, [OWN]: own }, { [OWN_REG]: doc, [`${PLATFORM}/network/registry`]: doc }) };
}

describe("explicitCoordinatorUrl", () => {
  it("treats unset, the platform URL and loopback as a default install", () => {
    expect(explicitCoordinatorUrl(undefined)).toBeNull();
    expect(explicitCoordinatorUrl("https://coordinator.edgecoder.io/")).toBeNull();
    expect(explicitCoordinatorUrl("http://127.0.0.1:4301")).toBeNull();
    expect(explicitCoordinatorUrl(`${OWN}/`)).toBe(OWN);
  });
});

describe("steering with an explicitly configured coordinator", () => {
  it("keeps the configured coordinator when it is listed in the verified registry", async () => {
    const { key, own, fetch } = setup({ ownListed: true });
    const s = createCoordinatorSteering({ registryUrls: [OWN_REG], publicKeys: [key.publicKeyPem], fallbackUrl: OWN, configuredUrl: OWN, fetch });
    const r = await s.steer();
    expect(r.source).toBe("configured");
    expect(r.url).toBe(OWN);
    expect(r.peerId).toBe(own.keys.peerId);
    expect(describeSteering(r, null, OWN)).toContain(`keeping configured coordinator ${OWN}`);
  });

  it("keeps an unlisted configured coordinator that the agent's allowlist accepts", async () => {
    const { key, own, fetch } = setup();
    const s = createCoordinatorSteering({
      registryUrls: [OWN_REG],
      publicKeys: [key.publicKeyPem],
      fallbackUrl: OWN,
      configuredUrl: OWN,
      trustsConfigured: (peerId) => peerId === own.keys.peerId,
      fetch
    });
    expect((await s.steer()).source).toBe("configured");
  });

  it("steers to the platform pool when the configured coordinator is unreachable", async () => {
    const { key, us, fetch } = setup({ ownDown: true, ownListed: true });
    const s = createCoordinatorSteering({ registryUrls: [OWN_REG], publicKeys: [key.publicKeyPem], fallbackUrl: OWN, configuredUrl: OWN, trustsConfigured: () => true, fetch });
    const r = await s.steer();
    expect(r.source).toBe("registry");
    expect(r.url).toBe(US);
    expect(r.peerId).toBe(us.keys.peerId);
    expect(r.configuredProblem).toEqual({ url: OWN, problem: "unreachable" });
    expect(describeSteering(r, null, OWN)).toContain(`configured coordinator ${OWN} unreachable; steering to ${US}`);
  });

  it("steers away from a configured coordinator that is neither listed nor allowlisted", async () => {
    const { key, fetch } = setup();
    const s = createCoordinatorSteering({ registryUrls: [OWN_REG], publicKeys: [key.publicKeyPem], fallbackUrl: OWN, configuredUrl: OWN, trustsConfigured: () => false, fetch });
    const r = await s.steer();
    expect(r.source).toBe("registry");
    expect(r.url).toBe(US);
    expect(r.configuredProblem?.problem).toContain("not trusted");
  });

  it("steers away when the configured coordinator presents a key other than its registry entry", async () => {
    const key = registryKey();
    const us: Fake = { keys: createPeerKeys("coord-us") };
    const own: Fake = { keys: createPeerKeys("coord-sin") };
    const listed = { ...entry(own, OWN), publicKeyFingerprint: publicKeyFingerprint(createPeerKeys("other").publicKeyPem) };
    const doc = signRegistry(payload([entry(us, US), listed]), key);
    const s = createCoordinatorSteering({
      registryUrls: [OWN_REG],
      publicKeys: [key.publicKeyPem],
      fallbackUrl: OWN,
      configuredUrl: OWN,
      trustsConfigured: () => true,
      fetch: net({ [US]: us, [OWN]: own }, { [OWN_REG]: doc })
    });
    const r = await s.steer();
    expect(r.url).toBe(US);
    expect(r.configuredProblem?.problem).toContain("identity_mismatch");
  });

  it("returns to the configured coordinator once it answers again", async () => {
    const env = setup({ ownDown: true, ownListed: true });
    const s = createCoordinatorSteering({ registryUrls: [OWN_REG], publicKeys: [env.key.publicKeyPem], fallbackUrl: OWN, configuredUrl: OWN, fetch: env.fetch });
    expect((await s.steer()).url).toBe(US);
    env.own.down = false;
    const r = await s.steer();
    expect(r.source).toBe("configured");
    expect(r.url).toBe(OWN);
  });

  it("a default install (no configured coordinator) still steers to the platform pool", async () => {
    const { key, fetch } = setup({ ownListed: true });
    const s = createCoordinatorSteering({ registryUrls: [`${PLATFORM}/network/registry`], publicKeys: [key.publicKeyPem], fallbackUrl: PLATFORM, configuredUrl: explicitCoordinatorUrl(PLATFORM) ?? undefined, fetch });
    const r = await s.steer();
    expect(r.source).toBe("registry");
    expect(r.url).toBe(US);
    expect(r.configuredProblem).toBeUndefined();
  });
});

describe("applyStartupDiscovery", () => {
  const portal = { url: US, source: "portal" };
  const fallback = { url: OWN, source: "fallback" as const, reason: "registry_unavailable", decidedAtMs: 1 };

  it("portal discovery does not override an explicit COORDINATOR_URL", () => {
    expect(applyStartupDiscovery({ discovered: portal, steering: null, explicitUrl: OWN })).toBeNull();
    expect(applyStartupDiscovery({ discovered: portal, steering: fallback, explicitUrl: OWN })).toBeNull();
    expect(applyStartupDiscovery({ discovered: portal, steering: { ...fallback, source: "configured", reason: "" }, explicitUrl: OWN })).toBeNull();
  });

  it("portal discovery still applies to a default install without a registry pick", () => {
    expect(applyStartupDiscovery({ discovered: portal, steering: null, explicitUrl: null })).toEqual(portal);
    expect(applyStartupDiscovery({ discovered: portal, steering: { ...fallback, url: PLATFORM }, explicitUrl: null })).toEqual(portal);
  });

  it("a signed-registry pick wins over discovery", () => {
    expect(applyStartupDiscovery({ discovered: portal, steering: { ...fallback, source: "registry", reason: "" }, explicitUrl: null })).toBeNull();
  });
});

describe("PLATFORM_COORDINATOR_URL", () => {
  it("matches the installer default", async () => {
    const { DEFAULT_COORDINATOR_URL } = await import("../../src/install/options.js");
    const { PLATFORM_COORDINATOR_URL } = await import("../../src/discovery/steering.js");
    expect(PLATFORM_COORDINATOR_URL).toBe(DEFAULT_COORDINATOR_URL);
  });
});

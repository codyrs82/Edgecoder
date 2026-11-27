import { describe, expect, it, vi } from "vitest";
import {
  createPlatformCoordinatorPicker,
  parsePlatformCoordinators,
  regionForCountry,
  regionFromUrl,
  verifiedRegistryCoordinators,
  type PlatformCoordinator
} from "../../src/portal/platform-coordinators.js";
import type { RegistryEntry, RegistryPayload } from "../../src/discovery/registry.js";

const US = "https://coordinator.edgecoder.io";
const EU = "https://coordinator-eu.edgecoder.io";

function entry(over: Partial<RegistryEntry> & { peerId: string; urls: string[] }): RegistryEntry {
  return {
    publicKeyFingerprint: "a".repeat(64),
    region: "unknown",
    operator: { id: "edgecoder", name: "EdgeCoder", kind: "edgecoder" },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: 0,
    health: { status: "healthy", checkedAtMs: 1, latencyMs: 10 },
    ...over
  } as RegistryEntry;
}

function registry(configured: boolean, coordinators: RegistryEntry[]) {
  const payload: RegistryPayload = { v: 1, network: "edgecoder", issuedAtMs: 0, expiresAtMs: 1, coordinators, fallbackUrls: [] } as RegistryPayload;
  return { configured, snapshot: () => payload };
}

describe("platform coordinator list", () => {
  it("defaults to the US and EU seeds", () => {
    expect(parsePlatformCoordinators({})).toEqual([
      { url: US, region: "us", source: "config" },
      { url: EU, region: "eu", source: "config" }
    ]);
  });

  it("falls back to COORDINATOR_DISCOVERY_URLS, reading the region from the host", () => {
    expect(parsePlatformCoordinators({ COORDINATOR_DISCOVERY_URLS: `${US}, ${EU}/` })).toEqual([
      { url: US, region: "unknown", source: "config" },
      { url: EU, region: "eu", source: "config" }
    ]);
  });

  it("PORTAL_PLATFORM_COORDINATOR_URLS wins and takes =region", () => {
    const list = parsePlatformCoordinators({ PORTAL_PLATFORM_COORDINATOR_URLS: "https://a.example=US, https://b.example,https://a.example", COORDINATOR_DISCOVERY_URLS: US });
    expect(list).toEqual([
      { url: "https://a.example", region: "us", source: "config" },
      { url: "https://b.example", region: "unknown", source: "config" }
    ]);
  });

  it("maps countries and hostnames to regions", () => {
    expect(regionForCountry("de")).toBe("eu");
    expect(regionForCountry("GB")).toBe("eu");
    expect(regionForCountry("US")).toBe("us");
    expect(regionForCountry("ZA")).toBeNull();
    expect(regionForCountry(undefined)).toBeNull();
    expect(regionFromUrl("https://seed.us.example")).toBe("us");
    expect(regionFromUrl("https://europe.example")).toBe("unknown");
  });
});

describe("signed registry members", () => {
  const members = [
    entry({ peerId: "seed-ap", urls: ["https://ap.example/"], region: "ap" }),
    entry({ peerId: "seed-down", urls: ["https://down.example"], health: { status: "unhealthy", checkedAtMs: 1, latencyMs: null } }),
    entry({ peerId: "community-1", urls: ["https://community.example"], operator: { id: "op", name: "Op", kind: "community" } })
  ];

  it("are ignored while the registry is not configured", () => {
    expect(verifiedRegistryCoordinators(registry(false, members))).toEqual([]);
    expect(verifiedRegistryCoordinators(null)).toEqual([]);
  });

  it("only EdgeCoder-run members that passed the registry check count", () => {
    expect(verifiedRegistryCoordinators(registry(true, members))).toEqual([{ url: "https://ap.example", region: "ap", nodeId: "seed-ap", source: "registry" }]);
  });
});

describe("createPlatformCoordinatorPicker", () => {
  const coordinators: PlatformCoordinator[] = [
    { url: US, region: "us", source: "config" },
    { url: EU, region: "eu", source: "config" }
  ];

  it("prefers the agent's region, else the first healthy one", async () => {
    const pick = createPlatformCoordinatorPicker({ coordinators, probe: async () => true });
    expect((await pick({ countryCode: "FR" }))?.url).toBe(EU);
    expect((await pick({ countryCode: "US" }))?.url).toBe(US);
    expect((await pick({}))?.url).toBe(US);
    expect((await pick({ countryCode: "ZA" }))?.url).toBe(US);
  });

  it("skips unhealthy coordinators and returns null when none is healthy", async () => {
    let usUp = false;
    let now = 0;
    const pick = createPlatformCoordinatorPicker({ coordinators, probe: async (url) => (url === US ? usUp : false), now: () => now });
    expect(await pick({ countryCode: "US" })).toBeNull();
    usUp = true;
    expect(await pick({ countryCode: "US" })).toBeNull(); // unhealthy result cached 15 s
    now = 16_000;
    expect((await pick({ countryCode: "DE" }))?.url).toBe(US);
  });

  it("caches probes per URL", async () => {
    const probe = vi.fn(async () => true);
    const pick = createPlatformCoordinatorPicker({ coordinators, probe, now: () => 0 });
    await pick({});
    await pick({ countryCode: "DE" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("adds verified registry members only when the registry is configured", async () => {
    const members = [entry({ peerId: "seed-ap", urls: ["https://ap.example"], region: "ap" })];
    let reg = registry(false, members);
    const pick = createPlatformCoordinatorPicker({ coordinators: [], probe: async () => false, registry: () => reg });
    expect(await pick({})).toBeNull();
    reg = registry(true, members);
    expect(await pick({})).toEqual({ url: "https://ap.example", region: "ap", nodeId: "seed-ap", source: "registry" });
  });
});

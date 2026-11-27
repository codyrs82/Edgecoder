import Fastify from "fastify";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { registerAccountApiRoutes } from "../../src/portal/routes/account.js";
import { countryCodeForName, parseIpIntelligence } from "../../src/portal/ip-intelligence.js";
import { createPlatformCoordinatorPicker, regionForFlyRegion, regionFromRequestHeaders } from "../../src/portal/platform-coordinators.js";

/*
 * Network run 22: /nodes/discover-coordinator picks a platform coordinator by the agent's last known
 * country, but every enrolment answered "unknown" (the IP lookup's keyless answer has no country
 * code), so lhr and fra agents were sent to the US coordinator. The country is now read from either
 * answer shape (or the country's name), and without one the request's own location is used:
 * CF-IPCountry, else Fly-Region, else the caller's IP looked up.
 */

const US = "https://coordinator.edgecoder.io";
const EU = "https://coordinator-eu.edgecoder.io";
const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

function setup(opts: { lastCountryCode?: string; lookup?: (req: unknown) => Promise<string | undefined> } = {}) {
  const token = "reg-token-run22";
  const enrollment = { nodeId: "agent-run22", nodeKind: "agent", registrationTokenHash: sha256Hex(token), ...(opts.lastCountryCode ? { lastCountryCode: opts.lastCountryCode } : {}) };
  const store = { getNodeEnrollmentByRegistrationTokenHash: async (h: string) => (h === enrollment.registrationTokenHash ? enrollment : null) };
  // The real picker over the default US and EU seeds, both healthy.
  const pickPlatformCoordinator = createPlatformCoordinatorPicker({
    coordinators: [{ url: US, region: "us", source: "config" }, { url: EU, region: "eu", source: "config" }],
    probe: async () => true,
  });
  const lookupCallerCountry = opts.lookup ? vi.fn(opts.lookup) : undefined;
  const app = Fastify();
  registerAccountApiRoutes(app, { pickPlatformCoordinator, store, sha256Hex, lookupCallerCountry } as never);
  const discover = (headers: Record<string, string> = {}) => app.inject({ url: "/nodes/discover-coordinator", headers: { authorization: `Bearer ${token}`, ...headers } });
  return { discover, lookupCallerCountry };
}

describe("discover-coordinator region (network run 22)", () => {
  it("an lhr or fra agent with no known country gets the EU coordinator from Fly-Region", async () => {
    const { discover } = setup();
    for (const region of ["lhr", "fra"]) {
      const res = await discover({ "fly-region": region });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ coordinatorUrl: EU, region: "eu" });
    }
    expect((await discover({ "fly-region": "iad" })).json()).toMatchObject({ coordinatorUrl: US, region: "us" });
  });

  it("CF-IPCountry comes before Fly-Region", async () => {
    const { discover } = setup();
    expect((await discover({ "cf-ipcountry": "DE", "fly-region": "iad" })).json()).toMatchObject({ coordinatorUrl: EU });
    expect((await discover({ "cf-ipcountry": "US", "fly-region": "lhr" })).json()).toMatchObject({ coordinatorUrl: US });
    // Cloudflare's unknown / Tor codes do not count: Fly-Region decides.
    expect((await discover({ "cf-ipcountry": "XX", "fly-region": "fra" })).json()).toMatchObject({ coordinatorUrl: EU });
  });

  it("the agent's known country still comes first", async () => {
    const { discover } = setup({ lastCountryCode: "US" });
    expect((await discover({ "fly-region": "lhr" })).json()).toMatchObject({ coordinatorUrl: US });
    const eu = setup({ lastCountryCode: "GB" });
    expect((await eu.discover({ "fly-region": "iad" })).json()).toMatchObject({ coordinatorUrl: EU });
  });

  it("without headers, the caller's IP is looked up", async () => {
    const { discover, lookupCallerCountry } = setup({ lookup: async () => "FR" });
    expect((await discover()).json()).toMatchObject({ coordinatorUrl: EU });
    expect(lookupCallerCountry).toHaveBeenCalledTimes(1);
    // Not looked up when a header already places it.
    await discover({ "fly-region": "iad" });
    expect(lookupCallerCountry).toHaveBeenCalledTimes(1);
  });

  it("nothing known: the first healthy coordinator in order", async () => {
    const { discover } = setup({ lookup: async () => undefined });
    expect((await discover()).json()).toMatchObject({ coordinatorUrl: US });
  });
});

describe("region helpers", () => {
  it("maps Fly edge regions and request headers", () => {
    expect(regionForFlyRegion("LHR")).toBe("eu");
    expect(regionForFlyRegion("ord")).toBe("us");
    expect(regionForFlyRegion("syd")).toBeNull();
    expect(regionForFlyRegion(undefined)).toBeNull();
    expect(regionFromRequestHeaders({ "fly-region": "fra" })).toEqual({ region: "eu", from: "fly-region" });
    expect(regionFromRequestHeaders({ "cf-ipcountry": "gb" })).toEqual({ region: "eu", from: "cf-ipcountry" });
    expect(regionFromRequestHeaders({})).toBeNull();
  });
});

describe("IP lookup answer (why lastCountryCode stayed empty)", () => {
  it("reads the keyless answer's country name", () => {
    expect(parseIpIntelligence({ ip: "81.2.69.142", country: "United Kingdom", city: "Bracknell" })).toEqual({ countryCode: "GB" });
    expect(parseIpIntelligence({ ip: "8.8.8.8", country: "United States" })).toEqual({ countryCode: "US" });
    expect(parseIpIntelligence({ country: "Germany" })).toEqual({ countryCode: "DE" });
  });

  it("reads the code from the top level or location, with the VPN flag", () => {
    expect(parseIpIntelligence({ country_code: "fr", is_vpn: false, is_proxy: false })).toEqual({ countryCode: "FR", vpnDetected: false });
    expect(parseIpIntelligence({ location: { country_code: "NL", country: "Netherlands" }, is_vpn: true })).toEqual({ countryCode: "NL", vpnDetected: true });
  });

  it("gives nothing for an unknown or empty answer", () => {
    expect(parseIpIntelligence(null)).toEqual({});
    expect(parseIpIntelligence({ country: "Atlantis" })).toEqual({});
    expect(countryCodeForName("")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { discoveryDomainsFromEnv, discoveryHostname, parseDiscoveryTxt, resolveDnsSeeds, srvToUrl, type DnsResolver } from "../../src/discovery/dns.js";

describe("DNS TXT parsing", () => {
  it("parses the ec1 record format", () => {
    const seed = parseDiscoveryTxt("v=ec1 url=https://coord-ord.edgecoder.io region=ord peer=coord-abc123");
    expect(seed).toEqual({ url: "https://coord-ord.edgecoder.io", region: "ord", peerId: "coord-abc123" });
  });

  it("tolerates extra whitespace, quotes, unknown keys and a trailing slash", () => {
    const seed = parseDiscoveryTxt('  v=ec1   url="https://a.example/"  foo=bar region=fra fp=' + "ab".repeat(32));
    expect(seed?.url).toBe("https://a.example");
    expect(seed?.region).toBe("fra");
    expect(seed?.publicKeyFingerprint).toBe("ab".repeat(32));
  });

  it("rejects records without v=ec1 or a usable url", () => {
    expect(parseDiscoveryTxt("url=https://a.example")).toBeNull();
    expect(parseDiscoveryTxt("v=ec2 url=https://a.example")).toBeNull();
    expect(parseDiscoveryTxt("v=ec1 url=ftp://a.example")).toBeNull();
    expect(parseDiscoveryTxt("v=ec1")).toBeNull();
    expect(parseDiscoveryTxt("")).toBeNull();
  });

  it("builds the service hostname and SRV urls", () => {
    expect(discoveryHostname("edgecoder.io")).toBe("_edgecoder._tcp.edgecoder.io");
    expect(discoveryHostname("_edgecoder._tcp.edgecoder.io.")).toBe("_edgecoder._tcp.edgecoder.io");
    expect(srvToUrl({ name: "c1.example.", port: 443, priority: 0, weight: 0 })).toBe("https://c1.example");
    expect(srvToUrl({ name: "c1.example", port: 8443, priority: 0, weight: 0 })).toBe("https://c1.example:8443");
    expect(srvToUrl({ name: "c1.example", port: 80, priority: 0, weight: 0 })).toBe("http://c1.example");
  });

  it("reads domains from the environment", () => {
    expect(discoveryDomainsFromEnv({})).toEqual(["edgecoder.io"]);
    expect(discoveryDomainsFromEnv({ EDGECODER_DISCOVERY_DOMAIN: " a.io, b.io " })).toEqual(["a.io", "b.io"]);
  });
});

describe("resolveDnsSeeds", () => {
  it("joins TXT chunks and returns one candidate per record", async () => {
    const resolver: DnsResolver = {
      resolveTxt: async (host) => {
        expect(host).toBe("_edgecoder._tcp.example.org");
        return [
          ["v=ec1 url=https://one.example ", "region=ord peer=p1"],
          ["v=ec1 url=https://two.example region=fra"],
          ["garbage"]
        ];
      },
      resolveSrv: async () => {
        throw new Error("should not be called");
      }
    };
    const seeds = await resolveDnsSeeds({ domain: "example.org", resolver });
    expect(seeds).toEqual([
      { url: "https://one.example", peerId: "p1", region: "ord", source: "dns" },
      { url: "https://two.example", peerId: undefined, region: "fra", source: "dns" }
    ]);
  });

  it("falls back to SRV ordered by priority then weight when TXT yields nothing", async () => {
    const resolver: DnsResolver = {
      resolveTxt: async () => {
        throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      },
      resolveSrv: async () => [
        { name: "b.example", port: 443, priority: 10, weight: 5 },
        { name: "a.example", port: 443, priority: 0, weight: 1 },
        { name: "c.example", port: 8443, priority: 10, weight: 50 }
      ]
    };
    const seeds = await resolveDnsSeeds({ domain: "example.org", resolver });
    expect(seeds.map((s) => s.url)).toEqual(["https://a.example", "https://c.example:8443", "https://b.example"]);
  });

  it("times out slow lookups and merges several domains without duplicates", async () => {
    const resolver: DnsResolver = {
      resolveTxt: async (host) => {
        if (host.endsWith("slow.io")) return new Promise(() => {});
        return [["v=ec1 url=https://dup.example"]];
      },
      resolveSrv: async () => []
    };
    const seeds = await resolveDnsSeeds({ domain: ["slow.io", "a.io", "b.io"], resolver, timeoutMs: 20 });
    expect(seeds).toEqual([{ url: "https://dup.example", peerId: undefined, region: undefined, source: "dns" }]);
  });
});

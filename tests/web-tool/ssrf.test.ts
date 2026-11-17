import { describe, expect, it, vi } from "vitest";
import { BlockedUrlError, blockedAddressReason, checkUrlShape, pinnedLookup, resolvePublic } from "../../src/web-tool/ssrf.js";

describe("read_page SSRF guard: blocked addresses", () => {
  const blocked: Array<[string, RegExp]> = [
    ["127.0.0.1", /loopback/],
    ["127.255.0.9", /loopback/],
    ["10.0.0.1", /10\.0\.0\.0\/8/],
    ["10.255.255.255", /10\.0\.0\.0\/8/],
    ["172.16.0.1", /172\.16/],
    ["172.31.255.254", /172\.16/],
    ["192.168.1.1", /192\.168/],
    ["169.254.169.254", /metadata/],
    ["169.254.1.1", /link-local/],
    ["0.0.0.0", /unspecified/],
    ["100.64.0.1", /carrier-grade/],
    ["224.0.0.1", /multicast/],
    ["255.255.255.255", /reserved/],
    ["::1", /loopback/],
    ["::", /unspecified/],
    ["fdaa:0:1::3", /Fly private network/],
    ["fd00::1", /unique local/],
    ["fc00::1", /unique local/],
    ["fe80::1", /link-local/],
    ["ff02::1", /multicast/],
    ["::ffff:127.0.0.1", /IPv4 inside IPv6: loopback/],
    ["::ffff:169.254.169.254", /metadata/],
    ["::ffff:a9fe:a9fe", /metadata/],
    ["64:ff9b::10.0.0.1", /NAT64/],
    ["2002:0a00:0001::", /6to4/],
  ];
  for (const [ip, why] of blocked) {
    it(`refuses ${ip}`, () => {
      expect(blockedAddressReason(ip)).toMatch(why);
    });
  }

  it("lets public addresses through", () => {
    for (const ip of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "172.15.0.1", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
      expect(blockedAddressReason(ip), ip).toBeNull();
    }
  });
});

describe("read_page SSRF guard: URL shape", () => {
  const refuse = (u: string, msg: RegExp) => expect(() => checkUrlShape(u)).toThrow(msg);
  it("allows http and https on ports 80 and 443 only, without credentials", () => {
    expect(checkUrlShape("https://example.com/a?b=1").hostname).toBe("example.com");
    expect(checkUrlShape("http://example.com:80/").hostname).toBe("example.com");
    expect(checkUrlShape("https://example.com:443/").hostname).toBe("example.com");
    refuse("ftp://example.com/", /http and https/);
    refuse("file:///etc/passwd", /http and https/);
    refuse("gopher://example.com/", /http and https/);
    refuse("https://example.com:8443/", /port 80 or 443/);
    refuse("http://example.com:22/", /port 80 or 443/);
    refuse("https://user:pw@example.com/", /user name or password/);
    refuse("not a url", /valid URL/);
  });
  it("refuses literal private addresses and local names before any lookup", () => {
    refuse("http://169.254.169.254/latest/meta-data/", /metadata/);
    refuse("http://[::1]/", /loopback/);
    refuse("http://[fdaa::2]/", /Fly private/);
    refuse("http://10.1.2.3/", /10\.0\.0\.0/);
    refuse("http://localhost/", /local host names/);
    refuse("http://api.internal/", /local host names/);
    refuse("http://printer.local/", /local host names/);
    refuse("http://intranet/", /local host names/);
  });
});

describe("read_page SSRF guard: DNS", () => {
  it("refuses a host when any answer is private (a mixed answer is how rebinding starts)", async () => {
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    await expect(resolvePublic(new URL("https://mixed.example/"), resolve)).rejects.toThrow(BlockedUrlError);
  });
  it("returns the first public address to pin, resolving once", async () => {
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    expect(await resolvePublic(new URL("https://example.com/"), resolve)).toEqual({ address: "93.184.216.34", family: 4 });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("the pinned lookup answers the checked address whatever the host or options", () => {
    const lookup = pinnedLookup("93.184.216.34", 4);
    const one = vi.fn();
    lookup("rebind.example", {}, one);
    expect(one).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    const all = vi.fn();
    lookup("anything-else.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });
});

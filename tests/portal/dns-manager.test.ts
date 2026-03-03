import { describe, it, expect } from "vitest";
import { isPublicIp, sanitizeNodeIdForDns } from "../../src/portal/dns-manager.js";

// ---------------------------------------------------------------------------
// isPublicIp
// ---------------------------------------------------------------------------
describe("isPublicIp", () => {
  it("rejects RFC 1918 10.x.x.x", () => {
    expect(isPublicIp("10.0.0.1")).toBe(false);
    expect(isPublicIp("10.255.255.255")).toBe(false);
  });

  it("rejects RFC 1918 172.16-31.x.x", () => {
    expect(isPublicIp("172.16.0.1")).toBe(false);
    expect(isPublicIp("172.31.255.255")).toBe(false);
  });

  it("accepts 172.15.x.x (not private)", () => {
    expect(isPublicIp("172.15.0.1")).toBe(true);
  });

  it("accepts 172.32.x.x (not private)", () => {
    expect(isPublicIp("172.32.0.1")).toBe(true);
  });

  it("rejects RFC 1918 192.168.x.x", () => {
    expect(isPublicIp("192.168.1.1")).toBe(false);
    expect(isPublicIp("192.168.0.0")).toBe(false);
    expect(isPublicIp("192.168.255.255")).toBe(false);
  });

  it("rejects loopback 127.x.x.x", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("127.255.255.255")).toBe(false);
  });

  it("rejects link-local 169.254.x.x", () => {
    expect(isPublicIp("169.254.1.1")).toBe(false);
    expect(isPublicIp("169.254.0.0")).toBe(false);
    expect(isPublicIp("169.254.255.255")).toBe(false);
  });

  it("rejects CGNAT 100.64-127.x.x", () => {
    expect(isPublicIp("100.64.0.1")).toBe(false);
    expect(isPublicIp("100.127.255.255")).toBe(false);
    expect(isPublicIp("100.100.0.1")).toBe(false);
  });

  it("accepts 100.63.x.x (not CGNAT)", () => {
    expect(isPublicIp("100.63.0.1")).toBe(true);
  });

  it("accepts 100.128.x.x (not CGNAT)", () => {
    expect(isPublicIp("100.128.0.1")).toBe(true);
  });

  it("accepts valid public IPv4", () => {
    expect(isPublicIp("66.241.124.176")).toBe(true);
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("203.0.113.1")).toBe(true);
    expect(isPublicIp("1.1.1.1")).toBe(true);
  });

  it("rejects IPv6 loopback", () => {
    expect(isPublicIp("::1")).toBe(false);
  });

  it("rejects IPv6 link-local fe80::", () => {
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("fe80::abcd:1234")).toBe(false);
  });

  it("rejects IPv6 ULA fc00::/7", () => {
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("fd00::1")).toBe(false);
    expect(isPublicIp("fdab::1")).toBe(false);
  });

  it("accepts valid public IPv6", () => {
    expect(isPublicIp("2a09:8280:1::d4:ebea:0")).toBe(true);
    expect(isPublicIp("2001:4860:4860::8888")).toBe(true);
    expect(isPublicIp("2607:f8b0:4004:800::200e")).toBe(true);
  });

  it("rejects empty/garbage input", () => {
    expect(isPublicIp("")).toBe(false);
    expect(isPublicIp("not-an-ip")).toBe(false);
    expect(isPublicIp("   ")).toBe(false);
    expect(isPublicIp("abc.def.ghi.jkl")).toBe(false);
    expect(isPublicIp("999.999.999.999")).toBe(false);
    expect(isPublicIp("1.2.3")).toBe(false);
    expect(isPublicIp("1.2.3.4.5")).toBe(false);
  });

  it("rejects IPv4 with leading zeros", () => {
    expect(isPublicIp("08.08.08.08")).toBe(false);
    expect(isPublicIp("010.0.0.1")).toBe(false);
  });

  it("rejects negative octets", () => {
    expect(isPublicIp("1.2.3.-1")).toBe(false);
  });

  it("handles whitespace-padded IPs", () => {
    expect(isPublicIp("  8.8.8.8  ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeNodeIdForDns
// ---------------------------------------------------------------------------
describe("sanitizeNodeIdForDns", () => {
  it("lowercases", () => {
    expect(sanitizeNodeIdForDns("MyNode-01")).toBe("mynode-01");
  });

  it("replaces non-alphanumeric (except hyphen) with hyphen", () => {
    expect(sanitizeNodeIdForDns("my_node.test")).toBe("my-node-test");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeNodeIdForDns("my--node---01")).toBe("my-node-01");
  });

  it("strips leading/trailing hyphens", () => {
    expect(sanitizeNodeIdForDns("-my-node-")).toBe("my-node");
  });

  it("truncates to 63 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeNodeIdForDns(long).length).toBeLessThanOrEqual(63);
  });

  it("returns fallback for empty result", () => {
    expect(sanitizeNodeIdForDns("---")).toBe("node");
    expect(sanitizeNodeIdForDns("")).toBe("node");
    expect(sanitizeNodeIdForDns("___")).toBe("node");
  });

  it("handles mixed special characters", () => {
    expect(sanitizeNodeIdForDns("my@node#01!")).toBe("my-node-01");
  });

  it("handles already-valid DNS labels", () => {
    expect(sanitizeNodeIdForDns("my-node-01")).toBe("my-node-01");
  });

  it("preserves digits", () => {
    expect(sanitizeNodeIdForDns("node123")).toBe("node123");
  });

  it("handles single character", () => {
    expect(sanitizeNodeIdForDns("a")).toBe("a");
  });

  it("strips trailing hyphens after truncation", () => {
    const input = "a".repeat(62) + "-b";
    const result = sanitizeNodeIdForDns(input);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result.endsWith("-")).toBe(false);
  });
});

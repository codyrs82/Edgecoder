import { describe, expect, test } from "vitest";
import {
  safeTokenEqual,
  normalizeIpCandidate,
  readHeaderValue,
  extractClientIp,
  clientIpTrustFromEnv,
  isLoopbackAddress,
  isLoopbackSocket,
  socketRemoteAddress,
  normalizeUrl,
  pairKey,
  weightedMedian,
  parseRecordPayload,
  computeIntentFee,
} from "../../src/swarm/coordinator-utils.js";

describe("safeTokenEqual", () => {
  test("equal strings return true", () => {
    expect(safeTokenEqual("abc123", "abc123")).toBe(true);
  });

  test("different strings of same length return false", () => {
    expect(safeTokenEqual("abc123", "xyz789")).toBe(false);
  });

  test("different lengths return false", () => {
    expect(safeTokenEqual("short", "muchlonger")).toBe(false);
  });

  test("empty strings return true", () => {
    expect(safeTokenEqual("", "")).toBe(true);
  });
});

describe("normalizeIpCandidate", () => {
  test("strips ::ffff: prefix from IPv4-mapped address", () => {
    expect(normalizeIpCandidate("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });

  test("strips brackets from bracketed IPv6", () => {
    expect(normalizeIpCandidate("[::1]")).toBe("::1");
  });

  test("strips port from IPv4 address with port", () => {
    expect(normalizeIpCandidate("1.2.3.4:8080")).toBe("1.2.3.4");
  });

  test("plain IPv4 returned unchanged", () => {
    expect(normalizeIpCandidate("192.168.1.1")).toBe("192.168.1.1");
  });

  test("plain IPv6 returned unchanged", () => {
    expect(normalizeIpCandidate("fe80::1")).toBe("fe80::1");
  });

  test("\"unknown\" returns undefined", () => {
    expect(normalizeIpCandidate("unknown")).toBeUndefined();
  });

  test("empty string returns undefined", () => {
    expect(normalizeIpCandidate("")).toBeUndefined();
  });
});

describe("readHeaderValue", () => {
  test("string value returned as-is", () => {
    expect(readHeaderValue({ "x-test": "hello" }, "x-test")).toBe("hello");
  });

  test("array picks first string element", () => {
    expect(readHeaderValue({ "x-test": ["first", "second"] }, "x-test")).toBe("first");
  });

  test("returns undefined for non-string non-array value", () => {
    expect(readHeaderValue({ "x-test": 42 }, "x-test")).toBeUndefined();
  });

  test("returns undefined for missing key", () => {
    expect(readHeaderValue({}, "x-missing")).toBeUndefined();
  });
});

describe("extractClientIp", () => {
  const spoofed = {
    "fly-client-ip": "10.0.0.1",
    "cf-connecting-ip": "10.0.0.2",
    "x-real-ip": "10.0.0.4",
    "x-forwarded-for": "10.0.0.3",
  };

  test("by default ignores every forwarded header and uses the socket address", () => {
    expect(extractClientIp(spoofed, "198.51.100.7")).toBe("198.51.100.7");
    expect(extractClientIp({ "x-real-ip": "127.0.0.1" }, "::ffff:198.51.100.7")).toBe("198.51.100.7");
  });

  test("on Fly only Fly-Client-IP is read", () => {
    const trust = { trustedProxies: [], onFly: true };
    expect(extractClientIp(spoofed, "172.19.0.1", trust)).toBe("10.0.0.1");
    const { "fly-client-ip": _fly, ...rest } = spoofed;
    expect(extractClientIp(rest, "172.19.0.1", trust)).toBe("172.19.0.1");
  });

  test("forwarded headers are read only when the socket is a configured proxy", () => {
    const trust = { trustedProxies: ["10.1.1.1"], onFly: false };
    expect(extractClientIp({ "x-real-ip": "203.0.113.5" }, "10.1.1.1", trust)).toBe("203.0.113.5");
    expect(extractClientIp({ "x-real-ip": "203.0.113.5" }, "10.9.9.9", trust)).toBe("10.9.9.9");
    expect(extractClientIp({ "fly-client-ip": "203.0.113.5" }, "10.1.1.1", trust)).toBe("10.1.1.1");
  });

  test("x-forwarded-for from a trusted proxy is read right to left", () => {
    const trust = { trustedProxies: ["10.1.1.1", "10.1.1.2"], onFly: false };
    expect(extractClientIp({ "x-forwarded-for": "127.0.0.1, 203.0.113.50, 10.1.1.2" }, "10.1.1.1", trust)).toBe("203.0.113.50");
  });

  test("returns undefined when nothing provided", () => {
    expect(extractClientIp({})).toBeUndefined();
  });
});

describe("loopback detection", () => {
  test("isLoopbackAddress", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("203.0.113.9")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  test("isLoopbackSocket is false for a configured proxy on this host", () => {
    expect(isLoopbackSocket("127.0.0.1")).toBe(true);
    expect(isLoopbackSocket("127.0.0.1", { trustedProxies: ["127.0.0.1"], onFly: false })).toBe(false);
  });

  test("socketRemoteAddress reads the socket, never headers", () => {
    expect(socketRemoteAddress({ socket: { remoteAddress: "::ffff:203.0.113.9" } })).toBe("203.0.113.9");
    expect(socketRemoteAddress({ raw: { socket: { remoteAddress: "127.0.0.1" } } })).toBe("127.0.0.1");
    expect(socketRemoteAddress({ headers: { "x-real-ip": "127.0.0.1" } } as any)).toBeUndefined();
  });

  test("clientIpTrustFromEnv", () => {
    expect(clientIpTrustFromEnv({})).toEqual({ trustedProxies: [], onFly: false });
    expect(clientIpTrustFromEnv({ COORDINATOR_TRUST_PROXY: " 10.0.0.1, ::ffff:10.0.0.2 ,", FLY_APP_NAME: "seed" })).toEqual({
      trustedProxies: ["10.0.0.1", "10.0.0.2"],
      onFly: true,
    });
  });
});

describe("normalizeUrl", () => {
  test("valid URL strips path and query", () => {
    expect(normalizeUrl("https://example.com/foo?bar=1")).toBe("https://example.com");
  });

  test("invalid string returns null", () => {
    expect(normalizeUrl("not-a-url")).toBeNull();
  });

  test("trailing slash removed", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  });

  test("undefined returns null", () => {
    expect(normalizeUrl(undefined)).toBeNull();
  });
});

describe("pairKey", () => {
  test("order invariant", () => {
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
  });

  test("produces expected format", () => {
    expect(pairKey("a", "b")).toBe("a::b");
  });
});

describe("weightedMedian", () => {
  test("single entry returns that value", () => {
    expect(weightedMedian([{ value: 42, weight: 1 }])).toBe(42);
  });

  test("equal weights returns middle value", () => {
    const result = weightedMedian([
      { value: 10, weight: 1 },
      { value: 20, weight: 1 },
      { value: 30, weight: 1 },
    ]);
    expect(result).toBe(20);
  });

  test("skewed weights returns weighted median", () => {
    const result = weightedMedian([
      { value: 10, weight: 1 },
      { value: 50, weight: 100 },
    ]);
    expect(result).toBe(50);
  });

  test("empty array returns 0", () => {
    expect(weightedMedian([])).toBe(0);
  });
});

describe("parseRecordPayload", () => {
  test("valid JSON parsed", () => {
    const result = parseRecordPayload({ payloadJson: '{"key":"value"}' });
    expect(result).toEqual({ key: "value" });
  });

  test("invalid JSON returns empty object", () => {
    expect(parseRecordPayload({ payloadJson: "{broken" })).toEqual({});
  });

  test("undefined payloadJson returns empty object", () => {
    expect(parseRecordPayload({})).toEqual({});
  });
});

describe("computeIntentFee", () => {
  test("zero amount yields zero fee and net", () => {
    expect(computeIntentFee(0, 150)).toEqual({ feeSats: 0, netSats: 0 });
  });

  test("100% BPS takes entire amount", () => {
    expect(computeIntentFee(500, 10000)).toEqual({ feeSats: 500, netSats: 0 });
  });

  test("normal case: 1000 sats at 150 BPS", () => {
    expect(computeIntentFee(1000, 150)).toEqual({ feeSats: 15, netSats: 985 });
  });

  test("rounding uses Math.floor for non-divisible amounts", () => {
    // 999 * 150 / 10000 = 14.985 → floor → 14
    const result = computeIntentFee(999, 150);
    expect(result.feeSats).toBe(14);
    expect(result.netSats).toBe(985);
  });
});

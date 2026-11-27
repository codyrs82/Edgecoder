import { describe, expect, test } from "vitest";
import { adminOriginDecision, adminOriginPolicyFromEnv, allowedCidrsProblem } from "../../src/common/admin-origin.js";

const onFly = adminOriginPolicyFromEnv({ FLY_APP_NAME: "edgecoder-seed" });
const offFly = adminOriginPolicyFromEnv({});

describe("admin origin: decided by the socket, headers can only refuse", () => {
  test("loopback is internal, on and off Fly (IPv4, IPv6, mapped)", () => {
    for (const p of [onFly, offFly]) {
      expect(adminOriginDecision("127.0.0.1", {}, p)).toEqual({ ok: true, via: "loopback" });
      expect(adminOriginDecision("::1", {}, p).ok).toBe(true);
      expect(adminOriginDecision("::ffff:127.0.0.1", {}, p).ok).toBe(true);
    }
  });

  test("on Fly: the private network (6PN, fdaa::/16) is internal; the edge proxy's range and the internet are not", () => {
    expect(adminOriginDecision("fdaa:0:1234:a7b:1f:5ab2:1d71:2", {}, onFly)).toEqual({ ok: true, via: "private_network" });
    expect(adminOriginDecision("172.16.3.2", {}, onFly)).toEqual({ ok: false, reason: "not_internal" });
    expect(adminOriginDecision("10.0.0.5", {}, onFly).ok).toBe(false);
    expect(adminOriginDecision("203.0.113.9", {}, onFly).ok).toBe(false);
    expect(adminOriginDecision("2001:db8::1", {}, onFly).ok).toBe(false);
  });

  test("off Fly: private LAN ranges are internal, public addresses are not", () => {
    expect(adminOriginDecision("10.1.2.3", {}, offFly).ok).toBe(true);
    expect(adminOriginDecision("192.168.1.10", {}, offFly).ok).toBe(true);
    expect(adminOriginDecision("fd12::1", {}, offFly).ok).toBe(true);
    expect(adminOriginDecision("198.51.100.4", {}, offFly)).toEqual({ ok: false, reason: "not_internal" });
  });

  test("Fly's public-edge headers refuse even from an internal socket", () => {
    expect(adminOriginDecision("127.0.0.1", { "fly-client-ip": "198.51.100.4" }, onFly)).toEqual({ ok: false, reason: "public_ingress" });
    expect(adminOriginDecision("fdaa::2", { "fly-forwarded-port": "443" }, onFly)).toEqual({ ok: false, reason: "public_ingress" });
  });

  test("spoofed forwarding headers never make a public socket internal", () => {
    const h = { "x-forwarded-for": "127.0.0.1", "x-real-ip": "fdaa::1", "cf-connecting-ip": "10.0.0.1" };
    expect(adminOriginDecision("203.0.113.9", h, onFly).ok).toBe(false);
    expect(adminOriginDecision("203.0.113.9", h, offFly).ok).toBe(false);
    expect(adminOriginDecision(undefined, h, offFly)).toEqual({ ok: false, reason: "no_socket_address" });
  });

  test("an internal socket carrying proxy headers relays someone else and is refused", () => {
    for (const h of [{ "x-forwarded-for": "198.51.100.4" }, { forwarded: "for=198.51.100.4" }, { "x-real-ip": "198.51.100.4" }, { via: "1.1 Caddy" }]) {
      expect(adminOriginDecision("127.0.0.1", h, offFly)).toEqual({ ok: false, reason: "via_proxy" });
      expect(adminOriginDecision("10.1.2.3", h, offFly)).toEqual({ ok: false, reason: "via_proxy" });
    }
    // A public socket stays "not_internal" whatever it sends.
    expect(adminOriginDecision("203.0.113.9", { via: "1.1 x" }, offFly)).toEqual({ ok: false, reason: "not_internal" });
  });

  test("a configured reverse proxy is the outside world, even on loopback", () => {
    const p = adminOriginPolicyFromEnv({ COORDINATOR_TRUST_PROXY: "127.0.0.1" });
    expect(adminOriginDecision("127.0.0.1", {}, p)).toEqual({ ok: false, reason: "via_proxy" });
  });

  test("ADMIN_ALLOWED_CIDRS adds ranges; bad values are reported", () => {
    const p = adminOriginPolicyFromEnv({ FLY_APP_NAME: "x", ADMIN_ALLOWED_CIDRS: "198.51.100.0/24, 2001:db8::/32" });
    expect(adminOriginDecision("198.51.100.77", {}, p)).toEqual({ ok: true, via: "allowlist" });
    expect(adminOriginDecision("2001:db8::5", {}, p).ok).toBe(true);
    expect(adminOriginDecision("198.51.101.1", {}, p).ok).toBe(false);
    expect(allowedCidrsProblem("10.0.0.0/8,fdaa::/16")).toBeNull();
    expect(allowedCidrsProblem("10.0.0.0/33")).toMatch(/invalid CIDR/);
    expect(allowedCidrsProblem("not-an-ip")).toMatch(/invalid CIDR/);
  });
});

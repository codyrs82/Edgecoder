import { describe, expect, test } from "vitest";
import { coordinatorUrlAllowed, coordinatorUrlPolicyFromEnv, filterCoordinatorUrls, isPrivateHost } from "../../src/portal/coordinator-url-policy.js";

// The portal attaches its service token only to coordinator URLs that pass this policy.

const DISCOVERY = ["https://coordinator.edgecoder.io", "https://coordinator-eu.edgecoder.io"];
const prod = coordinatorUrlPolicyFromEnv({ NODE_ENV: "production" }, DISCOVERY);

describe("coordinator URL policy (production)", () => {
  test("allowlisted https coordinators pass", () => {
    expect(coordinatorUrlAllowed("https://coordinator.edgecoder.io", prod)).toBe(true);
    expect(coordinatorUrlAllowed("https://coordinator-eu.edgecoder.io/", prod)).toBe(true);
  });

  test.each([
    ["a host that is not allowlisted", "https://attacker.example"],
    ["plain http", "http://coordinator.edgecoder.io"],
    ["userinfo", "https://user:pass@coordinator.edgecoder.io"],
    ["loopback", "https://127.0.0.1:4301"],
    ["private IPv4", "https://10.0.0.5"],
    ["link-local metadata", "https://169.254.169.254"],
    ["IPv6 loopback", "https://[::1]"],
    ["IPv4-mapped private", "https://[::ffff:192.168.1.1]"],
    ["localhost", "https://localhost"],
    ["internal name", "https://edgecoder-seed.internal"],
    ["not a URL", "coordinator.edgecoder.io"]
  ])("refuses %s", (_name, url) => {
    expect(coordinatorUrlAllowed(url, prod)).toBe(false);
  });

  test("a private address stays refused even if an operator allowlists it", () => {
    const policy = coordinatorUrlPolicyFromEnv({ NODE_ENV: "production", PORTAL_COORDINATOR_HOSTS: "10.0.0.5,https://seed.example.net" }, DISCOVERY);
    expect(coordinatorUrlAllowed("https://10.0.0.5", policy)).toBe(false);
    expect(coordinatorUrlAllowed("https://seed.example.net", policy)).toBe(true);
    // PORTAL_COORDINATOR_HOSTS replaces the discovery-derived default.
    expect(coordinatorUrlAllowed("https://coordinator.edgecoder.io", policy)).toBe(false);
  });

  test("filter keeps only allowed URLs, so a discovered attacker URL never gets the token", () => {
    expect(filterCoordinatorUrls(["https://attacker.example", "https://coordinator.edgecoder.io", "http://10.0.0.1"], prod)).toEqual(["https://coordinator.edgecoder.io"]);
  });
});

describe("coordinator URL policy (development)", () => {
  test("outside production with no host list, local URLs work", () => {
    const dev = coordinatorUrlPolicyFromEnv({ NODE_ENV: "development" }, DISCOVERY);
    expect(dev.strict).toBe(false);
    expect(coordinatorUrlAllowed("http://127.0.0.1:4301", dev)).toBe(true);
  });

  test("setting PORTAL_COORDINATOR_HOSTS turns the policy on anywhere", () => {
    const dev = coordinatorUrlPolicyFromEnv({ NODE_ENV: "development", PORTAL_COORDINATOR_HOSTS: "seed.example.net" }, DISCOVERY);
    expect(dev.strict).toBe(true);
    expect(coordinatorUrlAllowed("https://attacker.example", dev)).toBe(false);
  });
});

test("isPrivateHost", () => {
  expect(isPrivateHost("172.16.0.1")).toBe(true);
  expect(isPrivateHost("172.32.0.1")).toBe(false);
  expect(isPrivateHost("100.64.0.1")).toBe(true);
  expect(isPrivateHost("fd00::1")).toBe(true);
  expect(isPrivateHost("fe80::1")).toBe(true);
  expect(isPrivateHost("8.8.8.8")).toBe(false);
  expect(isPrivateHost("coordinator.edgecoder.io")).toBe(false);
});

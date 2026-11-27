import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { portalCoordinatorHeaders, serviceTokenHostPolicy } from "../../src/portal/coordinator-request.js";
import { coordinatorUrlPolicyFromEnv } from "../../src/portal/coordinator-url-policy.js";
import { outsideMemberHosts, registryFanoutUrls } from "../../src/portal/registry-coordinators.js";
import { verifyPortalRequest } from "../../src/security/service-request-signing.js";
import { portalRequestAudiences } from "../../src/swarm/coordinator/portal-credentials.js";
import type { RegistryEntry } from "../../src/discovery/registry.js";

/*
 * The portal's calls to coordinators: signed for the coordinator called, the service token only to
 * the static seeds, never to an outside registry member, and the registry-driven fan-out list behind
 * PORTAL_REGISTRY_COORDINATORS (off by default).
 */

const portal = generateKeyPairSync("ed25519");
const SEEDS = "https://coordinator.edgecoder.io,https://coordinator-eu.edgecoder.io";
const policy = coordinatorUrlPolicyFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv, SEEDS.split(","));

function entry(over: Partial<RegistryEntry> & { peerId: string; urls: string[] }): RegistryEntry {
  return {
    publicKeyFingerprint: "a".repeat(64),
    region: "eu",
    operator: { id: "op", name: "Op", kind: "community" },
    admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
    admittedAtMs: 1,
    health: { status: "healthy", checkedAtMs: 1, latencyMs: 20 },
    status: "active",
    ...over
  } as RegistryEntry;
}

describe("portal -> coordinator headers", () => {
  const members = [{ operatorKind: "community", urls: ["https://coord.outside.example"] }, { operatorKind: "edgecoder", urls: ["https://coordinator.edgecoder.io"] }];
  const tokenAllowed = serviceTokenHostPolicy(policy, () => outsideMemberHosts(members));
  const cfg = { signingKey: () => portal.privateKey, tokenAllowed };

  it("sends the service token to the seeds, signed for that seed", async () => {
    const body = JSON.stringify({ accountId: "acct-u1" });
    const h = portalCoordinatorHeaders("POST", "https://coordinator.edgecoder.io/account/summary", { "x-portal-service-token": "svc", "x-edgecoder-account": "acct-u1", "content-type": "application/json" }, body, cfg);
    expect(h["x-portal-service-token"]).toBe("svc");
    const seed = { keys: [portal.publicKey], audiences: portalRequestAudiences("https://coordinator.edgecoder.io", "", true) };
    expect((await verifyPortalRequest({ headers: h, method: "POST", path: "/account/summary", rawBody: body, ...seed })).ok).toBe(true);
  });

  it("never sends the service token to an outside registry member, and what it sends does not work on a seed", async () => {
    const body = JSON.stringify({ accountId: "acct-u1", agentIds: ["a1"] });
    const h = portalCoordinatorHeaders("POST", "https://coord.outside.example/agent-control/machines", { "x-portal-service-token": "svc", "content-type": "application/json" }, body, cfg);
    expect(h["x-portal-service-token"]).toBeUndefined();
    const outside = { keys: [portal.publicKey], audiences: portalRequestAudiences("https://coord.outside.example", "", true) };
    expect((await verifyPortalRequest({ headers: h, method: "POST", path: "/agent-control/machines", rawBody: body, ...outside })).ok).toBe(true);
    const seed = { keys: [portal.publicKey], audiences: portalRequestAudiences("https://coordinator.edgecoder.io", "", true) };
    expect(await verifyPortalRequest({ headers: h, method: "POST", path: "/agent-control/machines", rawBody: body, ...seed })).toMatchObject({ ok: false, error: "portal_audience_mismatch" });
  });

  it("withholds the token from hosts off the static list, even if an outside member claims a seed host", () => {
    expect(portalCoordinatorHeaders("GET", "https://random.example/inference/models", { "x-portal-service-token": "svc" }, undefined, cfg)["x-portal-service-token"]).toBeUndefined();
    const claims = serviceTokenHostPolicy(policy, () => outsideMemberHosts([{ operatorKind: "community", urls: ["https://coordinator-eu.edgecoder.io"] }]));
    expect(claims("https://coordinator-eu.edgecoder.io/x")).toBe(false);
    expect(claims("https://coordinator.edgecoder.io/x")).toBe(true);
  });

  it("without a signing key, calls go out as before (token, no signature)", () => {
    const h = portalCoordinatorHeaders("GET", "https://coordinator.edgecoder.io/inference/models", { "x-portal-service-token": "svc" }, undefined, { signingKey: () => null, tokenAllowed });
    expect(h).toEqual({ "x-portal-service-token": "svc" });
  });
});

describe("PORTAL_REGISTRY_COORDINATORS fan-out list", () => {
  const entries = [
    entry({ peerId: "c1", urls: ["https://coord.outside.example/"] }),
    entry({ peerId: "c2", urls: ["https://probation.example"], status: "probation" }),
    entry({ peerId: "c3", urls: ["https://suspended.example"], status: "suspended" }),
    entry({ peerId: "c4", urls: ["https://down.example"], health: { status: "unhealthy", checkedAtMs: 1, latencyMs: null } }),
    entry({ peerId: "c5", urls: ["http://plain.example", "https://10.0.0.5"] }),
    entry({ peerId: "seed", urls: ["https://coordinator.edgecoder.io"], operator: { id: "edgecoder", name: "EdgeCoder", kind: "edgecoder" } })
  ];

  it("is empty while the flag is off (the default)", () => {
    expect(registryFanoutUrls(entries, { enabled: false })).toEqual([]);
  });

  it("lists only active, healthy-enough, https outside members", () => {
    expect(registryFanoutUrls(entries, { enabled: true })).toEqual(["https://coord.outside.example"]);
  });

  it("every outside member's host is kept from the token, whatever its status", () => {
    const hosts = outsideMemberHosts([
      { operatorKind: "community", urls: ["https://a.example", "https://B.example."] },
      { operatorKind: "edgecoder", urls: ["https://coordinator.edgecoder.io"] }
    ]);
    expect([...hosts].sort()).toEqual(["a.example", "b.example"]);
  });
});

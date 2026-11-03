import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { CoordinatorTrustGate, PinnedKeyStore, type IdentityFetch } from "../../src/trust/pinned-keys.js";
import { ActiveCoordinator, CoordinatorNotVerifiedError, meshWsUrl } from "../../src/swarm/active-coordinator.js";
import { coordinatorFetch } from "../trust/coordinator-fetch.js";

const a = createPeerKeys("coord-a");
const b = createPeerKeys("coord-b");

function setup() {
  const store = new PinnedKeyStore({ mode: "tofu", pinFile: null });
  const fa = coordinatorFetch(a);
  const fb = coordinatorFetch(b, { signWith: createPeerKeys("coord-b") });
  const calls: string[] = [];
  const fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(url);
    return url.startsWith("https://b.example") ? fb(url, init) : fa(url, init);
  }) as IdentityFetch;
  const gate = new CoordinatorTrustGate({ store, fetch });
  return { coordinator: new ActiveCoordinator("https://a.example/", gate), calls };
}

describe("ActiveCoordinator: every URL change is verified before use", () => {
  it("refuses requests until verified, and again after a URL change", async () => {
    const { coordinator, calls } = setup();
    expect(() => coordinator.requireVerified()).toThrow(CoordinatorNotVerifiedError);
    expect((await coordinator.verify()).trusted).toBe(true);
    expect(coordinator.requireVerified()).toBe("https://a.example");

    // A discovery/steering/failover change: unverified until it proves its key.
    expect(coordinator.set("https://b.example", "discovery")).toBe(true);
    expect(coordinator.isVerified()).toBe(false);
    expect(() => coordinator.requireVerified()).toThrow(CoordinatorNotVerifiedError);
    // b answers with a signature from a different key: refused, stays unverified.
    expect((await coordinator.verify()).trusted).toBe(false);
    expect(() => coordinator.requireVerified()).toThrow(CoordinatorNotVerifiedError);

    // Back to a: verified afresh (a new challenge, not a cached pass).
    const before = calls.length;
    coordinator.set("https://a.example", "failover");
    expect(coordinator.isVerified()).toBe(false);
    expect((await coordinator.verify()).trusted).toBe(true);
    expect(calls.length).toBe(before + 1);
  });

  it("a URL change during verification does not mark the new URL verified", async () => {
    const { coordinator } = setup();
    const pending = coordinator.verify();
    coordinator.set("https://b.example", "discovery");
    expect((await pending).trusted).toBe(false);
    expect(coordinator.isVerified()).toBe(false);
  });

  it("invalidate() (reconnect) forces a new challenge", async () => {
    const { coordinator, calls } = setup();
    await coordinator.verify();
    await coordinator.verify();
    expect(calls).toHaveLength(1);
    coordinator.invalidate();
    expect(coordinator.isVerified()).toBe(false);
    await coordinator.verify();
    expect(calls).toHaveLength(2);
    await coordinator.verify({ force: true });
    expect(calls).toHaveLength(3);
  });
});

describe("mesh WebSocket URL", () => {
  it("carries no token, only the peer id", () => {
    const url = meshWsUrl("https://coord.example/", "agent-1");
    expect(url).toBe("wss://coord.example/mesh/ws?peerId=agent-1");
    expect(url).not.toMatch(/token/);
    expect(meshWsUrl("http://127.0.0.1:4301", "a b")).toBe("ws://127.0.0.1:4301/mesh/ws?peerId=a%20b");
  });
});

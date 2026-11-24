import { describe, it, expect, vi } from "vitest";
import { NobleBLETransport } from "../../../src/mesh/ble/noble-ble-transport.js";

// An iPhone serves nearby machines only while charging: unplugged, it stops advertising, the Mac
// drops it after 60 s unseen, and when it is plugged back in and advertises again the Mac must list
// it again (it used to skip the identity read for a peripheral it had identified once, forever).
describe("NobleBLETransport rediscovery", () => {
  function transportWithIdentified(peripheralId: string, agentId: string) {
    const t = new NobleBLETransport("mac-1");
    const internals = t as any;
    internals.identifiedPeripherals.add(peripheralId);
    internals.peripheralsByAgentId.set(agentId, { id: peripheralId });
    return { t, internals };
  }

  it("re-reads the identity of a known peripheral that was dropped from the peer list", () => {
    const { internals } = transportWithIdentified("p1", "iphone-1");
    const peripheral = { id: "p1", rssi: -50, connect: vi.fn() };
    internals.handleDiscovery(peripheral);
    expect(peripheral.connect).toHaveBeenCalledTimes(1);
    expect(internals.identifiedPeripherals.has("p1")).toBe(false);
  });

  it("only refreshes a peer that is still listed", () => {
    const { t, internals } = transportWithIdentified("p1", "iphone-1");
    internals.peers.set("iphone-1", { agentId: "iphone-1", lastSeenMs: 0, rssi: -90 });
    const peripheral = { id: "p1", rssi: -40, connect: vi.fn() };
    internals.handleDiscovery(peripheral);
    expect(peripheral.connect).not.toHaveBeenCalled();
    const peer = t.discoveredPeers().find((p) => p.agentId === "iphone-1");
    expect(peer?.rssi).toBe(-40);
    expect(Date.now() - (peer?.lastSeenMs ?? 0)).toBeLessThan(5_000);
  });
});

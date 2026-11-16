import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lanProof, lanProofWindow } from "../../src/swarm/lan-discovery.js";
import { LanRegistry, LAN_REGISTRY_TTL_MS, remoteResolverFrom } from "../../src/swarm/lan-registry.js";

const NOW = 50 * 60_000;
const W = lanProofWindow(NOW);
function lanKey() {
  const id = randomBytes(8).toString("hex");
  const key = randomBytes(32);
  return { id, key, reg: { id, key: key.toString("base64") }, proof: (w = W) => ({ id, p: lanProof(key, id, w), w }) };
}

describe("coordinator LAN registry: rotating ids mapped to agents", () => {
  it("resolves a neighbour report only with a fresh, valid proof, and is symmetric", () => {
    const r = new LanRegistry();
    const a = lanKey();
    const b = lanKey();
    r.register("agent-a", { ids: [a.reg] }, NOW);
    r.register("agent-b", { ids: [b.reg], direct: true }, NOW);
    r.noteReports("agent-a", [{ ...b.proof(), rttMs: 1.4 }], NOW);
    expect([...r.neighboursOf("agent-a", NOW)]).toEqual([["agent-b", 1.4]]);
    // b never reported a: it still sees a (a heard b's announcement), with a's measurement.
    expect([...r.neighboursOf("agent-b", NOW)]).toEqual([["agent-a", 1.4]]);
    // b's own better measurement wins on both sides.
    r.noteReports("agent-b", [{ ...a.proof(), rttMs: 0.9 }], NOW);
    expect(r.neighboursOf("agent-a", NOW).get("agent-b")).toBe(0.9);
    expect(r.directOn("agent-b", NOW)).toBe(true);
    expect(r.directOn("agent-a", NOW)).toBe(false);
  });

  it("drops a made-up proof, an old window, itself, and a round trip too long for a LAN", () => {
    const r = new LanRegistry();
    const a = lanKey();
    const b = lanKey();
    r.register("agent-a", { ids: [a.reg] }, NOW);
    r.register("agent-b", { ids: [b.reg] }, NOW);
    r.noteReports("agent-a", [
      { id: b.id, p: "0".repeat(16), w: W, rttMs: 1 },
      { ...b.proof(W - 5), rttMs: 1 },
      { ...a.proof(), rttMs: 1 },
    ], NOW);
    expect(r.neighboursOf("agent-a", NOW).size).toBe(0);
    r.noteReports("agent-a", [{ ...b.proof(), rttMs: 400 }], NOW);
    expect(r.neighboursOf("agent-a", NOW).size).toBe(0);
  });

  it("forgets stale registrations and reports; a re-register with no ids forgets the agent", () => {
    const r = new LanRegistry();
    const a = lanKey();
    const b = lanKey();
    r.register("agent-a", { ids: [a.reg] }, NOW);
    r.register("agent-b", { ids: [b.reg] }, NOW);
    r.noteReports("agent-a", [{ ...b.proof(), rttMs: 2 }], NOW);
    expect(r.neighboursOf("agent-a", NOW + LAN_REGISTRY_TTL_MS + 1).size).toBe(0);
    r.forget("agent-b");
    expect(r.resolveLocal(b.id, b.proof().p, W, NOW)).toBeNull();
  });

  it("an id another agent holds is not taken over", () => {
    const r = new LanRegistry();
    const a = lanKey();
    r.register("agent-a", { ids: [a.reg] }, NOW);
    r.register("agent-x", { ids: [{ id: a.id, key: randomBytes(32).toString("base64") }] }, NOW);
    expect(r.resolveLocal(a.id, a.proof().p, W, NOW)).toBe("agent-a");
    expect(r.currentLanId("agent-x", NOW)).toBeNull();
  });

  it("resolves neighbours on a peer coordinator by its shared proofs (never its key)", () => {
    const here = new LanRegistry();
    const there = new LanRegistry();
    const a = lanKey();
    const b = lanKey();
    here.register("agent-a", { ids: [a.reg] }, NOW);
    there.register("agent-b", { ids: [b.reg] }, NOW);
    here.noteReports("agent-a", [{ ...b.proof(W - 1), rttMs: 3 }], NOW);
    const shared = there.proofsOf("agent-b", NOW);
    expect(JSON.stringify(shared)).not.toContain(b.key.toString("base64"));
    const remote = remoteResolverFrom([{ agentId: "agent-b", lanProofs: shared }]);
    expect([...here.neighboursOf("agent-a", NOW, remote)]).toEqual([["agent-b", 3]]);
    expect(here.neighboursOf("agent-a", NOW).size).toBe(0);
  });

  it("proximity groups: agents linked by reports share a group; loners have none", () => {
    const r = new LanRegistry();
    const [a, b, c, d] = [lanKey(), lanKey(), lanKey(), lanKey()];
    for (const [n, k] of [["a", a], ["b", b], ["c", c], ["d", d]] as const) r.register(`agent-${n}`, { ids: [k.reg] }, NOW);
    r.noteReports("agent-a", [{ ...b.proof(), rttMs: 1 }], NOW);
    r.noteReports("agent-c", [{ ...b.proof(), rttMs: 1 }], NOW);
    const g = r.groups(NOW);
    expect(g.get("agent-a")).toBe(g.get("agent-b"));
    expect(g.get("agent-c")).toBe(g.get("agent-b"));
    expect(g.has("agent-d")).toBe(false);
  });

  it("holds no address: only ids, keys, proofs and round trips", () => {
    const r = new LanRegistry();
    const a = lanKey();
    const b = lanKey();
    r.register("agent-a", { ids: [a.reg] }, NOW);
    r.register("agent-b", { ids: [b.reg] }, NOW);
    r.noteReports("agent-a", [{ ...b.proof(), rttMs: 1, address: "192.168.1.5" } as never], NOW);
    expect(JSON.stringify(r.reportsOf("agent-a", NOW))).not.toContain("192.168");
  });
});

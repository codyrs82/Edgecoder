import { describe, expect, it } from "vitest";
import { statsQuorumThreshold } from "../../src/swarm/coordinator/stats-ledger.js";

/*
 * Stats checkpoint quorum: a majority of the coordinators, counting coordinator peers only. The
 * mesh peer table also holds agents; counting them set the US seed's threshold out of reach (it
 * never committed a checkpoint on 2026-11-24 while the EU seed, with fewer agents, committed all 68).
 */

const peers = (...ids: string[]) => ids.map((peerId) => ({ peerId }));

describe("stats checkpoint quorum", () => {
  it("two coordinators need both, whatever agents sit in the peer table", () => {
    const agents = new Set(["agent-1", "agent-2", "agent-3", "agent-4", "agent-5", "agent-6", "agent-7", "agent-8", "agent-9"]);
    const us = statsQuorumThreshold(peers("coord-eu", ...agents), (id) => agents.has(id), () => true);
    const eu = statsQuorumThreshold(peers("coord-us", "agent-1"), (id) => agents.has(id), () => true);
    expect(us).toBe(2);
    expect(eu).toBe(us);
  });

  it("counts each coordinator once and leaves out unapproved ones", () => {
    expect(statsQuorumThreshold(peers("c2", "c2", "c3"), () => false, () => true)).toBe(2); // 3 coordinators
    expect(statsQuorumThreshold(peers("c2", "rogue"), () => false, (id) => id !== "rogue")).toBe(2);
    expect(statsQuorumThreshold(peers(), () => false, () => true)).toBe(1);
  });
});

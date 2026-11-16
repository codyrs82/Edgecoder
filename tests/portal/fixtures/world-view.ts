import type { WorldAgent, WorldView } from "../../../src/common/world-view.js";

/**
 * A world view shaped like the live network in Nov 2026 (the owner's screenshot): coordinators in
 * ord and cdg, machines around both, one of them the signed-in user's.
 */
export const ORD = "coord-ord-1111";
export const CDG = "coord-cdg-2222";
export const MY_MACHINE = "desktop-maw-mb-02-local-6bfc752c";

let n = 0;
function agent(over: Partial<WorldAgent> & Pick<WorldAgent, "label" | "coordinatorId">): WorldAgent {
  n++;
  return {
    id: `a${String(n).padStart(6, "0")}${over.label.slice(-4)}`,
    mine: false,
    os: "linux",
    region: "iad",
    country: "US",
    continent: "NA",
    computeClass: "cpu",
    tier: "cpu.std",
    vramGb: null,
    models: ["qwen2.5-coder:1.5b"],
    modelsTotal: 1,
    activeModel: "qwen2.5-coder:1.5b",
    status: "idle",
    slots: 2,
    slotsUsed: 0,
    rttMs: 20,
    ...over
  };
}

export const WORLD: WorldView = {
  connected: true,
  generatedAtMs: 1_800_000_000_000,
  servedBy: ORD,
  coordinators: [
    { id: CDG, url: "https://coordinator-cdg.edgecoder.io", region: "cdg", country: "FR", continent: "EU", agents: 2, agentsOnline: 2, reachable: true, self: false, myRttMs: 258 },
    { id: ORD, url: "https://coordinator.edgecoder.io", region: "ord", country: "US", continent: "NA", agents: 4, agentsOnline: 4, reachable: true, self: true, myRttMs: 73 }
  ],
  links: [{ from: ORD, to: CDG, rttMs: 99 }],
  agents: [
    agent({ label: "lin-•••4e08", coordinatorId: ORD, rttMs: 3 }),
    agent({ label: "lin-•••f468", coordinatorId: ORD, rttMs: 4, status: "busy", slotsUsed: 1 }),
    agent({ label: "mac-•••e782", os: "macos", coordinatorId: ORD, rttMs: 120, computeClass: "apple", models: ["deepseek-r1:7b", "qwen2.5-coder:1.5b"], modelsTotal: 2 }),
    agent({ label: "mac-•••6bfc", os: "macos", mine: true, name: MY_MACHINE, coordinatorId: ORD, rttMs: 30, computeClass: "apple" }),
    agent({ label: "lin-•••beee", coordinatorId: CDG, region: "cdg", country: "FR", continent: "EU", rttMs: 8 }),
    agent({ label: "lin-•••0d4e", coordinatorId: CDG, region: "cdg", country: "FR", continent: "EU", rttMs: null, status: "stale" })
  ],
  models: [
    { model: "qwen2.5-coder:1.5b", agents: 6, online: 5 },
    { model: "deepseek-r1:7b", agents: 1, online: 1 }
  ],
  totals: { coordinators: 2, agents: 6, online: 5, busy: 1, mine: 1, models: 2, slots: 12, slotsUsed: 1 },
  truncated: false
};

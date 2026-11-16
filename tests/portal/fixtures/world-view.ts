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

/** The same network, busy: the ord machine lin-•••f468 streams your reply, work crosses ord ↔ cdg. */
export const SERVING = WORLD.agents[1].id;
export const ACTIVE_WORLD: WorldView = {
  ...WORLD,
  links: [{ from: ORD, to: CDG, rttMs: 99, workPerMin: 12, gossipPerMin: 30 }],
  agents: WORLD.agents.map((a, i) =>
    i === 1
      ? { ...a, status: "busy", slotsUsed: 2, activity: { callsNow: 2, streaming: 2, callsPerMin: 14 } }
      : i === 4
        ? { ...a, status: "busy", slotsUsed: 1, activity: { callsNow: 1, streaming: 0, callsPerMin: 3 } }
        : { ...a, activity: { callsNow: 0, streaming: 0, callsPerMin: a.status === "stale" ? 0 : 1 } }
  ),
  yourRequests: [{ coordinator: ORD, machineKey: WORLD.agents[1].id, state: "streaming" }],
  totals: { ...WORLD.totals, busy: 2, slotsUsed: 3 }
};

/**
 * The owner's Nov 2026 screenshot, crowded: ten machines on ord (three of them yours, with the
 * desktop app's long names), two on cdg, You below. The map labels collided here.
 */
export const OWNER_MINE = ["desktop-macbook-pro-crs-local-51738927", "desktop-mac-example-local-a8fba2b6", "desktop-mac-mini-studio-local-0c1d2e3f"];
export const OWNER_WORLD: WorldView = (() => {
  const ord = (label: string, rttMs: number | null, over: Partial<WorldAgent> = {}) => agent({ label, coordinatorId: ORD, region: "ord", rttMs, ...over });
  const cdg = (label: string, rttMs: number | null, over: Partial<WorldAgent> = {}) => agent({ label, coordinatorId: CDG, region: "cdg", country: "FR", continent: "EU", rttMs, ...over });
  const agents = [
    ord("mac-•••5173", 14, { os: "macos", mine: true, name: OWNER_MINE[0], computeClass: "apple", slots: 4 }),
    ord("mac-•••a8fb", 9, { os: "macos", mine: true, name: OWNER_MINE[1], computeClass: "apple" }),
    ord("mac-•••0c1d", 95, { os: "macos", mine: true, name: OWNER_MINE[2], computeClass: "apple" }),
    ord("lin-•••4c08", 3),
    ord("lin-•••f468", 4, { status: "busy", slotsUsed: 1, activity: { callsNow: 1, streaming: 1, callsPerMin: 6 } }),
    ord("mac-•••e782", 120, { os: "macos", computeClass: "apple", models: ["deepseek-r1:7b", "qwen2.5-coder:1.5b"], modelsTotal: 2 }),
    ord("lin-•••91aa", 22, { computeClass: "gpu", tier: "gpu.24gb", vramGb: 24, slots: 6 }),
    ord("win-•••77c2", 35, { os: "windows" }),
    ord("lin-•••a1b8", 18),
    ord("lin-•••d00d", 100, { status: "busy", slotsUsed: 2, activity: { callsNow: 2, streaming: 0, callsPerMin: 12 } }),
    cdg("lin-•••beee", 8),
    cdg("lin-•••0d4e", null, { status: "stale" })
  ];
  return {
    ...WORLD,
    links: [{ from: ORD, to: CDG, rttMs: 99, workPerMin: 12, gossipPerMin: 30 }],
    coordinators: WORLD.coordinators.map((c) => ({ ...c, agents: c.id === ORD ? 10 : 2, agentsOnline: c.id === ORD ? 10 : 1 })),
    agents,
    totals: { coordinators: 2, agents: 12, online: 11, busy: 2, mine: 3, models: 2, slots: 30, slotsUsed: 3 }
  };
})();

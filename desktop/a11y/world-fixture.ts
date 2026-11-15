// A canned GET /v1/ide/network/world answer shaped like the live network in Nov 2026: two seed
// coordinators (US iad, EU fra), hosted agents in iad, lax, sin, gru, jnb, nrt, syd, lhr and fra,
// a GPU machine in Chicago, and two Macs that belong to the signed-in user.
import type { WorldAgent, WorldView } from "../src/lib/api";

const US = "coord-25bacdd7b3f3";
const EU = "coord-b17fb990ea6b";

let n = 0;
function agent(over: Partial<WorldAgent> & Pick<WorldAgent, "label" | "coordinatorId">): WorldAgent {
  n++;
  const id = `a${String(n).padStart(3, "0")}0${over.label.slice(-4)}`;
  return {
    id, mine: false, os: "linux", region: null, country: null, continent: null, computeClass: "cpu", tier: "cpu.std",
    vramGb: null, models: ["qwen3.5:9b"], modelsTotal: 1, activeModel: "qwen3.5:9b", status: "idle", slots: 2, slotsUsed: 0, rttMs: 40, ...over,
  };
}

const AGENTS: WorldAgent[] = [
  agent({ label: "mac-•••c41d", mine: true, name: "codys-mac-studio", os: "macos", country: "US", continent: "NA", computeClass: "apple", tier: "apple.m.hi", models: ["qwen2.5-coder:32b", "qwen3.5:9b", "llama3.2:3b"], modelsTotal: 3, activeModel: "qwen2.5-coder:32b", slots: 4, slotsUsed: 1, status: "busy", coordinatorId: US, rttMs: 31 }),
  agent({ label: "mac-•••9e07", mine: true, name: "codys-macbook-air", os: "macos", country: "US", continent: "NA", computeClass: "apple", tier: "apple.m.std", models: ["qwen3.5:9b"], slots: 2, coordinatorId: US, rttMs: 34 }),
  agent({ label: "lin-•••3f2a", region: "ord", country: "US", continent: "NA", computeClass: "gpu", tier: "gpu.24gb", vramGb: 24, models: ["qwen2.5-coder:32b", "deepseek-r1:32b", "qwen3.5:9b"], modelsTotal: 3, activeModel: "deepseek-r1:32b", slots: 6, slotsUsed: 4, status: "busy", coordinatorId: US, rttMs: 18 }),
  agent({ label: "lin-•••a1b8", region: "iad", country: "US", continent: "NA", coordinatorId: US, rttMs: 3 }),
  agent({ label: "lin-•••7c55", region: "lax", country: "US", continent: "NA", coordinatorId: US, rttMs: 62, status: "busy", slotsUsed: 1 }),
  agent({ label: "lin-•••d0e3", region: "gru", country: "BR", continent: "SA", coordinatorId: US, rttMs: 118 }),
  agent({ label: "lin-•••5b19", region: "nrt", country: "JP", continent: "AS", coordinatorId: US, rttMs: 152, models: ["llama3.2:3b"], activeModel: "llama3.2:3b" }),
  agent({ label: "lin-•••80af", region: "syd", country: "AU", continent: "OC", coordinatorId: US, rttMs: 198 }),
  agent({ label: "lin-•••e2c6", region: "fra", country: "DE", continent: "EU", coordinatorId: EU, rttMs: 2, status: "busy", slotsUsed: 2 }),
  agent({ label: "lin-•••417d", region: "lhr", country: "GB", continent: "EU", coordinatorId: EU, rttMs: 14 }),
  agent({ label: "lin-•••9a30", region: "jnb", country: "ZA", continent: "AF", coordinatorId: EU, rttMs: 161 }),
  agent({ label: "lin-•••f6b2", region: "sin", country: "SG", continent: "AS", coordinatorId: EU, rttMs: 158, models: ["qwen3.5:9b", "llama3.2:3b"], modelsTotal: 2 }),
  agent({ label: "win-•••0d4e", os: "windows", country: "NL", continent: "EU", coordinatorId: EU, rttMs: null, status: "stale", models: ["llama3.2:3b"], activeModel: "llama3.2:3b" }),
];

const online = AGENTS.filter((a) => a.status !== "stale");

export const WORLD: WorldView = {
  connected: true,
  generatedAtMs: Date.now(),
  servedBy: US,
  selfAgentId: "codys-mac-studio",
  coordinators: [
    { id: US, url: "https://coordinator.edgecoder.io", region: "iad", country: "US", continent: "NA", agents: 8, agentsOnline: 8, reachable: true, self: true, myRttMs: 38 },
    { id: EU, url: "https://coordinator-eu.edgecoder.io", region: "fra", country: "DE", continent: "EU", agents: 5, agentsOnline: 4, reachable: true, self: false, myRttMs: 112 },
  ],
  links: [{ from: US, to: EU, rttMs: 88 }],
  agents: AGENTS,
  models: [
    { model: "qwen3.5:9b", agents: 10, online: 10 },
    { model: "llama3.2:3b", agents: 4, online: 3 },
    { model: "qwen2.5-coder:32b", agents: 2, online: 2 },
    { model: "deepseek-r1:32b", agents: 1, online: 1 },
  ],
  totals: {
    coordinators: 2, agents: AGENTS.length, online: online.length, busy: AGENTS.filter((a) => a.status === "busy").length, mine: 2, models: 4,
    slots: online.reduce((s, a) => s + a.slots, 0), slotsUsed: online.reduce((s, a) => s + a.slotsUsed, 0),
  },
  truncated: false,
};

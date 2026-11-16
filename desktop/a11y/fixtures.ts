// Canned backend answers for the a11y run, so every screen is audited with content in it
// rather than in its empty or error state. Shapes follow src/lib/api.ts and src/lib/types.ts.

import { WORLD } from "./world-fixture";

/** Answered with a 404 (nothing in progress). */
export const NOT_FOUND = Symbol("not found");

const NOW = Date.now();
const PEER = "12D3KooWA11yPeer0000000000000000000000000000000001";

const FIXTURES: Array<[RegExp, unknown]> = [
  // Getting started: closed (show: false), so the app shell isn't covered by the guide; the
  // Settings section and the guide itself still have saved progress to show.
  [/\/portal\/api\/onboarding$/, {
    state: { goal: "both", done: ["welcome", "how"], skipped: [], current: "models", routing: null, dismissed: true, completedAtMs: null, firstSeenAtMs: NOW - 3_600_000, firstTaskAtMs: null, updatedAtMs: NOW },
    signals: { machines: 2, machinesOnline: 1, balanceCSats: 0, apiKeys: 0, github: false, firstTask: false, hostApproved: false, hostRequested: false, newAccount: true, localModels: null, cliInstalled: null },
    show: false,
  }],
  [/\/v1\/ide\/network\/world$/, WORLD],
  [/:4301\/health\/runtime/, {
    ok: true,
    coordinator: { provider: "ollama-local", queued: 2, agents: 3, results: 41 },
    ollama: { expectedProvider: "ollama-local", host: "http://127.0.0.1:11434", reachable: true, version: "0.12.0", modelCount: 2, error: null },
  }],
  [/:4301\/status/, { queued: 2, agents: 3, results: 41 }],
  [/:4301\/identity/, { peerId: PEER, publicKeyPem: "", coordinatorUrl: "https://coordinator.edgecoder.io", networkMode: "public_mesh" }],
  [/:4301\/mesh\/peers/, {
    peers: [
      { peerId: PEER, publicKeyPem: "", coordinatorUrl: "https://coordinator.edgecoder.io", networkMode: "public_mesh" },
      { peerId: "12D3KooWA11yPeer0000000000000000000000000000000002", publicKeyPem: "", coordinatorUrl: "https://eu.edgecoder.io", networkMode: "public_mesh" },
      { peerId: "12D3KooWA11yPeer0000000000000000000000000000000003", publicKeyPem: "", coordinatorUrl: "https://ap.edgecoder.io", networkMode: "public_mesh" },
    ],
  }],
  [/:4301\/mesh\/reputation/, {
    peers: [
      { peerId: "12D3KooWA11yPeer0000000000000000000000000000000002", score: 0.92 },
      { peerId: "12D3KooWA11yPeer0000000000000000000000000000000003", score: 0.31 },
    ],
  }],
  [/:4301\/capacity/, {
    totals: { agentsConnected: 2, totalCapacity: 4, swarmEnabledCount: 2, localOllamaCount: 1, ideEnabledCount: 1, activeTunnels: 0, blacklistedAgents: 0 },
    agents: [
      { agentId: "agent-mac", os: "macos", version: "1.0.0", mode: "ide-enabled", maxConcurrentTasks: 2, connectedPeers: [], blacklisted: false, lastSeenMs: NOW, powerPolicy: { allowCoordinatorTasks: true } },
      { agentId: "agent-linux", os: "linux", version: "1.0.0", mode: "swarm-only", maxConcurrentTasks: 2, connectedPeers: [], blacklisted: false, lastSeenMs: NOW - 90_000, powerPolicy: { allowCoordinatorTasks: false, reason: "on battery" } },
    ],
  }],
  [/\/model\/pull\/progress/, NOT_FOUND],
  [/:4302\/dashboard\/api\/overview/, { activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, ollamaHealthy: true, uptimeSeconds: 86_400, memoryMB: 512, nodeVersion: "v22.0.0" }],
  [/:4302\/model\/list/, [
    { modelId: "qwen2.5-coder:7b", paramSize: 7, quantization: "Q4_K_M", installed: true, active: true, source: "ollama" },
    { modelId: "llama3.2:3b", paramSize: 3, quantization: "Q4_K_M", installed: true, active: false, source: "ollama" },
  ]],
  [/:1143[45]\/api\/tags/, {
    models: [
      { name: "qwen2.5-coder:7b", model: "qwen2.5-coder:7b", size: 4_700_000_000, digest: "a1", modified_at: new Date(NOW).toISOString(), details: { parameter_size: "7B", quantization_level: "Q4_K_M", family: "qwen2" } },
      { name: "llama3.2:3b", model: "llama3.2:3b", size: 2_000_000_000, digest: "b2", modified_at: new Date(NOW).toISOString(), details: { parameter_size: "3B", quantization_level: "Q4_K_M", family: "llama" } },
    ],
  }],
  [/:1143[45]\/api\/ps/, { models: [{ name: "qwen2.5-coder:7b", model: "qwen2.5-coder:7b", size: 4_700_000_000, size_vram: 4_700_000_000, digest: "a1" }] }],
  [/\/v1\/ide\/compute$/, {
    connected: true,
    selfAgentId: "agent-mac",
    account: {
      accountId: "acct_a11y",
      cSats: 125_000,
      earnedSats: 42,
      recent: [
        { type: "spend", cSats: -120, reason: "inference", atMs: NOW - 60_000 },
        { type: "purchase", cSats: 100_000, reason: "lightning", atMs: NOW - 3_600_000 },
      ],
      machines: [
        { agentId: "agent-mac", online: true, lastSeenMs: NOW, computeClass: "apple", tier: "m2", activeModel: "qwen2.5-coder:7b", models: ["qwen2.5-coder:7b", "llama3.2:3b"], reservedUntilMs: null },
        { agentId: "agent-linux", online: true, lastSeenMs: NOW, computeClass: "gpu", tier: "24gb", activeModel: "deepseek-r1:32b", models: ["deepseek-r1:32b"], reservedUntilMs: null },
      ],
      networkAgents: 17,
      coordinator: { peerId: PEER, url: "https://coordinator.edgecoder.io" },
    },
    classes: { cpu: { label: "CPU", cSatsPerSecondBaseTier: 1 }, gpu: { label: "GPU", cSatsPerSecondBaseTier: 6 }, apple: { label: "Apple silicon", cSatsPerSecondBaseTier: 3 } },
    models: [
      { model: "deepseek-r1:32b", agents: 4, classes: ["gpu"], cSatsPerMTokens: { input: 900, output: 2700 } },
      { model: "qwen2.5-coder:32b", agents: 6, classes: ["gpu", "apple"], cSatsPerMTokens: { input: 700, output: 2100 } },
    ],
    steering: { url: "https://coordinator.edgecoder.io", source: "registry", peerId: PEER, region: "us-east", latencyMs: 38, reason: "", decidedAtMs: NOW },
  }],
  [/\/v1\/ide\/reservations$/, {
    reservations: [
      { id: "res_1", computeClass: "gpu", tier: "24gb", model: "deepseek-r1:32b", agentId: "agent-net-1", startMs: NOW - 600_000, endMs: NOW + 3_000_000, status: "active", cSatsPerSecond: 6, prepaidCSats: 21_600, models: ["deepseek-r1:32b"] },
    ],
    options: { gpu: { available: 3, cSatsPerSecond: 6, tiers: ["24gb"], models: ["deepseek-r1:32b", "qwen2.5-coder:32b"] }, cpu: { available: 9, cSatsPerSecond: 1, tiers: [], models: ["llama3.2:3b"] } },
    minMinutes: 10,
    maxMinutes: 240,
  }],
  [/\/v1\/ide\/connections$/, {
    connections: [
      { id: "cn_1", name: "Cursor", port: 4310, key: "ec_live_a11y", target: "auto", model: "qwen2.5-coder:7b", spentCSats: 300, budgetCSats: 5000, enabled: true, createdAtMs: NOW - 86_400_000, url: "http://127.0.0.1:4310/v1", listening: true },
    ],
    localModels: ["qwen2.5-coder:7b", "llama3.2:3b"],
    networkConnected: true,
    nextPort: 4311,
  }],
  [/\/v1\/ide\/usage/, {
    sinceMs: NOW - 30 * 86_400_000,
    totals: { requests: 214, cSats: 8_400, seconds: 1_900, failed: 3, promptTokens: 410_000, outputTokens: 96_000 },
    byDay: Array.from({ length: 7 }, (_, i) => ({ day: new Date(NOW - (6 - i) * 86_400_000).toISOString().slice(0, 10), requests: 20 + i * 4, cSats: 900 + i * 110 })),
    byModel: [
      { key: "qwen2.5-coder:32b", requests: 150, cSats: 6_000, seconds: 1_300, promptTokens: 300_000, outputTokens: 70_000 },
      { key: "deepseek-r1:32b", requests: 64, cSats: 2_400, seconds: 600, promptTokens: 110_000, outputTokens: 26_000 },
    ],
    byClass: [{ key: "gpu", requests: 214, cSats: 8_400, seconds: 1_900, promptTokens: 410_000, outputTokens: 96_000 }],
    bySource: [{ key: "desktop", requests: 214, cSats: 8_400, seconds: 1_900, promptTokens: 410_000, outputTokens: 96_000 }],
    byPlacement: [{ key: "network", requests: 214, cSats: 8_400, seconds: 1_900, promptTokens: 410_000, outputTokens: 96_000 }],
    records: [
      { id: "u1", atMs: NOW - 120_000, kind: "inference", placement: "network", model: "qwen2.5-coder:32b", computeClass: "gpu", source: "desktop", ok: true, durationMs: 4_200, costMsat: 41_000, promptTokens: 1_800, outputTokens: 420 },
      { id: "u2", atMs: NOW - 900_000, kind: "inference", placement: "network", model: "deepseek-r1:32b", computeClass: "gpu", source: "desktop", ok: false, durationMs: 900, costMsat: 0 },
    ],
  }],
  // Settings → Active work: this Mac serves two jobs (one of them yours) and you have a chat running.
  [/\/v1\/ide\/activity$/, {
    atMs: NOW,
    agent: {
      reachable: true, agentId: "agent-mac", coordinatorUrl: "https://coordinator.edgecoder.io", registered: true, region: "us-east",
      paused: null, draining: false, claims: 2, slots: { total: 2, busy: 2 }, computeClass: "apple", tier: "apple.m", jobsUnknown: false,
      jobs: [
        { id: "sub-a11y-1", kind: "inference", model: "qwen2.5-coder:7b", startedAtMs: NOW - 12_000, elapsedMs: 12_000, outputTokens: 340, requester: "network" },
        { id: "sub-a11y-2", kind: "inference", model: "llama3.2:3b", startedAtMs: NOW - 3_000, elapsedMs: 3_000, outputTokens: 20, requester: "you" },
      ],
    },
    mine: [
      { id: "act-1", kind: "chat", title: "Explain the retry logic", source: "EdgeCoder chat", model: "auto", startedAtMs: NOW - 3_000, status: "running", cSats: 0.4, steps: [], progress: "Thinking…",
        calls: [{ cSats: 0.4, model: "network/qwen2.5-coder:32b", served: { label: "m-1", own: false, computeClass: "gpu", tier: "24gb", hardware: "GPU", region: "us-east", country: "US", promptTokens: 900, outputTokens: 40 } }] },
    ],
  }],
  // Settings → Tasks: an API call the IDE server kept (chats come from IndexedDB, mocked separately).
  [/\/v1\/ide\/activity\/recent$/, {
    items: [
      { id: "act-0", kind: "api", title: "Summarize the changelog", source: "OpenAI API", model: "llama3.2:3b", startedAtMs: NOW - 600_000, endedAtMs: NOW - 594_000, status: "done", cSats: 0, steps: [], calls: [{ cSats: 0, where: "This computer · llama3.2:3b" }] },
      { id: "act-00", kind: "api", title: "Draft release notes", source: "Anthropic API", startedAtMs: NOW - 900_000, endedAtMs: NOW - 899_000, status: "failed", error: "HTTP 503", cSats: 0, steps: [], calls: [] },
    ],
  }],
  // Settings → Logs: the agent log's JSON request lines and a plain agent warning.
  [/\/v1\/ide\/logs/, {
    source: "agent", exists: true, size: 900, start: 0, next: 900, truncated: false, reset: false,
    sources: [{ id: "agent", label: "Agent and services", exists: true, size: 900 }, { id: "ollama", label: "Ollama", exists: false, size: 0 }],
    lines: [
      JSON.stringify({ level: 30, time: NOW - 5_000, service: "ide-provider", requestId: "r1", req: { method: "POST", url: "/v1/ide/chat" }, msg: "incoming request" }),
      JSON.stringify({ level: 30, time: NOW - 4_000, service: "ide-provider", requestId: "r1", res: { statusCode: 200 }, responseTime: 812.4, msg: "request completed" }),
      JSON.stringify({ level: 30, time: NOW - 3_000, service: "inference", requestId: "r2", req: { method: "GET", url: "/model/pull/progress" }, msg: "incoming request" }),
      JSON.stringify({ level: 30, time: NOW - 3_000, service: "inference", requestId: "r2", res: { statusCode: 200 }, responseTime: 0.4, msg: "request completed" }),
      "[agent:agent-mac] offline probe failed (Error: POST /register failed (403): unknown agent)",
    ],
  }],
  [/\/v1\/ide\/bots$/, { bots: [] }],
  [/\/v1\/ide\/bots\/[^/]+\/messages$/, {
    messages: [
      { id: "m1", role: "user", content: "Tidy the README", atMs: NOW - 120_000 },
      { id: "m2", role: "assistant", content: "Done. I opened a pull request.", atMs: NOW - 60_000, runId: "run_1" },
    ],
  }],
  [/\/v1\/ide\/bots\/[^/]+\/history$/, {
    runs: [{ id: "run_1", trigger: "message", startedAtMs: NOW - 120_000, endedAtMs: NOW - 60_000, status: "done", summary: "Tidied the README", cSats: 12, where: "this computer" }],
  }],
  [/\/v1\/ide\/settings\/projects-folder/, { path: "/Users/a11y/EdgeCoder", source: "default", defaultPath: "/Users/a11y/EdgeCoder" }],
  [/\/v1\/ide\/repos\/recent/, { ghInstalled: true, loggedIn: true, login: "a11y", repos: ["a11y/demo", "a11y/site"] }],
  [/\/v1\/ide\/project$/, { projectRoot: null }],
  [/\/v1\/ide\/git\/github\/status/, { ghInstalled: true, loggedIn: true, login: "a11y" }],
  [/\/v1\/ide\/git\/state/, {
    branch: "main", upstream: "origin/main", ahead: 1, behind: 0, staged: [], unstaged: [{ path: "src/app.ts", status: "M" }],
    branches: ["main", "feature/login"], remotes: ["origin"], remoteUrl: "https://github.com/a11y/demo.git", hasCommits: true,
  }],
  [/\/portal\/api\/github\/status/, { connected: true, login: "a11y" }],
  [/\/portal\/api\/github\/token/, { token: null }],
  [/\/wallet\/payout-destination/, {
    accountId: "acct_a11y", network: "bitcoin", destination: { kind: "lightning_address", destination: "a11y@example.org", updatedAtMs: NOW - 86_400_000 },
    needsDestination: false, legacyAddressRetired: false, supportedKinds: ["lightning_address", "bolt12"], onchainSupported: false,
  }],
  [/\/wallet\/send\/requests/, { requests: [] }],
  [/\/portal\/api\/wallet\/overview/, {
    connected: true, network: "regtest", networkSource: "coordinator", cSats: 125_000, earnedSats: 42, btcUsd: 98_450, rateStale: false,
    fees: { purchaseFeeBps: 0, networkFeeBps: 500 }, topup: { minSats: 100, maxSats: 1_000_000 },
    payouts: {
      balance: { earnedMsat: 42_000, heldMsat: 2_000, maturesAtMs: NOW + 3_600_000, paidMsat: 10_000, pendingMsat: 0, payableMsat: 30_000 },
      policy: { network: "regtest", minPayoutSats: 1_000, maxFeeBps: 100, minFeeFloorSats: 10, lightningEnabled: true, paused: false, limits: { maxSingleSats: 100_000, maxAccountDailySats: 500_000 } },
      payouts: [{ createdAtMs: NOW - 86_400_000, kind: "withdraw", amountMsat: 10_000, feeMsat: 0, status: "paid" }],
    },
  }],
  [/\/portal\/api\/wallet\/overview/, {
    connected: true, network: "regtest", networkSource: "coordinator", cSats: 125_000, earnedSats: 42, btcUsd: 98_450, rateStale: false,
    fees: { purchaseFeeBps: 0, networkFeeBps: 500 }, topup: { minSats: 100, maxSats: 1_000_000 },
    payouts: {
      balance: { earnedMsat: 42_000, heldMsat: 2_000, maturesAtMs: NOW + 3_600_000, paidMsat: 10_000, pendingMsat: 0, payableMsat: 30_000 },
      policy: { network: "regtest", minPayoutSats: 1_000, maxFeeBps: 100, minFeeFloorSats: 10, lightningEnabled: true, paused: false, limits: { maxSingleSats: 100_000, maxAccountDailySats: 500_000 } },
      payouts: [{ createdAtMs: NOW - 86_400_000, kind: "withdraw", amountMsat: 10_000, feeMsat: 0, status: "paid" }],
    },
  }],
];

/** The canned answer for a backend URL; `{}` for anything not listed. */
export function fixtureFor(url: string): unknown {
  const bare = url.split("?")[0];
  for (const [pattern, body] of FIXTURES) if (pattern.test(url) || pattern.test(bare)) return body;
  return {};
}

/**
 * Text each settings section shows only once its fixture data is on screen. Sections draw
 * placeholders or an empty state first, and an audit of those would pass without testing anything.
 */
export const SECTION_SHOWS: Record<string, string> = {
  "Getting started": "steps done",
  "General": "us-east",
  "Profile": "a11y@example.org",
  "Usage": "Compute time",
  "Compute": "free now",
  "Connect your tools": "Cursor",
  "Models": "llama3.2:3b",
  "Integrations": "@a11y",
  "Network": "codys-mac-studio",
  "Dashboard": "ollama-local",
  "Active work": "Someone on the network",
  "Tasks": "Summarize the changelog",
  "Wallet": "a11y@example.org",
  "Logs": "offline probe failed",
};

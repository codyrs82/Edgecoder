// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Getting started: the wizard a new account sees, from zero to taking part. The steps are data
 * (ONBOARDING_STEPS); completion is read from real account state (OnboardingSignals) and the
 * account's saved progress (OnboardingState, kept by the portal: GET/POST /portal/api/onboarding).
 *
 * Shared by the desktop app (desktop/src/lib/onboarding.ts, components/OnboardingWizard.svelte) and
 * the portal (/portal/welcome, src/portal/pages/welcome.ts). Kept byte-identical in
 * src/common/onboarding.ts and desktop/src/lib/onboarding.ts (the desktop app does not import from
 * src/); tests/common/onboarding.test.ts checks the two match. Self-contained on purpose: the portal
 * ships these functions to the browser via Function.prototype.toString, so every function is a
 * declaration and every constant it reads is exported (ONBOARDING_BROWSER_LIB lists them).
 *
 * Videos: every step has a stable route (desktop `#/welcome/<id>`, web `/portal/welcome/<id>`), a
 * `data-video-anchor` hook (`welcome-<id>`) and a video slot that stays hidden until `src` is set.
 * Video paths are on the portal (/assets/videos/, built by scripts/videos/build.mjs, see
 * docs/videos/README.md). Only the web plays them; the desktop app links to the step on the web.
 */

// ── Types ──

export type OnboardingGoal = "own" | "buy" | "both" | "host";
export type StepId = "welcome" | "how" | "this-machine" | "machines" | "models" | "fund" | "tools" | "try" | "host" | "done";
export type Surface = "desktop" | "web";
/** Where things run (the bot form's policies, desktop/src/lib/bots.ts COMPUTE_POLICY_OPTIONS). */
export type RoutingPolicy = "auto" | "local_first" | "local_only" | "mine_only" | "model";

/** Real account state the checklists read. null: not known on this surface (or not loaded yet). */
export interface OnboardingSignals {
  /** Machines (agents) enrolled to the account. */
  machines: number | null;
  /** Of those, connected now. */
  machinesOnline: number | null;
  balanceCSats: number | null;
  apiKeys: number | null;
  github: boolean | null;
  /** A chat, Code task or bot run finished on this account. */
  firstTask: boolean | null;
  /** Approved to host for the network (true when HOST_APPROVAL_REQUIRED is off). */
  hostApproved: boolean | null;
  /** A host request was sent from this account's email. */
  hostRequested: boolean | null;
  /** The account is new (made in the last NEW_ACCOUNT_DAYS days). */
  newAccount: boolean | null;
  /** Desktop only: chat models installed on this computer. */
  localModels: number | null;
  /** Desktop only: the `edgecoder` command-line tool is installed. */
  cliInstalled: boolean | null;
}

/** Saved progress, per account (portal_onboarding). */
export interface OnboardingState {
  goal: OnboardingGoal | null;
  /** Steps the person finished or moved past with Next. */
  done: StepId[];
  /** Steps the person skipped. */
  skipped: StepId[];
  current: StepId;
  routing: RoutingPolicy | null;
  dismissed: boolean;
  completedAtMs: number | null;
  /** When the wizard was first shown to this account. */
  firstSeenAtMs: number | null;
  /** When a guided first task finished (reported by a client). */
  firstTaskAtMs: number | null;
  updatedAtMs: number;
}

export interface ChecklistItem {
  id: string;
  label: string;
  /** Not needed to finish the step (shown, never blocking). */
  optional?: boolean;
  /** Only on this surface. */
  surface?: Surface;
  /**
   * The step's own input answers it (the goal or routing choice): it counts toward completion but
   * isn't listed, since the list would repeat the question right under the choices.
   */
  input?: boolean;
}

/**
 * A button. `desktop` / `web` say what it does on each surface:
 * - "settings:<section>"  open that Settings section (desktop SettingsOverlay ids)
 * - "run:<action>"        the wizard does it (pull-model, install-cli, try-chat, open-code, new-bot)
 * - a path or URL         open it (web: same tab for /portal paths; desktop: the browser)
 * Missing on a surface: the button is not shown there.
 */
export interface StepAction {
  id: string;
  label: string;
  desktop?: string;
  web?: string;
  primary?: boolean;
  /**
   * Shown only while the coordinator has this payment path on (GET /portal/api/payments/paths,
   * PAYMENTS_DIRECT_RESERVATIONS / PAYMENTS_NWC). Hidden while the paths are unknown.
   */
  needs?: "directReservations" | "nwc";
}

/** Which payment paths the coordinator has on (the payments/paths route); null: not known yet. */
export interface PaymentPathFlags {
  prepaid?: boolean;
  directReservations?: boolean;
  nwc?: boolean;
}

export interface StepVideo {
  src: string | null;
  poster: string | null;
  /** WebVTT captions track. */
  captions: string | null;
}

export interface OnboardingStep {
  id: StepId;
  title: string;
  /** One or two short sentences. */
  body: string;
  checklist: ChecklistItem[];
  actions: StepAction[];
  /** Label of the Skip button; null: the step has none. */
  skip: string | null;
  /** Goals the step is shown for; empty: every goal. */
  goals: OnboardingGoal[];
  video: StepVideo;
}

// ── Constants ──

export const ONBOARDING_VERSION = 1;
export const NEW_ACCOUNT_DAYS = 14;
export const NO_VIDEO: StepVideo = { src: null, poster: null, captions: null };

export const GOAL_OPTIONS: Array<{ id: OnboardingGoal; title: string; desc: string }> = [
  { id: "own", title: "Use my own machines", desc: "Run models on computers you own. Free." },
  { id: "buy", title: "Buy network compute", desc: "Run bigger models on other people's machines. Pay per token in cSats." },
  { id: "both", title: "Both", desc: "Your machines first, the network when you need more." },
  { id: "host", title: "Host for others", desc: "Earn sats running other people's work. By request: an admin approves hosts." },
];

/** The tutorial cards (step "how"). */
export const HOW_CARDS: Array<{ title: string; body: string }> = [
  { title: "You ask", body: "A chat, a Code task, a bit, or a call to the API." },
  { title: "The coordinator picks the best fit", body: "It matches the job to a model and a machine by capability, speed and price." },
  { title: "A machine runs it", body: "One of yours (free), a machine you leased (already paid), or a host's machine (paid per token)." },
  { title: "Encrypted on the way", body: "Jobs travel encrypted between the coordinator and the machine. Work on this computer never leaves it." },
  { title: "You pay per token", body: "Network calls cost cSats by model size. 1 cSat = 1 sat. Hosts get 95%, the network 5%." },
];

/** More to know, under the cards. */
export const HOW_MORE: Array<{ title: string; body: string }> = [
  { title: "Bits", body: "Run on a schedule with a daily budget in cSats, so they never overspend." },
  { title: "Code", body: "An agent that reads and edits a project, runs tests and opens pull requests when you allow it." },
  { title: "Tentacles", body: "Helpers on cheap models that take parts of a big task at once." },
  { title: "Remote co-editing", body: "Type /remote in edgecoder code and keep working on the same session in the app." },
];

export const ROUTING_OPTIONS: Array<{ id: RoutingPolicy; title: string; desc: string; recommended?: boolean }> = [
  { id: "auto", title: "Auto", desc: "Best fit for each request: your machines when one has a capable model (free), else the network.", recommended: true },
  { id: "local_first", title: "Local first", desc: "This computer first, then your machines, then the network." },
  { id: "local_only", title: "This computer only", desc: "Never leaves this computer. Free." },
  { id: "mine_only", title: "My machines only", desc: "This computer and your other machines. Free, never the network." },
  { id: "model", title: "Specific model", desc: "Always the model you pick in the chat's compute menu." },
];

/** Model classes for the cost estimator, by size (src/economy/job-pricing.ts TOKEN_PRICE_USD_PER_M). */
export const MODEL_CLASSES: Array<{ id: string; label: string; paramsB: number; minB: number; example: string }> = [
  { id: "4b", label: "Small (up to 4B)", paramsB: 4, minB: 0, example: "qwen3.5:4b" },
  { id: "9b", label: "Medium (7–9B)", paramsB: 9, minB: 4.01, example: "qwen3.5:9b" },
  { id: "16b", label: "Large (10–16B)", paramsB: 16, minB: 9.01, example: "deepseek-r1:14b" },
  { id: "35b", label: "XL (20–35B)", paramsB: 30, minB: 16.01, example: "qwen3-coder:30b" },
  { id: "80b", label: "XXL (36–80B)", paramsB: 70, minB: 35.01, example: "llama3.3:70b" },
];

/**
 * A copy of src/economy/job-pricing.ts TOKEN_PRICE_USD_PER_M (USD per million tokens by model
 * size; the test checks they match), used only when the network does not list a model of a class.
 */
export const FALLBACK_TOKEN_PRICES: Array<{ maxB: number; input: number; output: number }> = [
  { maxB: 2, input: 0.01, output: 0.03 },
  { maxB: 4, input: 0.02, output: 0.05 },
  { maxB: 9, input: 0.04, output: 0.1 },
  { maxB: 16, input: 0.07, output: 0.2 },
  { maxB: 35, input: 0.57, output: 1.66 },
  { maxB: 80, input: 1.43, output: 3.8 },
  { maxB: 1e9, input: 2.85, output: 7.11 },
];

/** A typical agent call, measured 2026-11-16 (qwen3-coder:30b under vLLM): tokens in and out. */
export const TYPICAL_CALL = { input: 8287, output: 134 };

/** Model suggestions by hardware (all tool-capable, so agents can use them). */
export const MODEL_SUGGESTIONS: Array<{ model: string; label: string; reason: string }> = [
  { model: "qwen3-coder:30b", label: "Qwen3-Coder 30B (19 GB)", reason: "Your GPU or 32 GB+ Mac can run a 30B coder: the best local model for agents." },
  { model: "qwen3.5:9b", label: "Qwen3.5 9B (6.6 GB)", reason: "16 GB or more: a 7–9B model is quick and can use tools." },
  { model: "qwen3.5:4b", label: "Qwen3.5 4B (3.4 GB)", reason: "8 GB: a small model that still uses tools. Send bigger jobs to the network." },
  { model: "qwen3.5:2b", label: "Qwen3.5 2B (2.7 GB)", reason: "Under 8 GB: a tiny model for quick tasks. Send the rest to the network." },
];

export const INSTALL_LINKS = {
  releases: "https://github.com/codyrs82/Edgecoder/releases/latest",
  mac: "https://github.com/codyrs82/Edgecoder/releases/latest/download/EdgeCoder_aarch64.dmg",
  windows: "https://github.com/codyrs82/Edgecoder/releases/latest/download/EdgeCoder_x64-setup.exe",
  installDoc: "https://github.com/codyrs82/Edgecoder/blob/main/docs/install.md",
  enginesDoc: "https://github.com/codyrs82/Edgecoder/blob/main/docs/inference-engines.md",
  terminalDoc: "https://github.com/codyrs82/Edgecoder/blob/main/docs/terminal.md",
  apiDoc: "https://github.com/codyrs82/Edgecoder/blob/main/docs/API.md",
  computeDoc: "https://github.com/codyrs82/Edgecoder/blob/main/docs/using-compute.md",
  gettingStartedDoc: "https://github.com/codyrs82/Edgecoder/blob/main/docs/getting-started.md",
  // The docs site (site-docs/guide/cloud-gpu-server.md); GitHub Pages redirects it to docs.edgecoder.io.
  serverGuide: "https://codyrs82.github.io/Edgecoder/guide/cloud-gpu-server",
  fundGuide: "https://codyrs82.github.io/Edgecoder/guide/buy-csats",
};

/**
 * "Fund your account": how to buy cSats, in order. No word "invoice": the Wallet page calls it a
 * payment code. The wallet list is examples only (no links, no endorsement).
 */
export const FUND_STEPS: Array<{ title: string; body: string }> = [
  { title: "Choose an amount.", body: "Open Settings → Wallet and pick 5,000, 20,000 or 100,000 sats, or type your own (100 to 1,000,000). The page shows about how many calls it buys." },
  { title: "Pay with Lightning.", body: "Scan the QR code with your wallet, or press Copy payment code and paste it into your wallet. A code works for 15 minutes; if it runs out, nothing is charged: just make a new one." },
  { title: "No bitcoin yet?", body: "Any Lightning wallet works. For example Cash App, Strike, Wallet of Satoshi, Phoenix, or an exchange that can send over Lightning: buy a small amount of bitcoin there, then pay from it." },
  { title: "Wait a few seconds.", body: "Your balance updates by itself once the payment lands, and “Your balance is above zero” below ticks." },
];

/** The model class the "what 1,000 cSats buys" line uses (a 30B coder). */
export const FUND_EXAMPLE_CLASS = "35b";

/** "Add your other machines" on a Linux or cloud GPU server: the SSH line and the vLLM switch. */
export const SERVER_SETUP = {
  sshCommand: "ssh ubuntu@your-server-ip",
  vllmCommand: "sudo edgecoder-install apply --vllm-profile auto",
  keyPlaceholder: "YOUR_INSTALL_KEY",
  guideTitle: "Run EdgeCoder on a cloud GPU or Linux server",
};

/** Text for the "add your other machines" step. */
export const LOCAL_NETWORK_NOTE =
  "On a Mac, allow Local Network access when macOS asks. EdgeCoder uses it to find your other machines on the same network and reach them directly. You can change it in System Settings → Privacy & Security → Local Network.";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "welcome",
    title: "Welcome to EdgeCoder",
    body: "EdgeCoder runs AI models on your own machines for free, or on the network for cSats. What do you want to do?",
    checklist: [{ id: "goal", label: "Choose what you want to do", input: true }],
    actions: [],
    skip: null,
    goals: [],
    video: NO_VIDEO,
  },
  {
    id: "how",
    title: "How EdgeCoder works",
    body: "Five things to know before you start.",
    checklist: [],
    actions: [],
    skip: null,
    goals: [],
    video: { src: "/assets/videos/how-it-works.mp4", poster: "/assets/videos/how-it-works.jpg", captions: "/assets/videos/how-it-works.vtt" },
  },
  {
    id: "this-machine",
    title: "Set up this computer",
    body: "The desktop app runs the agent and Ollama for you, and updates itself. Pick a model sized for this computer.",
    checklist: [
      { id: "local-model", label: "A model is installed on this computer", surface: "desktop" },
      { id: "machine-linked", label: "A machine is connected to your account" },
    ],
    actions: [
      { id: "pull", label: "Download the suggested model", desktop: "run:pull-model", primary: true },
      { id: "models", label: "All models", desktop: "settings:models" },
      { id: "mac", label: "Download for Mac", web: "@mac", primary: true },
      { id: "windows", label: "Download for Windows", web: "@windows" },
      { id: "releases", label: "All downloads", web: "@releases" },
    ],
    skip: "Skip for now",
    goals: [],
    video: { src: "/assets/videos/this-machine.mp4", poster: "/assets/videos/this-machine.jpg", captions: "/assets/videos/this-machine.vtt" },
  },
  {
    id: "machines",
    title: "Add your other machines",
    body: "Every machine you own adds free compute for you. Mac and Windows: install the desktop app and sign in. Linux and GPU servers, including rented cloud GPUs: connect with SSH and run the installer.",
    checklist: [
      { id: "second-machine", label: "A second machine is connected" },
      { id: "machine-online", label: "At least one machine is online", optional: true },
    ],
    actions: [
      { id: "server-guide", label: "Full guide: cloud GPU or Linux server", web: "@serverGuide", desktop: "@serverGuide", primary: true },
      { id: "nodes", label: "Your nodes", web: "/portal/settings/nodes", desktop: "/portal/settings/nodes" },
      { id: "network", label: "See your machines", desktop: "settings:mesh", web: "/portal/settings/world" },
    ],
    skip: "I only have this computer",
    goals: ["own", "both", "host"],
    video: { src: "/assets/videos/machines.mp4", poster: "/assets/videos/machines.jpg", captions: "/assets/videos/machines.vtt" },
  },
  {
    id: "models",
    title: "Choose models and where they run",
    body: "Auto suits most people. Agents (Code, bits) need tool-capable models; the app only gives them those.",
    checklist: [{ id: "routing", label: "Choose where things run", input: true }],
    actions: [
      { id: "models", label: "Manage models", desktop: "settings:models", web: "/portal/settings/nodes" },
      { id: "frontier", label: "Add your own frontier key", desktop: "settings:general" },
    ],
    skip: "Keep Auto",
    goals: [],
    video: { src: "/assets/videos/models.mp4", poster: "/assets/videos/models.jpg", captions: "/assets/videos/models.vtt" },
  },
  {
    id: "fund",
    title: "Fund your account",
    body: "Your own machines are free. Calls on the network use cSats: prepaid credit, spent per token (1 cSat = 1 sat). Reserving a machine comes out of the same balance.",
    checklist: [{ id: "funded", label: "Your balance is above zero" }],
    actions: [
      { id: "buy", label: "Buy cSats for on-demand compute", desktop: "settings:plan", web: "/portal/settings/plan", primary: true },
      { id: "reserve", label: "Reserve a machine", desktop: "settings:compute", web: "/portal/settings/compute#sec-reservations" },
      { id: "direct", label: "Connect a wallet to pay hosts directly for reservations", desktop: "settings:plan", web: "/portal/settings/plan#reservations-direct", needs: "directReservations" },
      { id: "payout", label: "Hosting? Set your payout addresses", desktop: "settings:plan", web: "/portal/settings/plan#payout-addresses" },
      { id: "fund-guide", label: "Guide: buy cSats", desktop: "@fundGuide", web: "@fundGuide" },
    ],
    skip: "Skip: I'll use my own machines",
    goals: [],
    video: { src: "/assets/videos/fund.mp4", poster: "/assets/videos/fund.jpg", captions: "/assets/videos/fund.vtt" },
  },
  {
    id: "tools",
    title: "Connect your tools",
    body: "Use EdgeCoder from GitHub, your editor, the terminal and your own scripts.",
    checklist: [
      { id: "github", label: "GitHub connected", optional: true },
      { id: "api-key", label: "An API key for the hosted API", optional: true },
      { id: "cli", label: "The edgecoder command is installed", optional: true, surface: "desktop" },
    ],
    actions: [
      { id: "github", label: "Connect GitHub", desktop: "settings:integrations", web: "/portal/settings#profile" },
      { id: "api-key", label: "Create an API key", desktop: "/portal/settings#tools", web: "/portal/settings#tools" },
      { id: "connections", label: "Editor connections", desktop: "settings:connect" },
      { id: "cli", label: "Install command-line tool", desktop: "run:install-cli" },
    ],
    skip: "Skip for now",
    goals: [],
    video: { src: "/assets/videos/tools.mp4", poster: "/assets/videos/tools.jpg", captions: "/assets/videos/tools.vtt" },
  },
  {
    id: "try",
    title: "Try it",
    body: "Ask for something small. Each reply says where it ran and what it cost.",
    checklist: [{ id: "first-task", label: "Your first task finished" }],
    actions: [
      { id: "chat", label: "Ask in Chat", desktop: "run:try-chat", web: "/portal/chat?new=1", primary: true },
      { id: "code", label: "Explain a file in Code", desktop: "run:open-code" },
      { id: "bot", label: "Create a bit", desktop: "run:new-bot" },
    ],
    skip: "Skip",
    goals: [],
    video: { src: "/assets/videos/try.mp4", poster: "/assets/videos/try.jpg", captions: "/assets/videos/try.vtt" },
  },
  {
    id: "host",
    title: "Host for the network",
    body: "Hosts earn 95% of what their machines' calls cost. Hosting is by request: send the form and an admin reviews it. Until then your machines run only your own work.",
    checklist: [
      { id: "host-requested", label: "Request sent", optional: true },
      { id: "host-approved", label: "Approved to host" },
    ],
    actions: [{ id: "request", label: "Request to host", desktop: "/host", web: "/host", primary: true }],
    skip: "Not now",
    goals: [],
    video: NO_VIDEO,
  },
  {
    id: "done",
    title: "You're set",
    body: "Here is what's ready. You can reopen this guide from Settings → Getting started.",
    checklist: [],
    actions: [{ id: "guide", label: "Read the full guide", desktop: "@gettingStartedDoc", web: "@gettingStartedDoc" }],
    skip: null,
    goals: [],
    video: NO_VIDEO,
  },
];

export const STEP_IDS: StepId[] = ["welcome", "how", "this-machine", "machines", "models", "fund", "tools", "try", "host", "done"];
export const GOAL_IDS: OnboardingGoal[] = ["own", "buy", "both", "host"];
export const ROUTING_IDS: RoutingPolicy[] = ["auto", "local_first", "local_only", "mine_only", "model"];

// ── State ──

export function emptyOnboardingState(nowMs: number): OnboardingState {
  return { goal: null, done: [], skipped: [], current: "welcome", routing: null, dismissed: false, completedAtMs: null, firstSeenAtMs: null, firstTaskAtMs: null, updatedAtMs: nowMs };
}

/** Accepts a saved or client-sent state and keeps only known values. */
export function normalizeOnboardingState(raw: unknown, nowMs: number): OnboardingState {
  const base = emptyOnboardingState(nowMs);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const ids = (v: unknown): StepId[] => (Array.isArray(v) ? STEP_IDS.filter((id) => v.indexOf(id) >= 0) : []);
  const ms = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
  return {
    goal: GOAL_IDS.indexOf(r.goal as OnboardingGoal) >= 0 ? (r.goal as OnboardingGoal) : null,
    done: ids(r.done),
    skipped: ids(r.skipped),
    current: STEP_IDS.indexOf(r.current as StepId) >= 0 ? (r.current as StepId) : "welcome",
    routing: ROUTING_IDS.indexOf(r.routing as RoutingPolicy) >= 0 ? (r.routing as RoutingPolicy) : null,
    dismissed: r.dismissed === true,
    completedAtMs: ms(r.completedAtMs),
    firstSeenAtMs: ms(r.firstSeenAtMs),
    firstTaskAtMs: ms(r.firstTaskAtMs),
    updatedAtMs: ms(r.updatedAtMs) ?? nowMs,
  };
}

// ── Steps and completion ──

export function stepById(id: StepId): OnboardingStep {
  return ONBOARDING_STEPS.find((s) => s.id === id) ?? ONBOARDING_STEPS[0];
}

/** The steps for a goal, in order (all of them before a goal is chosen). */
export function stepsFor(goal: OnboardingGoal | null): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((s) => !goal || s.goals.length === 0 || s.goals.indexOf(goal) >= 0);
}

export function checklistFor(step: OnboardingStep, surface: Surface): ChecklistItem[] {
  return step.checklist.filter((c) => !c.surface || c.surface === surface);
}

/** The checklist rows shown under a step: its items on this surface, less the ones its input answers. */
export function shownChecklist(step: OnboardingStep, surface: Surface): ChecklistItem[] {
  return checklistFor(step, surface).filter((c) => !c.input);
}

/** Whether one checklist item is done: true, false, or null when this surface can't tell. */
export function itemDone(itemId: string, signals: OnboardingSignals, state: OnboardingState): boolean | null {
  const atLeast = (n: number | null, min: number): boolean | null => (n === null ? null : n >= min);
  switch (itemId) {
    case "goal":
      return state.goal !== null;
    case "local-model":
      return atLeast(signals.localModels, 1);
    case "machine-linked":
      return atLeast(signals.machines, 1);
    case "second-machine":
      return atLeast(signals.machines, 2);
    case "machine-online":
      return atLeast(signals.machinesOnline, 1);
    case "routing":
      return state.routing !== null;
    case "funded":
      return signals.balanceCSats === null ? null : signals.balanceCSats > 0;
    case "github":
      return signals.github;
    case "api-key":
      return atLeast(signals.apiKeys, 1);
    case "cli":
      return signals.cliInstalled;
    case "first-task":
      return state.firstTaskAtMs !== null ? true : signals.firstTask;
    case "host-requested":
      return signals.hostApproved === true ? true : signals.hostRequested;
    case "host-approved":
      return signals.hostApproved;
    default:
      return null;
  }
}

/**
 * A step is complete when every required item on this surface is done (items this surface can't
 * check don't block), or, for a step without required items, when the person moved past it.
 */
export function stepComplete(step: OnboardingStep, signals: OnboardingSignals, state: OnboardingState, surface: Surface): boolean {
  const required = checklistFor(step, surface).filter((c) => !c.optional);
  const known = required.map((c) => itemDone(c.id, signals, state)).filter((v) => v !== null);
  if (known.length === 0) return state.done.indexOf(step.id) >= 0;
  return known.every((v) => v === true);
}

export interface StepProgress {
  id: StepId;
  complete: boolean;
  skipped: boolean;
  /** The person moved past it (Next or Skip). A complete step they haven't reached reads quieter. */
  visited: boolean;
}

export function progressFor(state: OnboardingState, signals: OnboardingSignals, surface: Surface): { steps: StepProgress[]; completed: number; total: number; index: number } {
  const steps = stepsFor(state.goal).map((s) => ({ id: s.id, complete: stepComplete(s, signals, state, surface), skipped: state.skipped.indexOf(s.id) >= 0, visited: state.done.indexOf(s.id) >= 0 || state.skipped.indexOf(s.id) >= 0 }));
  const index = Math.max(0, steps.findIndex((s) => s.id === state.current));
  return { steps, completed: steps.filter((s) => s.complete).length, total: steps.length, index };
}

/** The step after `current` for this goal; null at the end. */
export function nextStepId(current: StepId, goal: OnboardingGoal | null): StepId | null {
  const ids = stepsFor(goal).map((s) => s.id);
  const i = ids.indexOf(current);
  return i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
}

export function prevStepId(current: StepId, goal: OnboardingGoal | null): StepId | null {
  const ids = stepsFor(goal).map((s) => s.id);
  const i = ids.indexOf(current);
  return i > 0 ? ids[i - 1] : null;
}

/**
 * Whether to open the wizard by itself: never once dismissed or finished; while in progress, yes
 * (it resumes); never seen, on a new account or one with no machines and no funding.
 */
export function shouldShowOnboarding(state: OnboardingState | null, signals: OnboardingSignals): boolean {
  if (state && (state.dismissed || state.completedAtMs !== null)) return false;
  if (state && state.firstSeenAtMs !== null) return true;
  if (signals.newAccount === true) return true;
  return (signals.machines ?? 0) === 0 && (signals.balanceCSats ?? 0) <= 0;
}

/** A step's buttons on a surface, without those whose payment path is off (or not known yet). */
export function actionsFor(step: OnboardingStep, surface: Surface, paths: PaymentPathFlags | null): StepAction[] {
  return step.actions.filter((a) => !!(surface === "web" ? a.web : a.desktop) && (!a.needs || (!!paths && paths[a.needs] === true)));
}

/** Whether a Bitcoin network name is a test network: true / false, or null when not known. */
export function isTestNetwork(network: string | null | undefined): boolean | null {
  if (!network) return null;
  return !(network === "bitcoin" || network === "mainnet");
}

/** The fund step's test-network note, or null on mainnet (or while the network is not known). */
export function testNetworkNote(network: string | null | undefined): string | null {
  if (isTestNetwork(network) !== true) return null;
  if (network === "signet") return "Test network: use free test sats from faucet.mutinynet.com. Paste the payment code there; real bitcoin wallets can't pay it.";
  return "Test network (" + network + "): pay with test sats. They have no value.";
}

/** About how many typical calls an amount of cSats buys on a model class; null without prices. */
export function callsForCSats(cSats: number, classId: string, live: { models?: Array<{ model: string; cSatsPerMTokens?: { input: number; output: number } }> | null; btcUsd?: number | null }): number | null {
  const p = classPrice(classId, live);
  if (!p) return null;
  const per = cSatsPerCall(p);
  return per > 0 ? Math.floor(Math.max(0, cSats) / per) : null;
}

/** The suggested Skip for the fund step: people who use only their own machines pay nothing. */
export function fundingOptional(goal: OnboardingGoal | null): boolean {
  return goal === "own" || goal === "host";
}

// ── Model suggestion ──

/** A model for a machine: a 30B on a GPU or a 32 GB+ Mac, 7–9B on 16 GB, smaller below. */
export function suggestModel(hw: { ramGb: number | null; computeClass: string | null }): { model: string; label: string; reason: string } {
  const ram = hw.ramGb ?? 0;
  const cls = hw.computeClass ?? "";
  if (cls === "gpu" || cls === "gpu.dc" || (cls === "apple" && ram >= 32)) return MODEL_SUGGESTIONS[0];
  if (ram >= 16) return MODEL_SUGGESTIONS[1];
  if (ram >= 8) return MODEL_SUGGESTIONS[2];
  return MODEL_SUGGESTIONS[3];
}

// ── Cost estimator ──

/** Billions of parameters from a model name ("qwen3-coder:30b" → 30); null when it doesn't say. */
export function paramsFromModel(model: string): number | null {
  const m = /[:\-_](\d+(?:\.\d+)?)b\b/i.exec(model);
  return m ? Number(m[1]) : null;
}

/** USD per million tokens to cSats per million tokens at a BTC price. */
export function usdPerMToCSats(usd: number, btcUsd: number): number {
  return btcUsd > 0 ? (usd / btcUsd) * 1e8 : 0;
}

/**
 * cSats per million tokens for a model class: a live network model of that size when listed
 * (its coordinator price), else the reference price at the live BTC rate. null without either.
 */
export function classPrice(
  classId: string,
  live: { models?: Array<{ model: string; cSatsPerMTokens?: { input: number; output: number } }> | null; btcUsd?: number | null },
): { input: number; output: number; source: "network" | "reference" } | null {
  const cls = MODEL_CLASSES.find((c) => c.id === classId);
  if (!cls) return null;
  const maxB = cls.id === "80b" ? 80 : FALLBACK_TOKEN_PRICES.find((p) => p.maxB >= cls.paramsB)?.maxB ?? cls.paramsB;
  for (const m of live.models ?? []) {
    const b = paramsFromModel(m.model);
    if (b !== null && b >= cls.minB && b <= maxB && m.cSatsPerMTokens && m.cSatsPerMTokens.input > 0) return { input: m.cSatsPerMTokens.input, output: m.cSatsPerMTokens.output, source: "network" };
  }
  const btc = live.btcUsd ?? 0;
  if (!(btc > 0)) return null;
  const row = FALLBACK_TOKEN_PRICES.find((p) => cls.paramsB <= p.maxB) ?? FALLBACK_TOKEN_PRICES[FALLBACK_TOKEN_PRICES.length - 1];
  return { input: usdPerMToCSats(row.input, btc), output: usdPerMToCSats(row.output, btc), source: "reference" };
}

/** cSats for one typical call at a price per million tokens. */
export function cSatsPerCall(price: { input: number; output: number }): number {
  return (TYPICAL_CALL.input * price.input + TYPICAL_CALL.output * price.output) / 1e6;
}

/** "About N calls per 1,000 cSats". */
export function callsPerThousand(perCall: number): number {
  return perCall > 0 ? Math.floor(1000 / perCall) : 0;
}

/** cSats for `callsPerDay` typical calls over `days`, rounded up to a whole cSat. */
export function estimateCSats(callsPerDay: number, perCall: number, days: number): number {
  return Math.ceil(Math.max(0, callsPerDay) * Math.max(0, perCall) * Math.max(0, days));
}

/** Whole number with thousands separators (no locale: the same on server and client). */
export function groupThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── Commands shown in the wizard ──

/** The Linux / macOS installer line for a portal (the token comes from Settings → Nodes). */
export function installCommand(portalUrl: string, token: string): string {
  const base = portalUrl.replace(/\/+$/, "");
  return `curl -fsSLo install.sh ${base}/install.sh && sudo bash install.sh --token ${token}`;
}

/**
 * The installer line for a server, with an install key (an API key, Settings → Connect your tools):
 * the installer enrols one node per GPU with it (edgecoder-install --enroll / EDGECODER_API_KEY), so
 * no node id has to match. The key goes in the environment, not argv (the process list).
 * --pull-models downloads each agent's Ollama model, so the machine works before any vLLM switch.
 */
export function serverInstallCommand(portalUrl: string, apiKey: string): string {
  const base = portalUrl.replace(/\/+$/, "");
  return `curl -fsSLo install.sh ${base}/install.sh && sudo EDGECODER_API_KEY=${apiKey} bash install.sh --pull-models`;
}

/** Editor setup for the app's local provider (this computer only; Cursor uses the hosted API). */
export function localProviderSnippet(apiKey: string): string {
  return `Base URL:  http://localhost:4304/v1\nAPI key:   ${apiKey}\nModel:     auto`;
}

/** The hosted OpenAI-compatible API, called with an API key from Settings. */
export function hostedApiSnippet(portalUrl: string): string {
  const base = portalUrl.replace(/\/+$/, "");
  return `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer $EDGECODER_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`;
}

/** A link target from a step action: "@key" names an INSTALL_LINKS entry. */
export function actionHref(target: string): string {
  if (target.charAt(0) !== "@") return target;
  const links = INSTALL_LINKS as Record<string, string>;
  return links[target.slice(1)] ?? target;
}

/** The stable route of a step on each surface (for links and the explainer videos). */
export function stepRoute(id: StepId, surface: Surface): string {
  return surface === "web" ? `/portal/welcome/${id}` : `#/welcome/${id}`;
}

/** The step a route names, or null. */
export function stepFromRoute(route: string): StepId | null {
  const m = /(?:^|\/|#)welcome\/([a-z-]+)\/?$/.exec(route);
  return m && STEP_IDS.indexOf(m[1] as StepId) >= 0 ? (m[1] as StepId) : null;
}

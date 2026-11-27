// #29: every page and overlay is run through axe-core in jsdom, so the audit runs with the
// component tests (`npm run test:components`) and needs no browser. jsdom has no layout or
// painting, which leaves colour contrast and anything about size or overflow to the Playwright
// run (a11y/axe.spec.ts, `npm run test:a11y`).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import axe from "axe-core";
import type { Component } from "svelte";
import { fixtureFor, NOT_FOUND, SECTION_SHOWS } from "../a11y/fixtures";

// api.ts looks for the local agent the moment it is imported, so the stand-in for the network
// has to exist before any import runs; nothing here may reach a real port.
const backend = vi.hoisted(() => {
  const backend = { answer: (_url: string, _method: string): { status: number; body: unknown } => ({ status: 200, body: {} }) };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = backend.answer(String(input instanceof Request ? input.url : input), init?.method ?? "GET");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return backend;
});

// Outside the desktop shell every command fails, as in a browser; the token answers at once so
// api.ts does not spend a second retrying for it.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "get_local_token") return "a11y-token";
    throw new Error("not running in the desktop shell");
  },
}));

const USER = { userId: "u_a11y", email: "a11y@example.org", displayName: "A11y", emailVerified: true };
const CONVERSATION = { id: "c1", title: "Seeded chat", messages: [], createdAt: 0, updatedAt: 0, source: "chat" as const };

// IndexedDB is not in jsdom; the sidebar only needs a list to draw.
vi.mock("../src/lib/chat-store", async (original) => ({
  ...(await original<typeof import("../src/lib/chat-store")>()),
  listConversationsBySource: vi.fn(async () => [CONVERSATION]),
  listConversations: vi.fn(async () => [CONVERSATION]),
  loadConversation: vi.fn(async () => undefined),
  saveConversation: vi.fn(async () => undefined),
}));

// Monaco needs a real layout engine. Its own DOM is third-party and is exercised in the browser
// run; here an inert stand-in lets the screens around it (editor view, diff dialog) be audited.
vi.mock("monaco-editor", () => {
  const inert: unknown = new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : inert),
    apply: () => inert,
  });
  const editor = { create: () => inert, createDiffEditor: () => inert, createModel: () => inert, getModel: () => null, defineTheme() {}, setTheme() {}, setModelMarkers() {}, getModelMarkers: () => [] };
  return {
    editor, typescript: undefined, languages: inert, Uri: { from: () => inert },
    KeyMod: { CtrlCmd: 0, WinCtrl: 0 }, KeyCode: { KeyS: 0, KeyW: 0, KeyP: 0, Backquote: 0 }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  };
});

// jsdom has no Element.scrollTo (chat views scroll to the newest message).
Element.prototype.scrollTo ??= function () {};

// axe draws text on a canvas to tell icon-font ligatures from words, and jsdom has no canvas.
// Icons here are SVG, so a context on which every string paints alike gives the right answer.
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return {
    canvas: this,
    measureText: (text: string) => ({ width: 10 * text.length }),
    fillText() {},
    clearRect() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, Math.ceil(w) * Math.ceil(h)) * 4).fill(255) }),
  };
} as unknown as HTMLCanvasElement["getContext"];

import LoginScreen from "../src/pages/LoginScreen.svelte";
import ChatView from "../src/pages/ChatView.svelte";
import Settings from "../src/pages/Settings.svelte";
import Account from "../src/pages/Account.svelte";
import PlanUsage from "../src/pages/PlanUsage.svelte";
import Usage from "../src/pages/Usage.svelte";
import ComputeMarket from "../src/pages/ComputeMarket.svelte";
import Connections from "../src/pages/Connections.svelte";
import ModelManager from "../src/pages/ModelManager.svelte";
import Integrations from "../src/pages/Integrations.svelte";
import MeshTopology from "../src/pages/MeshTopology.svelte";
import Dashboard from "../src/pages/Dashboard.svelte";
import ActiveWork from "../src/pages/ActiveWork.svelte";
import TaskQueue from "../src/pages/TaskQueue.svelte";
import LogViewer from "../src/pages/LogViewer.svelte";
import BotView from "../src/pages/BotView.svelte";
import EditorView from "../src/pages/EditorView.svelte";
import DiffModal from "../src/components/DiffModal.svelte";
import SettingsOverlay from "../src/components/SettingsOverlay.svelte";
import OnboardingWizard from "../src/components/OnboardingWizard.svelte";
import GettingStarted from "../src/pages/GettingStarted.svelte";
import BotForm from "../src/components/BotForm.svelte";
import QuickOpen from "../src/components/QuickOpen.svelte";
import ComputePicker from "../src/components/ComputePicker.svelte";
import LocalComputeSetup from "../src/components/LocalComputeSetup.svelte";
import ConversationSidebar from "../src/components/ConversationSidebar.svelte";
import EditorChatPanel from "../src/components/EditorChatPanel.svelte";
import TabSwitcher from "../src/components/TabSwitcher.svelte";
import Toaster from "../src/components/ui/Toaster.svelte";
import { notify } from "../src/lib/toast";
import type { Bot } from "../src/lib/bots";
import type { ComponentStatus, ComputeStatus } from "../src/lib/local-compute";

const BOT: Bot = {
  id: "bot_a11y", name: "Harry", role: "Engineer", instructions: "", projectRoot: "/Users/a11y/EdgeCoder/harry",
  enabled: true, schedule: "every 30 minutes", budgetCSatsPerDay: 100, allowedTools: [], autoApproveEdits: true,
  compute: { policy: "local_first" }, color: "#0090ff", createdAtMs: 0, updatedAtMs: 0,
  status: "idle", spentTodayCSats: 12, pending: [], queuedMessages: 0,
};

const STEP: ComponentStatus = { state: "downloading", source: "", version: "", detail: "Downloading", activity: "", downloaded: 50, total: 200, error: null, required: true };
const SETUP: ComputeStatus = { managed: true, state: "running", ollama: STEP, docker: { ...STEP, state: "pending" }, ollama_url: "http://127.0.0.1:11434", docker_host: null };

// Vitest runs in dev mode, where api.ts calls the Vite proxy paths; the fixtures are keyed on
// the addresses a built app calls.
const DEV_PROXY: Array<[RegExp, string]> = [
  [/^\/api\//, "http://127.0.0.1:4301/"],
  [/^\/inference\//, "http://127.0.0.1:4302/"],
  [/^\/ollama\//, "http://127.0.0.1:11434/"],
  [/^\/chat\//, "http://127.0.0.1:4304/"],
];

/** The same canned backend the Playwright run uses, so pages are audited with content in them. */
backend.answer = (requested, method) => {
  let url = requested;
  for (const [prefix, origin] of DEV_PROXY) url = url.replace(prefix, origin);
  if (/\/me(\?|$)/.test(url)) return { status: 200, body: { user: USER } };
  const body = method === "GET" ? fixtureFor(url) : {};
  return body === NOT_FOUND ? { status: 404, body: { error: "not_found" } } : { status: 200, body };
};

/**
 * Pages fetch on mount and swap placeholders for content; audit what they settle on. `shows` is
 * text from the loaded state, so a page that fell back to an empty or error state fails here
 * instead of passing an audit of nothing.
 */
async function settled(shows: string) {
  await waitFor(() => {
    expect(document.querySelector(".skeleton-line")).toBeNull();
    expect((document.body.textContent ?? "").replace(/\s+/g, " ")).toContain(shows);
  }, { timeout: 4000 });
  await new Promise((r) => setTimeout(r, 50));
}

async function audit() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    // Needs computed colours and geometry, which jsdom does not have.
    rules: { "color-contrast": { enabled: false } },
  });
  const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(blocking.map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Case = [name: string, shows: string, component: Component<any>, props: Record<string, unknown>];
const noop = () => {};

const PAGES: Case[] = [
  ["Login", "Sign In", LoginScreen, { onLogin: noop }],
  ["Chat", "What would you like to build?", ChatView, {}],
  ["Settings: Getting started", SECTION_SHOWS["Getting started"], GettingStarted, { onOpenGuide: noop }],
  ["Settings: General", SECTION_SHOWS["General"], Settings, {}],
  ["Settings: Profile", SECTION_SHOWS["Profile"], Account, { user: USER, onLogout: noop }],
  ["Settings: Wallet", SECTION_SHOWS["Wallet"], PlanUsage, {}],
  ["Settings: Usage", SECTION_SHOWS["Usage"], Usage, {}],
  ["Settings: Compute", SECTION_SHOWS["Compute"], ComputeMarket, {}],
  ["Settings: Connect your tools", SECTION_SHOWS["Connect your tools"], Connections, {}],
  ["Settings: Models", SECTION_SHOWS["Models"], ModelManager, {}],
  ["Settings: Integrations", SECTION_SHOWS["Integrations"], Integrations, {}],
  ["Settings: Network", SECTION_SHOWS["Network"], MeshTopology, {}],
  ["Settings: Dashboard", SECTION_SHOWS["Dashboard"], Dashboard, {}],
  ["Settings: Active work", SECTION_SHOWS["Active work"], ActiveWork, {}],
  ["Settings: Tasks", SECTION_SHOWS["Tasks"], TaskQueue, {}],
  ["Settings: Logs", SECTION_SHOWS["Logs"], LogViewer, {}],
  ["Bot", "Tidy the README", BotView, { bot: BOT, onEdit: noop, onDeleted: noop }],
  ["Conversation sidebar", "Seeded chat", ConversationSidebar, { open: true, inline: true, onClose: noop, onSelectConversation: noop, onNewChat: noop, activeConversationId: "c1", user: USER, onOpenSettings: noop, onLogout: noop }],
  ["Editor chat panel", "Pick a project to start", EditorChatPanel, {}],
  ["Editor chat panel in a project", "a11y/demo", EditorChatPanel, { projectRoot: "/Users/a11y/EdgeCoder/demo" }],
  ["Editor", "Pick a project to start", EditorView, { projectRoot: null }],
];

const OVERLAYS: Case[] = [
  ["Settings dialog", SECTION_SHOWS["General"], SettingsOverlay, { user: USER, onClose: noop, onLogout: noop }],
  ["Getting started guide", "Choose models and where they run", OnboardingWizard, { onClose: noop, onOpenSettings: noop, onRun: noop }],
  ["Bot form", "New bit", BotForm, { onClose: noop, onSaved: noop }],
  ["Quick open", "Type to search the project", QuickOpen, { onOpen: noop, onClose: noop }],
  ["Diff", "Undo this file", DiffModal, { path: "src/app.ts", before: "let a = 1;\n", after: "let a = 2;\n", onClose: noop, onUndo: noop }],
  ["Local compute setup", "Setting up local compute", LocalComputeSetup, { status: SETUP, onStatus: noop, onDismiss: noop }],
];

afterEach(() => cleanup());

describe("axe: pages (#29)", () => {
  it.each(PAGES)("%s", async (_name, shows, component, props) => {
    render(component, props);
    await settled(shows);
    await audit();
  });

  it("View switcher", async () => {
    // The tabs name panels that App.svelte renders; stand in for them here.
    for (const id of ["chat", "editor"]) {
      const panel = document.createElement("div");
      panel.id = `view-${id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `view-tab-${id}`);
      document.body.append(panel);
    }
    render(TabSwitcher, { activeTab: "chat", onSwitch: noop });
    await audit();
    document.querySelectorAll("body > [role=tabpanel]").forEach((el) => el.remove());
  });
});

describe("axe: overlays (#29)", () => {
  it.each(OVERLAYS)("%s", async (_name, shows, component, props) => {
    render(component, props);
    await screen.findByRole("dialog");
    await settled(shows);
    await audit();
  });

  it("Model and compute picker", async () => {
    render(ComputePicker, { selected: undefined, onSelect: noop });
    await fireEvent.click(screen.getByRole("button", { name: /Auto/ }));
    await screen.findByRole("combobox", { name: "Search models" });
    await settled("deepseek-r1:32b");
    await audit();
  });

  it("Conversation menu", async () => {
    render(ConversationSidebar, { open: true, inline: true, onClose: noop, onSelectConversation: noop, onNewChat: noop, activeConversationId: null });
    await fireEvent.click(await screen.findByRole("button", { name: "More options for Seeded chat" }));
    await screen.findByRole("menu");
    await audit();
  });

  it("Account menu", async () => {
    render(ConversationSidebar, { open: true, inline: true, onClose: noop, onSelectConversation: noop, onNewChat: noop, activeConversationId: null, user: USER, onOpenSettings: noop, onLogout: noop });
    await fireEvent.click(await screen.findByTitle("Account menu"));
    await screen.findByRole("menu", { name: "Account" });
    await audit();
  });

  it("Toast", async () => {
    render(Toaster);
    notify("Settings saved");
    await screen.findByText("Settings saved");
    await audit();
  });
});

// With no project the Code view is one prompt (pick or create a project) and the chat takes the room.
describe("Code view with no project", () => {
  it("shows one prompt to pick or create a project, no composer and no editor or file panes", async () => {
    const onBareChange = vi.fn();
    const { container } = render(EditorView, { projectRoot: null, onBareChange });
    await screen.findByRole("heading", { name: "Pick a project to start" });
    expect(screen.getAllByRole("button", { name: /Open folder/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /New project/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clone from GitHub/ })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(container.querySelector(".explorer-panel")).toBeNull();
    expect(container.querySelector(".editor-panel")?.classList.contains("hidden")).toBe(true);
    expect(onBareChange).toHaveBeenLastCalledWith(true);
  });

  it("is chat first in a project, and brings the files and the editor in on the toggle", async () => {
    const onBareChange = vi.fn();
    const { container } = render(EditorView, { projectRoot: "/Users/a11y/EdgeCoder/demo", onBareChange });
    expect(await screen.findByRole("button", { name: /^Branch main/ })).toBeTruthy();
    expect(container.querySelector(".explorer-panel")).toBeNull();
    expect(onBareChange).toHaveBeenLastCalledWith(true);
    await fireEvent.click(screen.getByRole("button", { name: "Files and editor" }));
    await waitFor(() => expect(container.querySelector(".explorer-panel")).not.toBeNull());
    expect(container.querySelector(".editor-panel")?.classList.contains("hidden")).toBe(false);
    expect(screen.queryByRole("heading", { name: "Pick a project to start" })).toBeNull();
    expect(onBareChange).toHaveBeenLastCalledWith(false);
    localStorage.removeItem("edgecoder-workspace-open");
  });
});

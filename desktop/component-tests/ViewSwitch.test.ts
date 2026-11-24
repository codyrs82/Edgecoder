// The Chat / Code switch lives at the top of the open sidebar, directly above New chat; with the
// sidebar hidden it moves to the title bar, so there is always exactly one way to switch.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/svelte";
import axe from "axe-core";

vi.mock("../src/lib/chat-store", () => ({
  listConversationsBySource: vi.fn(async () => []),
  deleteConversation: vi.fn(async () => undefined),
  renameConversation: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/api", () => ({
  portalDeleteConversation: vi.fn(async () => undefined),
  portalRenameConversation: vi.fn(async () => undefined),
  computeOverview: vi.fn(async () => ({})),
  portalWebUrl: (p = "") => p,
}));

import Harness from "./fixtures/ViewSwitchHarness.svelte";
import { viewSwitchSpot, drivenRemotely } from "../src/lib/view-switch";
import type { SessionSummary } from "../src/lib/api";

afterEach(() => cleanup());

const tablists = () => screen.getAllByRole("tablist", { name: "View" });

describe("viewSwitchSpot", () => {
  it("puts the switch in the open view's sidebar, or the title bar when that sidebar is hidden", () => {
    expect(viewSwitchSpot("chat", true, false)).toBe("chat-sidebar");
    expect(viewSwitchSpot("chat", false, true)).toBe("titlebar");
    expect(viewSwitchSpot("editor", false, true)).toBe("code-sidebar");
    expect(viewSwitchSpot("editor", true, false)).toBe("titlebar");
  });
});

describe("the Chat / Code switch in the sidebar", () => {
  it("sits above New chat in the Chat sidebar, not in the title bar", () => {
    render(Harness, { view: "chat" });
    expect(tablists()).toHaveLength(1);
    expect(within(screen.getByTestId("titlebar")).queryByRole("tablist")).toBeNull();
    const side = screen.getByTestId("chat-side");
    const list = within(side).getByRole("tablist", { name: "View" });
    const newChat = within(side).getByRole("button", { name: "New chat" });
    expect(list.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-controls")).toBe("view-editor");
  });

  it("moves with the view: switching to Code shows it above New chat in the Code sidebar", async () => {
    render(Harness, { view: "chat" });
    await fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(tablists()).toHaveLength(1);
    const side = screen.getByTestId("code-side");
    const list = within(side).getByRole("tablist", { name: "View" });
    const newChat = within(side).getByRole("button", { name: /New chat/ });
    expect(list.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
  });

  it("passes axe in both places (named tabs, tablist semantics)", async () => {
    for (const props of [{ view: "chat" as const }, { view: "editor" as const, codeOpen: false }]) {
      render(Harness, props);
      const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
      cleanup();
    }
  });

  it("goes to the title bar while the sidebar is collapsed, still one switch", () => {
    render(Harness, { view: "editor", codeOpen: false });
    expect(tablists()).toHaveLength(1);
    expect(within(screen.getByTestId("titlebar")).getByRole("tablist", { name: "View" })).toBeTruthy();
    expect(screen.queryByTestId("sidebar-switch")).toBeNull();
    // The title bar still drags the window.
    expect(screen.getByTestId("titlebar").hasAttribute("data-tauri-drag-region")).toBe(true);
  });
});

describe("remote sessions in the Code sidebar", () => {
  const session = (over: Partial<SessionSummary>): SessionSummary => ({
    id: "s1", title: "Fix tests", projectRoot: "/Users/me/p", branch: null, model: "m", origin: "terminal", published: true,
    updatedAt: Date.now(), messages: 1, running: false, live: false, controller: null, clients: [], pending: 0, ...over,
  });

  it("knows a session driven from the phone or the web", () => {
    expect(drivenRemotely(session({}))).toBe(false);
    expect(drivenRemotely(session({ controller: { clientId: "c", kind: "remote" } }))).toBe(true);
    expect(drivenRemotely(session({ clients: [{ clientId: "c", kind: "terminal" }, { clientId: "d", kind: "remote" }] }))).toBe(true);
  });

  it("marks it with the remote-computer icon instead of the terminal one", () => {
    render(Harness, {
      view: "editor",
      liveSessions: [session({ id: "a", title: "From the phone", controller: { clientId: "c", kind: "remote" } }), session({ id: "b", title: "From the terminal" })],
    });
    const remote = document.querySelector('[data-session-id="a"]')!;
    const local = document.querySelector('[data-session-id="b"]')!;
    expect(remote.hasAttribute("data-remote")).toBe(true);
    expect(remote.getAttribute("title")).toContain("open from your phone or the web");
    expect(remote.querySelector("svg")?.getAttribute("class")).toContain("lucide-monitor");
    expect(local.hasAttribute("data-remote")).toBe(false);
    expect(local.querySelector("svg")?.getAttribute("class")).toContain("lucide-square-terminal");
  });
});

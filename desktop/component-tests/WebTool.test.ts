import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const shell = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-shell", () => shell);

import WebIndicator from "../src/components/WebIndicator.svelte";
import WebSources from "../src/components/WebSources.svelte";
import ChatMessage from "../src/components/ChatMessage.svelte";
import { UNAVAILABLE_TITLE, WEB_AUTO_KEY, chatWebMode, webAutoDefault, webFooter, webIndicatorView, webOffered, type WebStatus } from "../src/lib/web-tool";
import { applyAgentEvent } from "../src/lib/agent-events";

afterEach(() => {
  cleanup();
  shell.open.mockClear();
});

const ready: WebStatus = { available: true, configured: true, toolsSupported: true, reason: null, searchCSats: 0.5, readCSats: 0.2, balanceCSats: 40 };

describe("the composer's Web indicator (web is automatic)", () => {
  it("shows \"Web: Auto\" by default; its menu turns it off for this chat", async () => {
    const onChange = vi.fn();
    render(WebIndicator, { status: ready, mode: "auto", onChange });
    const btn = screen.getByTestId("web-indicator");
    expect(btn.textContent).toContain("Web: Auto");
    expect(btn.getAttribute("aria-pressed")).toBeNull();
    expect(btn.getAttribute("title")).toContain("0.5 cSats a search, 0.2 a page");
    await fireEvent.click(btn);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Auto"), expect.stringContaining("Off for this chat")]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    await fireEvent.click(options[1]);
    expect(onChange).toHaveBeenCalledWith("off");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows \"Web: Off\" when off for this chat, and picks Auto with the keyboard", async () => {
    const onChange = vi.fn();
    render(WebIndicator, { status: ready, mode: "off", onChange });
    const btn = screen.getByTestId("web-indicator");
    expect(btn.textContent).toContain("Web: Off");
    await fireEvent.click(btn);
    const list = screen.getByRole("listbox");
    await fireEvent.keyDown(list, { key: "ArrowDown" });
    await fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("is dimmed, without a menu, for a model that can't call tools", async () => {
    const onChange = vi.fn();
    render(WebIndicator, { status: { ...ready, available: false, toolsSupported: false, reason: "no_tools" }, mode: "auto", onChange });
    const btn = screen.getByTestId("web-indicator");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.title).toBe(UNAVAILABLE_TITLE);
    expect(btn.textContent?.trim()).toBe("Web");
    await fireEvent.click(btn);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says \"needs cSats\" quietly with an empty balance (still Auto: it answers without the web)", () => {
    render(WebIndicator, { status: { ...ready, available: false, reason: "needs_csats", balanceCSats: 0 }, mode: "auto", onChange: () => {} });
    const btn = screen.getByRole("button", { name: "Web: Auto (needs cSats)" });
    expect(btn.getAttribute("aria-disabled")).toBe("false");
    expect(btn.title).toMatch(/Web search needs cSats.*top up/);
  });

  it("is hidden while web search isn't set up on the servers (or the status is unknown)", () => {
    render(WebIndicator, { status: { available: false, configured: false, toolsSupported: true, reason: "not_configured", message: "Web search isn't set up yet" }, mode: "auto", onChange: () => {} });
    expect(screen.queryByTestId("web-indicator")).toBeNull();
    cleanup();
    render(WebIndicator, { status: null, mode: "auto", onChange: () => {} });
    expect(screen.queryByTestId("web-indicator")).toBeNull();
  });
});

describe("a chat's web mode", () => {
  it("is the chat's own choice, else the Settings default (on unless turned off)", () => {
    expect(chatWebMode(undefined, true)).toBe("auto");
    expect(chatWebMode(undefined, false)).toBe("off");
    expect(chatWebMode(true, false)).toBe("auto");
    expect(chatWebMode(false, true)).toBe("off");
  });

  it("the Settings default reads \"off\" only when turned off, and survives broken storage", () => {
    expect(webAutoDefault(null)).toBe(true);
    expect(webAutoDefault({ getItem: () => null })).toBe(true);
    expect(webAutoDefault({ getItem: (k) => (k === WEB_AUTO_KEY ? "off" : null) })).toBe(false);
    expect(webAutoDefault({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
  });

  it("offers the web tools only on Auto with a status that says they can be used now", () => {
    expect(webOffered(ready, "auto")).toBe(true);
    expect(webOffered(ready, "off")).toBe(false);
    expect(webOffered({ ...ready, available: false, reason: "needs_csats" }, "auto")).toBe(false);
    expect(webOffered({ ...ready, available: false, reason: "rate_limited" }, "auto")).toBe(false);
    expect(webOffered(null, "auto")).toBe(false);
  });

  it("the indicator's view for off and rate-limited", () => {
    expect(webIndicatorView(ready, "off")).toMatchObject({ visible: true, unavailable: false, label: "Web: Off", note: "" });
    expect(webIndicatorView({ ...ready, available: false, reason: "rate_limited", message: "Hourly limit used" }, "auto")).toMatchObject({ label: "Web: Auto", title: "Hourly limit used" });
  });

  it("a web_off event marks the turn (the reply goes on without the web)", () => {
    const turn = applyAgentEvent({ text: "", toolEvents: [] }, { type: "web_off", reason: "needs_csats", message: "Web search needs cSats" }).turn;
    expect(turn.webOff).toEqual({ reason: "needs_csats", message: "Web search needs cSats" });
  });
});

describe("citations under a web answer", () => {
  const web = {
    searches: 2,
    pages: 1,
    cSats: 1.2,
    sources: [
      { n: 1, title: "Rust 1.80 notes", url: "https://blog.rust-lang.org/2024/07/25/Rust-1.80.0.html" },
      { n: 2, title: "Unused result", url: "https://www.example.com/x" },
      { n: 3, title: "LazyLock docs", url: "https://doc.rust-lang.org/std/sync/struct.LazyLock.html" },
    ],
  };

  it("lists the cited sources, numbered, as links, with the footer", async () => {
    render(WebSources, { web, text: "Rust 1.80 adds LazyLock [3] and exclusive ranges [1]." });
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("value"))).toEqual(["1", "3"]);
    const link = screen.getByRole("link", { name: "LazyLock docs" });
    expect(link.getAttribute("href")).toBe("https://doc.rust-lang.org/std/sync/struct.LazyLock.html");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByText("Unused result")).toBeNull();
    expect(screen.getByText("2 searches · 1 page · 1.2 cSats")).toBeTruthy();
    await fireEvent.click(link);
    expect(shell.open).toHaveBeenCalledWith("https://doc.rust-lang.org/std/sync/struct.LazyLock.html");
  });

  it("lists every source when the answer cites none", () => {
    render(WebSources, { web, text: "It's out." });
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("www.example.com".replace(/^www\./, ""))).toBeTruthy();
  });

  it("a finished reply shows them; while streaming the web status line shows instead", () => {
    const { container } = render(ChatMessage, { role: "assistant", content: "Answer [1].", web });
    expect(container.querySelector("[data-testid=web-sources]")).toBeTruthy();
    cleanup();
    render(ChatMessage, { role: "assistant", content: "", streaming: true, web, activity: "Reading example.com…" });
    expect(screen.getByRole("status").textContent).toBe("Reading example.com…");
    expect(screen.queryByTestId("web-sources")).toBeNull();
  });

  it("the stream's web events and status lines fold into the turn", () => {
    let turn = applyAgentEvent({ text: "", toolEvents: [] }, { type: "status", message: "Searching the web…" }).turn;
    expect(turn.activity).toBe("Searching the web…");
    turn = applyAgentEvent(turn, { type: "web", searches: 1, pages: 0, cSats: 0.5, addedCSats: 0.5, sources: [{ n: 1, title: "A", url: "https://a.example/" }, { n: 2, title: "bad", url: "javascript:alert(1)" }] }).turn;
    expect(turn.activity).toBeUndefined();
    expect(turn.web).toEqual({ searches: 1, pages: 0, cSats: 0.5, sources: [{ n: 1, title: "A", url: "https://a.example/" }] });
  });

  it("on your own machine the footer says free (your machine), from the stream's free flag", () => {
    const turn = applyAgentEvent({ text: "", toolEvents: [] }, { type: "web", searches: 2, pages: 0, cSats: 0, addedCSats: 0, free: true, sources: [{ n: 1, title: "A", url: "https://a.example/" }] }).turn;
    expect(turn.web).toMatchObject({ searches: 2, cSats: 0, free: true });
    render(WebSources, { web: turn.web!, text: "It's out [1]." });
    expect(screen.getByText("2 searches · free (your machine)")).toBeTruthy();
    expect(webFooter({ searches: 2, pages: 0, cSats: 0.5, free: true })).toBe("2 searches · 0.5 cSats");
  });
});

describe("free web on your own machine (indicator)", () => {
  it("no \"needs cSats\" when the chat runs on your machine; it still shows for network chats", () => {
    const own: WebStatus = { ...ready, balanceCSats: 0, free: true, freeSearchesLeftToday: 97 };
    const v = webIndicatorView(own, "auto");
    expect(v).toMatchObject({ label: "Web: Auto", note: "" });
    expect(v.title).toContain("Free on your machine (97 free searches left today)");
    expect(webOffered(own, "auto")).toBe(true);
    expect(webIndicatorView({ ...ready, available: false, reason: "needs_csats", balanceCSats: 0 }, "auto").note).toBe("needs cSats");
    expect(webIndicatorView({ ...ready, available: false, reason: "free_used", message: "Today's free web searches on your machine are used up" }, "auto")).toMatchObject({ note: "", title: "Today's free web searches on your machine are used up" });
  });
});

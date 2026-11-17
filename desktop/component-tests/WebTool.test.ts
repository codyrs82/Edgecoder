import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const shell = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-shell", () => shell);

import WebToggle from "../src/components/WebToggle.svelte";
import WebSources from "../src/components/WebSources.svelte";
import ChatMessage from "../src/components/ChatMessage.svelte";
import { NO_TOOLS_TITLE, type WebStatus } from "../src/lib/web-tool";
import { applyAgentEvent } from "../src/lib/agent-events";

afterEach(() => {
  cleanup();
  shell.open.mockClear();
});

const ready: WebStatus = { available: true, configured: true, toolsSupported: true, reason: null, searchCSats: 0.5, readCSats: 0.2, balanceCSats: 40 };

describe("the composer's Web toggle", () => {
  it("is off by default and turns on when clicked (the chat keeps it)", async () => {
    const onChange = vi.fn();
    render(WebToggle, { status: ready, on: false, onChange });
    const btn = screen.getByRole("button", { name: "Web" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.getAttribute("title")).toContain("0.5 cSats a search, 0.2 a page");
    await fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows pressed when on", () => {
    render(WebToggle, { status: ready, on: true, onChange: () => {} });
    expect(screen.getByRole("button", { name: "Web" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("is disabled, with a tooltip, for a model that can't call tools", async () => {
    const onChange = vi.fn();
    render(WebToggle, { status: { ...ready, available: false, toolsSupported: false, reason: "no_tools" }, on: true, onChange });
    const btn = screen.getByRole("button", { name: "Web" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.title).toBe(NO_TOOLS_TITLE);
    await fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says \"needs cSats\" with an empty balance", () => {
    render(WebToggle, { status: { ...ready, available: false, reason: "needs_csats", balanceCSats: 0 }, on: false, onChange: () => {} });
    const btn = screen.getByRole("button", { name: "Web (needs cSats)" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("needs cSats");
    expect(btn.title).toMatch(/Top up/);
  });

  it("is hidden while web search isn't set up on the servers (or the status is unknown)", () => {
    render(WebToggle, { status: { available: false, configured: false, toolsSupported: true, reason: "not_configured", message: "Web search isn't set up yet" }, on: true, onChange: () => {} });
    expect(screen.queryByTestId("web-toggle")).toBeNull();
    cleanup();
    render(WebToggle, { status: null, on: true, onChange: () => {} });
    expect(screen.queryByTestId("web-toggle")).toBeNull();
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
});

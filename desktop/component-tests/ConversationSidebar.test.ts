// #161: ConversationSidebar has no nested interactive controls, and its row menu follows the
// menu-button pattern (focus in on open, arrow keys, Escape returns focus to the trigger).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

const store = vi.hoisted(() => ({
  listConversationsBySource: vi.fn(),
  deleteConversation: vi.fn().mockResolvedValue(undefined),
  renameConversation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/chat-store", () => store);
vi.mock("../src/lib/api", () => ({
  portalDeleteConversation: vi.fn().mockResolvedValue(undefined),
  portalRenameConversation: vi.fn().mockResolvedValue(undefined),
}));

import ConversationSidebar from "../src/components/ConversationSidebar.svelte";
import type { Conversation } from "../src/lib/types";

const convo = (id: string, title: string): Conversation => ({
  id,
  title,
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  source: "chat",
});

afterEach(() => cleanup());

async function setup() {
  store.listConversationsBySource.mockResolvedValue([convo("c1", "First chat"), convo("c2", "Second chat")]);
  const onSelectConversation = vi.fn();
  const r = render(ConversationSidebar, {
    props: { open: true, inline: true, onClose: vi.fn(), onSelectConversation, onNewChat: vi.fn(), activeConversationId: "c1" },
  });
  await screen.findByRole("button", { name: /^First chat/ });
  return { ...r, onSelectConversation };
}

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="link"], [tabindex]:not([tabindex="-1"])';

describe("ConversationSidebar (#161)", () => {
  it("has no interactive control nested inside another", async () => {
    const { container } = await setup();
    await fireEvent.click(screen.getByRole("button", { name: "More options for First chat" }));
    await screen.findByRole("menu");
    const nested = Array.from(container.querySelectorAll<HTMLElement>(INTERACTIVE)).filter((el) =>
      el.parentElement?.closest(INTERACTIVE),
    );
    expect(nested.map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    expect(container.querySelector('[role="button"]')).toBeNull();
  });

  it("opens a conversation from its row button", async () => {
    const { onSelectConversation } = await setup();
    const row = screen.getByRole("button", { name: /^Second chat/ });
    expect(row.tagName).toBe("BUTTON");
    await fireEvent.click(row);
    expect(onSelectConversation).toHaveBeenCalledWith("c2");
    expect(screen.getByRole("button", { name: /^First chat/ }).getAttribute("aria-current")).toBe("true");
  });

  it("moves focus into the menu, supports arrow keys, and Escape returns focus to the trigger", async () => {
    await setup();
    const trigger = screen.getByRole("button", { name: "More options for First chat" });
    trigger.focus();
    await fireEvent.click(trigger);
    const menuEl = await screen.findByRole("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menuEl.id);
    const items = screen.getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    await fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    await fireEvent.keyDown(items[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    await fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[1]);
    await fireEvent.keyDown(items[1], { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    await fireEvent.keyDown(items[0], { key: "End" });
    expect(document.activeElement).toBe(items[1]);

    await fireEvent.keyDown(items[1], { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Tab and on a pointerdown outside", async () => {
    await setup();
    const trigger = screen.getByRole("button", { name: "More options for First chat" });
    await fireEvent.click(trigger);
    const first = (await screen.findAllByRole("menuitem"))[0];
    await fireEvent.keyDown(first, { key: "Tab" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await fireEvent.click(trigger);
    await screen.findByRole("menu");
    await fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Rename swaps the row for a labelled input; Escape cancels back to the row button", async () => {
    await setup();
    await fireEvent.click(screen.getByRole("button", { name: "More options for First chat" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const input = await screen.findByRole("textbox", { name: "Rename conversation" });
    await fireEvent.keyDown(input, { key: "Escape" });
    const row = await screen.findByRole("button", { name: /^First chat/ });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(store.renameConversation).not.toHaveBeenCalled();
  });
});

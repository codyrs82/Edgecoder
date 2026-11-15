import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/svelte";
import type { Conversation } from "../src/lib/types";

const store = vi.hoisted(() => ({ chats: [] as Conversation[] }));
vi.mock("../src/lib/chat-store", () => ({
  listConversationsBySource: vi.fn(async () => store.chats),
  deleteConversation: vi.fn(async () => undefined),
  renameConversation: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/api", () => ({ computeOverview: vi.fn(async () => ({})), portalWebUrl: (p = "") => p }));

import ProjectSidebar from "../src/components/ProjectSidebar.svelte";

const NOW = Date.now();
const chat = (id: string, title: string, minsAgo: number, projectRoot?: string): Conversation =>
  ({ id, title, messages: [], createdAt: NOW, updatedAt: NOW - minsAgo * 60_000, source: "editor", ...(projectRoot ? { projectRoot } : {}) });

const props = (over = {}) => ({
  currentProject: "/Users/me/EdgeCoder/website",
  activeChatId: "c1",
  onOpenProject: vi.fn(), onSelectChat: vi.fn(), onNewChat: vi.fn(), onNewProject: vi.fn(), onOpenFolder: vi.fn(), onClone: vi.fn(),
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("edgecoder-recent-projects", JSON.stringify([{ root: "/Users/me/EdgeCoder/api", openedAt: NOW - 86_400_000 }]));
  store.chats = [
    chat("c1", "Add a contact form", 1, "/Users/me/EdgeCoder/website"),
    chat("c2", "Fix the header", 180, "/Users/me/EdgeCoder/website"),
    chat("c3", "Rate limiting", 2000, "/Users/me/EdgeCoder/api"),
    chat("c4", "Lets build a website.", 5),
  ];
});
afterEach(() => cleanup());

describe("ProjectSidebar", () => {
  it("lists projects with their chats nested, the open one expanded", async () => {
    render(ProjectSidebar, props());
    const projects = await screen.findByRole("list", { name: "Projects" });
    const website = await within(projects).findByRole("list", { name: "Chats in website" });
    expect(within(website).getAllByRole("button", { name: /^(Add a contact form|Fix the header)/ }).map((b) => b.textContent?.trim().split(/\s+/)[0])).toEqual(["Add", "Fix"]);
    expect(within(website).getByRole("button", { name: /^Add a contact form/ }).getAttribute("aria-current")).toBe("true");
    // The other project is collapsed until expanded.
    expect(screen.queryByRole("list", { name: "Chats in api" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Expand api" }));
    expect(await screen.findByRole("list", { name: "Chats in api" })).toBeTruthy();
    // A chat from before chats had projects.
    expect(within(screen.getByRole("list", { name: "Chats without a project" })).getByText("Lets build a website.")).toBeTruthy();
  });

  it("opens projects and chats, and starts a chat in a project", async () => {
    const p = props();
    render(ProjectSidebar, p);
    await fireEvent.click(await screen.findByRole("button", { name: "api" }));
    expect(p.onOpenProject).toHaveBeenCalledWith("/Users/me/EdgeCoder/api");
    await fireEvent.click(await screen.findByRole("button", { name: /^Fix the header/ }));
    expect(p.onSelectChat).toHaveBeenCalledWith(expect.objectContaining({ id: "c2", projectRoot: "/Users/me/EdgeCoder/website" }));
    await fireEvent.click(screen.getByRole("button", { name: "New chat in api" }));
    expect(p.onNewChat).toHaveBeenCalledWith("/Users/me/EdgeCoder/api");
  });

  it("has the New actions, and New chat waits for a project", async () => {
    const p = props({ currentProject: null, activeChatId: null });
    render(ProjectSidebar, p);
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await fireEvent.click(screen.getByRole("button", { name: "Clone from GitHub" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(p.onNewProject).toHaveBeenCalled();
    expect(p.onClone).toHaveBeenCalled();
    expect(p.onOpenFolder).toHaveBeenCalled();
  });

  it("says what to do when there are no projects", async () => {
    localStorage.clear();
    store.chats = [];
    render(ProjectSidebar, props({ currentProject: null, activeChatId: null }));
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });
});

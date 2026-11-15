import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  getProjectsFolder: vi.fn(),
  recentRepos: vi.fn(),
  ideCreateProject: vi.fn(),
  gitPublishGitHub: vi.fn(),
  connectRepo: vi.fn(),
  gitClone: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/lib/api", () => api);
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import NewProjectDialog from "../src/components/NewProjectDialog.svelte";

const props = (over = {}) => ({ onClose: vi.fn(), onCreated: vi.fn(), onConnectGitHub: vi.fn(), ...over });

beforeEach(() => {
  api.getProjectsFolder.mockResolvedValue({ path: "/Users/me/EdgeCoder", source: "default" });
  api.recentRepos.mockResolvedValue({ ghInstalled: true, loggedIn: true, login: "octo", repos: ["octo/site", "octo/api"] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("New project", () => {
  it("creates a project from a template in the projects folder", async () => {
    api.ideCreateProject.mockResolvedValue("/Users/me/EdgeCoder/My-site");
    const p = props();
    render(NewProjectDialog, p);
    await screen.findByRole("dialog", { name: "New project" });
    expect(await screen.findByText("~/EdgeCoder")).toBeTruthy();
    await fireEvent.input(screen.getByRole("textbox", { name: /Name/ }), { target: { value: "My site" } });
    await fireEvent.click(screen.getByRole("radio", { name: /Website/ }));
    expect(screen.getByText("Folder: My-site")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await vi.waitFor(() => expect(p.onCreated).toHaveBeenCalled());
    expect(api.ideCreateProject).toHaveBeenCalledWith({ folder: "My-site", template: "web", git: true });
    expect(api.gitPublishGitHub).not.toHaveBeenCalled();
    expect(p.onCreated.mock.calls[0][0]).toMatchObject({ root: "/Users/me/EdgeCoder/My-site" });
  });

  it("creates it somewhere else, without git", async () => {
    api.ideCreateProject.mockResolvedValue("/Users/me/code/tool");
    dialog.open.mockResolvedValue("/Users/me/code");
    const p = props();
    render(NewProjectDialog, p);
    await fireEvent.input(await screen.findByRole("textbox", { name: /Name/ }), { target: { value: "tool" } });
    await fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(await screen.findByText("~/code")).toBeTruthy();
    await fireEvent.click(screen.getByRole("checkbox", { name: /Initialise git/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await vi.waitFor(() => expect(api.ideCreateProject).toHaveBeenCalledWith({ folder: "tool", parentDir: "/Users/me/code", template: "empty", git: false }));
  });

  it("publishes to GitHub, and still opens the project when publishing fails", async () => {
    api.ideCreateProject.mockResolvedValue("/Users/me/EdgeCoder/site");
    api.gitPublishGitHub.mockRejectedValue(new Error("name already exists on this account"));
    const p = props();
    render(NewProjectDialog, p);
    await fireEvent.input(await screen.findByRole("textbox", { name: /Name/ }), { target: { value: "site" } });
    const publish = await screen.findByRole("checkbox", { name: /Publish to GitHub/ });
    await vi.waitFor(() => expect((publish as HTMLInputElement).disabled).toBe(false));
    await fireEvent.click(publish);
    await fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await vi.waitFor(() => expect(p.onCreated).toHaveBeenCalled());
    expect(api.gitPublishGitHub).toHaveBeenCalledWith("site", "private");
    expect(p.onCreated.mock.calls[0][0].warning).toContain("name already exists");
  });

  it("can't publish before GitHub is connected, and says how", async () => {
    api.recentRepos.mockResolvedValue({ ghInstalled: true, loggedIn: false, login: null, repos: [] });
    const p = props();
    render(NewProjectDialog, p);
    expect(await screen.findByText("Sign in to GitHub first.")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Publish to GitHub/ }) as HTMLInputElement).disabled).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(p.onConnectGitHub).toHaveBeenCalled();
  });

  it("clones one of your GitHub repositories", async () => {
    api.connectRepo.mockResolvedValue({ path: "/Users/me/EdgeCoder/api", name: "api", action: "cloned", branch: "main", message: "Cloned api (main)." });
    const p = props({ mode: "clone" });
    render(NewProjectDialog, p);
    expect((screen.getByRole("radio", { name: /Clone from GitHub/ }) as HTMLInputElement).checked).toBe(true);
    await fireEvent.click(await screen.findByRole("button", { name: "octo/api" }));
    await fireEvent.click(screen.getByRole("button", { name: "Clone and open" }));
    await vi.waitFor(() => expect(p.onCreated).toHaveBeenCalled());
    expect(api.connectRepo).toHaveBeenCalledWith("octo/api", expect.any(Function));
    expect(p.onCreated.mock.calls[0][0].summary).toContain("Cloned **api** on `main`");
  });

  it("shows a failure inline and stays open", async () => {
    api.ideCreateProject.mockRejectedValue(new Error("/Users/me/EdgeCoder/site already exists. Pick another name."));
    const p = props();
    render(NewProjectDialog, p);
    await fireEvent.input(await screen.findByRole("textbox", { name: /Name/ }), { target: { value: "site" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    expect(p.onCreated).not.toHaveBeenCalled();
  });
});

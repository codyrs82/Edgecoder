import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  gitState: vi.fn(),
  gitGitHubStatus: vi.fn(),
  gitCheckout: vi.fn(),
  gitCommit: vi.fn(),
  gitInit: vi.fn(),
  gitPublishGitHub: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
}));
vi.mock("../src/lib/api", () => api);

import ChatProjectHeader from "../src/components/ChatProjectHeader.svelte";
import { githubCliStatus } from "../src/lib/github-cli";

const repo = (over = {}) => ({
  branch: "main", upstream: "origin/main", ahead: 1, behind: 2, staged: [{ path: "a.ts", status: "M" }], unstaged: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "U" }],
  branches: ["main", "feature/x"], remotes: ["origin"], remoteUrl: "https://github.com/acme/site.git", hasCommits: true, ...over,
});

beforeEach(async () => {
  api.gitGitHubStatus.mockResolvedValue({ ghInstalled: true, loggedIn: true, login: "acme" });
  await githubCliStatus(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatProjectHeader", () => {
  it("shows project · branch, changes, ahead/behind and the repository", async () => {
    api.gitState.mockResolvedValue(repo());
    render(ChatProjectHeader, { projectRoot: "/Users/me/EdgeCoder/site" });
    expect(screen.getByText("site")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Branch main/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2 uncommitted changes: review" })).toBeTruthy();
    expect(screen.getByTitle("1 commit to push")).toBeTruthy();
    expect(screen.getByTitle("2 commits to pull")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the repository acme/site" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pull" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Push" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect GitHub/ })).toBeNull();
  });

  it("switches and creates branches from the branch menu", async () => {
    api.gitState.mockResolvedValue(repo());
    api.gitCheckout.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(ChatProjectHeader, { projectRoot: "/p/site", onChanged });
    await fireEvent.click(await screen.findByRole("button", { name: /^Branch main/ }));
    await fireEvent.click(await screen.findByRole("button", { name: /feature\/x/ }));
    await vi.waitFor(() => expect(api.gitCheckout).toHaveBeenCalledWith("feature/x", false));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    await fireEvent.click(await screen.findByRole("button", { name: /^Branch main/ }));
    await fireEvent.input(await screen.findByLabelText("New branch name"), { target: { value: "fix/header" } });
    await fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await vi.waitFor(() => expect(api.gitCheckout).toHaveBeenCalledWith("fix/header", true));
  });

  it("commits all changes with a message", async () => {
    api.gitState.mockResolvedValue(repo());
    api.gitCommit.mockResolvedValue("abc1234def");
    render(ChatProjectHeader, { projectRoot: "/p/site" });
    await fireEvent.click(await screen.findByRole("button", { name: "Commit" }));
    await fireEvent.input(await screen.findByLabelText(/Commit 2 changes on main/), { target: { value: "Add the form" } });
    // The popover's own Commit button (the header's opens it).
    await fireEvent.click(screen.getAllByRole("button", { name: "Commit" }).at(-1)!);
    await vi.waitFor(() => expect(api.gitCommit).toHaveBeenCalledWith("Add the form", true));
  });

  it("offers Publish without a remote, and Initialise git outside a repository", async () => {
    api.gitState.mockResolvedValue(repo({ remotes: [], remoteUrl: null, upstream: null, ahead: 0, behind: 0 }));
    api.gitPublishGitHub.mockResolvedValue({ url: "https://github.com/acme/site", output: "" });
    render(ChatProjectHeader, { projectRoot: "/p/site" });
    await fireEvent.click(await screen.findByRole("button", { name: /Publish/ }));
    expect(((await screen.findByLabelText("Publish to GitHub as acme")) as HTMLInputElement).value).toBe("site");
    await fireEvent.click(screen.getAllByRole("button", { name: "Publish" }).at(-1)!);
    await vi.waitFor(() => expect(api.gitPublishGitHub).toHaveBeenCalledWith("site", "private"));
    cleanup();

    api.gitState.mockResolvedValue({ notARepo: true });
    api.gitInit.mockResolvedValue({ ok: true });
    render(ChatProjectHeader, { projectRoot: "/p/plain" });
    expect(await screen.findByText("Not a git repository")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Initialise git" }));
    await vi.waitFor(() => expect(api.gitInit).toHaveBeenCalled());
  });

  it("shows Connect GitHub with the sign-in steps when gh isn't signed in", async () => {
    api.gitGitHubStatus.mockResolvedValue({ ghInstalled: true, loggedIn: false, login: null });
    await githubCliStatus(true);
    api.gitState.mockResolvedValue(repo());
    const onConnectGitHub = vi.fn();
    render(ChatProjectHeader, { projectRoot: "/p/site", onConnectGitHub });
    await fireEvent.click(await screen.findByRole("button", { name: /Connect GitHub/ }));
    expect(await screen.findByText("gh auth login")).toBeTruthy();
    api.gitGitHubStatus.mockResolvedValue({ ghInstalled: true, loggedIn: true, login: "acme" });
    await fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: /Connect GitHub/ })).toBeNull());
  });
});

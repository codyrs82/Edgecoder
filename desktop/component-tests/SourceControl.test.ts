import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  gitState: vi.fn(),
  gitInit: vi.fn(),
  gitClone: vi.fn(),
  gitAddRemote: vi.fn(),
  gitPublishGitHub: vi.fn(),
  gitGitHubStatus: vi.fn(),
  gitPush: vi.fn(),
  ideGetProject: vi.fn(),
  connectRepo: vi.fn(),
  getProjectsFolder: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ open: vi.fn(), ask: vi.fn() }));
vi.mock("../src/lib/api", () => ({
  ...api,
  gitHeadContent: vi.fn(), gitStage: vi.fn(), gitUnstage: vi.fn(), gitDiscard: vi.fn(),
  gitCommit: vi.fn(), gitCheckout: vi.fn(), gitPull: vi.fn(), fsRead: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import SourceControl from "../src/components/SourceControl.svelte";

const repo = (over = {}) => ({
  branch: "main", upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], branches: ["main"], remotes: [], hasCommits: true, ...over,
});
const props = (over = {}) => ({ refreshKey: 0, onOpen: vi.fn(), onChanged: vi.fn(), onError: vi.fn(), onInfo: vi.fn(), onProjectOpened: vi.fn(), ...over });

afterEach(() => cleanup());

describe("SourceControl setup", () => {
  it("offers init, publish and clone when the folder isn't a repository, and initializes", async () => {
    api.gitState.mockResolvedValueOnce({ notARepo: true }).mockResolvedValue(repo({ hasCommits: false }));
    api.gitInit.mockResolvedValue({ ok: true });
    render(SourceControl, props());
    const init = await screen.findByRole("button", { name: /Initialize Repository/ });
    expect(screen.getByRole("button", { name: /Clone Repository/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Publish to GitHub/ })).toBeTruthy();
    await fireEvent.click(init);
    expect(api.gitInit).toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /Publish Branch/ })).toBeTruthy());
  });

  it("clones into the projects folder by default and opens it", async () => {
    api.gitState.mockResolvedValue({ notARepo: true });
    api.getProjectsFolder.mockResolvedValue({ path: "/Users/me/EdgeCoder", source: "default" });
    api.connectRepo.mockResolvedValue({ path: "/Users/me/EdgeCoder/widgets", action: "cloned", name: "widgets", message: "Cloned widgets." });
    const p = props();
    render(SourceControl, p);
    await fireEvent.click(await screen.findByRole("button", { name: /Clone Repository/ }));
    await fireEvent.input(screen.getByLabelText("Repository URL"), { target: { value: "acme/widgets" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Clone into ~/EdgeCoder" }));
    await vi.waitFor(() => expect(p.onProjectOpened).toHaveBeenCalledWith("/Users/me/EdgeCoder/widgets"));
    expect(api.connectRepo).toHaveBeenCalledWith("acme/widgets", expect.any(Function));
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it("clones into another folder the user picks", async () => {
    api.gitState.mockResolvedValue({ notARepo: true });
    api.getProjectsFolder.mockResolvedValue({ path: "/Users/me/EdgeCoder", source: "default" });
    dialog.open.mockResolvedValue("/Users/me/code");
    api.gitClone.mockResolvedValue("/Users/me/code/widgets");
    const p = props();
    render(SourceControl, p);
    await fireEvent.click(await screen.findByRole("button", { name: /Clone Repository/ }));
    await fireEvent.input(screen.getByLabelText("Repository URL"), { target: { value: "acme/widgets" } });
    await fireEvent.click(screen.getByRole("button", { name: /Choose another location/ }));
    await vi.waitFor(() => expect(p.onProjectOpened).toHaveBeenCalledWith("/Users/me/code/widgets"));
    expect(api.gitClone).toHaveBeenCalledWith("acme/widgets", "/Users/me/code");
  });

  it("shows a clone error inline", async () => {
    api.gitState.mockResolvedValue({ notARepo: true });
    api.getProjectsFolder.mockResolvedValue({ path: "/Users/me/EdgeCoder", source: "default" });
    api.connectRepo.mockRejectedValue(new Error("file: URLs aren't allowed."));
    render(SourceControl, props());
    await fireEvent.click(await screen.findByRole("button", { name: /Clone Repository/ }));
    await fireEvent.input(screen.getByLabelText("Repository URL"), { target: { value: "file:///x" } });
    await fireEvent.click(screen.getByRole("button", { name: /^Clone into/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("file: URLs aren't allowed.");
  });

  it("explains gh auth login when GitHub isn't signed in", async () => {
    api.gitState.mockResolvedValue({ notARepo: true });
    api.ideGetProject.mockResolvedValue("/Users/me/my app");
    api.gitGitHubStatus.mockResolvedValue({ ghInstalled: true, loggedIn: false, login: null });
    render(SourceControl, props());
    await fireEvent.click(await screen.findByRole("button", { name: /Publish to GitHub/ }));
    expect(await screen.findByText(/gh auth login/)).toBeTruthy();
    expect((screen.getByLabelText("Repository name") as HTMLInputElement).value).toBe("my-app");
    expect((screen.getByRole("button", { name: /Publish private repository/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("publishes with gh when signed in", async () => {
    api.gitState.mockResolvedValue(repo());
    api.ideGetProject.mockResolvedValue("/Users/me/widgets");
    api.gitGitHubStatus.mockResolvedValue({ ghInstalled: true, loggedIn: true, login: "octo" });
    api.gitPublishGitHub.mockResolvedValue({ url: "https://github.com/octo/widgets", output: "" });
    const p = props();
    render(SourceControl, p);
    await fireEvent.click(await screen.findByRole("button", { name: /Publish Branch/ }));
    expect(await screen.findByText("octo")).toBeTruthy();
    await fireEvent.click(screen.getByLabelText("Public"));
    await fireEvent.click(screen.getByRole("button", { name: /Publish public repository/ }));
    await vi.waitFor(() => expect(api.gitPublishGitHub).toHaveBeenCalledWith("widgets", "public"));
    await vi.waitFor(() => expect(p.onInfo).toHaveBeenCalledWith("Published to https://github.com/octo/widgets"));
  });

  it("publishes a branch to an existing remote and offers Add remote… when there is none", async () => {
    api.gitState.mockResolvedValue(repo({ remotes: ["origin"] }));
    api.gitPush.mockResolvedValue("Published main.");
    render(SourceControl, props());
    await fireEvent.click(await screen.findByRole("button", { name: /Publish Branch/ }));
    await vi.waitFor(() => expect(api.gitPush).toHaveBeenCalled());
    cleanup();

    api.gitState.mockResolvedValue(repo());
    api.gitAddRemote.mockResolvedValue({ ok: true, name: "origin", url: "https://github.com/acme/w.git" });
    render(SourceControl, props());
    await fireEvent.click(await screen.findByRole("button", { name: "Add remote…" }));
    await fireEvent.input(screen.getByLabelText("Remote URL"), { target: { value: "acme/w" } });
    await fireEvent.click(screen.getByRole("button", { name: /Add remote$/ }));
    await vi.waitFor(() => expect(api.gitAddRemote).toHaveBeenCalledWith("acme/w"));
  });

  it("keeps pull and push when the branch has an upstream", async () => {
    api.gitState.mockResolvedValue(repo({ upstream: "origin/main", remotes: ["origin"] }));
    render(SourceControl, props());
    expect(await screen.findByTitle("Push")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Publish Branch/ })).toBeNull();
  });
});

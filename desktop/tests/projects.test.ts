import { beforeEach, describe, expect, it } from "vitest";
import { folderNameFrom, forgetProject, githubSlug, groupByProject, lastChatFor, loadRecentProjects, projectName, rememberProject, repoWebUrl, setLastChatFor, tildePath } from "../src/lib/projects";
import type { Conversation } from "../src/lib/types";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const chat = (id: string, updatedAt: number, projectRoot?: string): Conversation => ({ id, title: id, messages: [], createdAt: updatedAt, updatedAt, source: "editor", ...(projectRoot ? { projectRoot } : {}) });

beforeEach(() => store.clear());

describe("projects", () => {
  it("names folders", () => {
    expect(projectName("/Users/me/EdgeCoder/website/")).toBe("website");
    expect(projectName("C:\\code\\api")).toBe("api");
    expect(tildePath("/Users/me/EdgeCoder/site")).toBe("~/EdgeCoder/site");
  });

  it("keeps recent projects newest first, without duplicates", () => {
    rememberProject("/a", 1);
    rememberProject("/b", 2);
    rememberProject("/a", 3);
    expect(loadRecentProjects().map((r) => r.root)).toEqual(["/a", "/b"]);
    forgetProject("/a");
    expect(loadRecentProjects().map((r) => r.root)).toEqual(["/b"]);
    store.set("edgecoder-recent-projects", "not json");
    expect(loadRecentProjects()).toEqual([]);
  });

  it("remembers the last chat per project", () => {
    expect(lastChatFor("/a")).toBeNull();
    setLastChatFor("/a", "c1");
    expect(lastChatFor("/a")).toBe("c1");
  });

  it("groups chats under their projects, by last activity", () => {
    const { projects, loose } = groupByProject(
      [chat("c1", 50, "/site"), chat("c2", 90, "/site"), chat("c3", 10, "/api"), chat("c4", 70)],
      [{ root: "/api", openedAt: 100 }, { root: "/empty", openedAt: 5 }],
      "/new",
    );
    expect(projects.map((p) => p.root)).toEqual(["/api", "/site", "/empty", "/new"]);
    expect(projects[1].chats.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(projects[0].chats.map((c) => c.id)).toEqual(["c3"]);
    expect(loose.map((c) => c.id)).toEqual(["c4"]);
  });

  it("links remotes to their web pages", () => {
    expect(repoWebUrl("https://github.com/acme/widgets.git")).toBe("https://github.com/acme/widgets");
    expect(repoWebUrl("git@github.com:acme/widgets.git")).toBe("https://github.com/acme/widgets");
    expect(repoWebUrl("ssh://git@gitlab.com/acme/w.git")).toBe("https://gitlab.com/acme/w");
    expect(repoWebUrl("/local/path")).toBeNull();
    expect(repoWebUrl(null)).toBeNull();
    expect(githubSlug("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(githubSlug("https://gitlab.com/acme/w")).toBeNull();
  });

  it("makes folder names from typed names", () => {
    expect(folderNameFrom("  My new site ")).toBe("My-new-site");
    expect(folderNameFrom("../etc/passwd")).toBe("etcpasswd");
    expect(folderNameFrom("--x")).toBe("x");
  });
});

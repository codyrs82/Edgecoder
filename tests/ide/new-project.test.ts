import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNewProject, projectSlug } from "../../src/apps/ide/new-project.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "projects-"));
  process.env.EDGECODER_PROJECTS_DIR = home;
});
afterEach(() => {
  delete process.env.EDGECODER_PROJECTS_DIR;
  rmSync(home, { recursive: true, force: true });
});

describe("new projects", () => {
  it("names the folder from the request", () => {
    expect(projectSlug("Lets build a new webpage")).toBe("webpage");
    expect(projectSlug("Create a todo app with React and a dark theme")).toBe("todo-app-react-dark");
    expect(projectSlug("!!!")).toBe("project");
  });
  it("creates a unique git repository under the projects folder", () => {
    const a = createNewProject("Lets build a new webpage");
    const b = createNewProject("build a webpage");
    expect(a).toBe(join(home, "webpage"));
    expect(b).toBe(join(home, "webpage-2"));
    expect(existsSync(join(a, ".git"))).toBe(true);
  });
});

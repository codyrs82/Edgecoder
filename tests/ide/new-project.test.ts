import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NewProjectError, createNewProject, projectSlug, templateFiles } from "../../src/apps/ide/new-project.js";

const TOKEN = "new-project-test-token";
process.env.IDE_PROVIDER_TOKEN = TOKEN;
delete process.env.IDE_PROVIDER_HOST;
delete process.env.MESH_AUTH_TOKEN;
const { ideProviderServer: app } = await import("../../src/apps/ide/provider-server.js");
const headers = { host: "127.0.0.1:4304", authorization: `Bearer ${TOKEN}` };

let home: string;
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
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
  it("uses an exact folder name and location, and refuses one that exists", () => {
    const parent = join(home, "elsewhere");
    mkdirSync(parent);
    const dir = createNewProject("", { folder: "My.Site_2", parentDir: parent });
    expect(dir).toBe(join(parent, "My.Site_2"));
    expect(() => createNewProject("", { folder: "My.Site_2", parentDir: parent })).toThrow(NewProjectError);
  });
  it.each(["../escape", "a/b", "-rf", ".", ".."])("refuses the folder name %j", (folder) => {
    expect(() => createNewProject("", { folder })).toThrow(/isn't a usable folder name/);
  });
  it("refuses a relative or missing location", () => {
    expect(() => createNewProject("x", { parentDir: "relative/dir" })).toThrow(NewProjectError);
    expect(() => createNewProject("x", { parentDir: join(home, "missing") })).toThrow(/isn't a folder/);
  });
  it("writes a template's starter files, and can skip git", () => {
    const web = createNewProject("", { folder: "site", template: "web" });
    expect(readFileSync(join(web, "index.html"), "utf8")).toContain("<title>site</title>");
    expect(existsSync(join(web, "styles.css"))).toBe(true);
    const node = createNewProject("", { folder: "Tool", template: "node", git: false });
    expect(JSON.parse(readFileSync(join(node, "package.json"), "utf8")).name).toBe("tool");
    expect(existsSync(join(node, ".git"))).toBe(false);
    expect(templateFiles("empty", "x")).toEqual({});
  });
});

describe("POST /v1/ide/projects/new", () => {
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/v1/ide/projects/new", headers, payload: payload as object });

  it("creates the project from the sheet's fields and opens it", async () => {
    const r = await post({ name: "Website", folder: "website", template: "web" });
    expect(r.statusCode).toBe(200);
    expect(r.json().projectRoot).toBe(join(home, "website"));
    expect(existsSync(join(home, "website", "index.html"))).toBe(true);
    const open = await app.inject({ method: "GET", url: "/v1/ide/project", headers });
    expect(open.json().projectRoot).toBe(join(home, "website"));
  });
  it("still takes a bare name from chat", async () => {
    const r = await post({ name: "build me a snake game" });
    expect(r.json().projectRoot).toBe(join(home, "snake-game"));
  });
  it("answers 409 for a folder that exists and 400 for bad input", async () => {
    await post({ folder: "dup" });
    const dup = await post({ folder: "dup" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: "exists" });
    expect((await post({ folder: "../x" })).statusCode).toBe(400);
    expect((await post({ template: "rails" })).statusCode).toBe(400);
    expect((await post({ parentDir: "not/absolute" })).statusCode).toBe(400);
  });
});

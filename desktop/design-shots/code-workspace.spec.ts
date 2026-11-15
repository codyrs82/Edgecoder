// The Code view's project workspace (projects, chats per project, git header, new project flow),
// in both themes. Backend answers come from a11y/fixtures.ts plus the project and git answers below.
// Run: npm run build && SHOTS_DIR=../../docs/design/screens/code-workspace/after npx playwright test -c design-shots/playwright.config.ts code-workspace
// Steps a build doesn't have (the before state) are skipped, so the same spec shoots both.
import { expect, test, type Page } from "@playwright/test";
import { fixtureFor, NOT_FOUND } from "../a11y/fixtures";

const OUT = process.env.SHOTS_DIR ?? "shots";
const NOW = Date.now();
const USER = { userId: "u_shots", email: "cody@example.org", displayName: "Cody Smith", emailVerified: true };
const ROOT = "/Users/demo/EdgeCoder/website";
const API = "/Users/demo/EdgeCoder/api-server";

const GENERIC = [
  "Building a website involves several steps. Here's a high-level overview of the process:",
  "",
  "## 1. Define Your Goals and Audience",
  "",
  "- **Define Your Purpose**: What do you want your website to achieve?",
  "- **Identify Your Audience**: Who is your target audience?",
  "",
  "## 2. Choose a Platform",
  "",
  "- **Choose a Platform**: There are many platforms available for building websites, including WordPress, Wix and Squarespace.",
].join("\n");

const REPLY = [
  "I added a contact form to `index.html` and styled it in `src/styles.css`. The tests pass.",
  "",
  "The form posts to `/api/contact`; that endpoint doesn't exist yet. Want me to add it?",
].join("\n");

const TOOL_EVENTS = [
  { type: "tool_call", id: "t1", tool: "read_file", args: { path: "index.html" }, result: "<!doctype html>…" },
  { type: "tool_call", id: "t2", tool: "search_files", args: { pattern: "contact" }, result: "No matches" },
  { type: "tool_call", id: "t3", tool: "edit_file", args: { path: "index.html", old_string: "</main>", new_string: "  <form id=\"contact\">…</form>\n</main>" }, result: "Edited index.html" },
  { type: "tool_call", id: "t4", tool: "write_file", args: { path: "src/styles.css", content: "form { display: grid; gap: 8px; }\n" }, result: "Wrote src/styles.css" },
  { type: "tool_call", id: "t5", tool: "run_shell", args: { command: "npm test" }, result: "✓ 12 tests passed" },
];

const FILES = [
  { path: "index.html", before: "<main>\n  <h1>Hello</h1>\n</main>\n", after: "<main>\n  <h1>Hello</h1>\n  <form id=\"contact\">\n    <input name=\"email\" type=\"email\" />\n    <button>Send</button>\n  </form>\n</main>\n" },
  { path: "src/styles.css", before: "body { margin: 0; }\n", after: "body { margin: 0; }\nform { display: grid; gap: 8px; }\n" },
];

const GIT_STATE = {
  branch: "main", upstream: "origin/main", ahead: 1, behind: 2,
  staged: [], unstaged: [{ path: "index.html", status: "M" }, { path: "src/styles.css", status: "M" }],
  branches: ["main", "feature/contact-form", "fix/header"], remotes: ["origin"], remoteUrl: "https://github.com/cody/website.git", hasCommits: true,
};

const TREE: Record<string, Array<{ name: string; path: string; kind: "file" | "dir" }>> = {
  "": [
    { name: "src", path: "src", kind: "dir" },
    { name: "index.html", path: "index.html", kind: "file" },
    { name: "package.json", path: "package.json", kind: "file" },
    { name: "README.md", path: "README.md", kind: "file" },
  ],
};

async function stub(page: Page, opts: { project: boolean }) {
  let projectRoot: string | null = opts.project ? ROOT : null;
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (/\/me(\?|$)/.test(url)) return route.fulfill({ status: 200, json: { user: USER } });
    if (/\/v1\/ide\/bots$/.test(url)) return route.fulfill({ status: 200, json: { bots: [] } });
    if (/\/v1\/ide\/project$/.test(url)) {
      if (method === "POST") {
        projectRoot = (route.request().postDataJSON() as { projectRoot: string }).projectRoot;
        return route.fulfill({ status: 200, json: { ok: true, projectRoot, trusted: true } });
      }
      return route.fulfill({ status: 200, json: { projectRoot } });
    }
    if (/\/v1\/ide\/fs\/list/.test(url)) return route.fulfill({ status: 200, json: { entries: TREE[new URL(url).searchParams.get("path") ?? ""] ?? [] } });
    if (/\/v1\/ide\/fs\/read/.test(url)) return route.fulfill({ status: 200, json: { path: "index.html", content: FILES[0].after, mtimeMs: NOW, size: FILES[0].after.length } });
    if (/\/v1\/ide\/fs\/stat/.test(url)) return route.fulfill({ status: 200, json: { mtimes: { "index.html": NOW } } });
    if (/\/v1\/ide\/fs\/git-status/.test(url)) return route.fulfill({ status: 200, json: { branch: "main", files: { "index.html": "M", "src/styles.css": "M" } } });
    if (/\/v1\/ide\/git\/state/.test(url)) return route.fulfill({ status: 200, json: GIT_STATE });
    if (/\/v1\/ide\/git\/github\/status/.test(url)) return route.fulfill({ status: 200, json: { ghInstalled: true, loggedIn: true, login: "cody" } });
    if (/\/v1\/ide\/repos\/recent/.test(url)) return route.fulfill({ status: 200, json: { ghInstalled: true, loggedIn: true, login: "cody", repos: ["cody/website", "cody/api-server", "cody/dotfiles", "acme/widgets"] } });
    if (/\/v1\/ide\/settings\/projects-folder/.test(url)) return route.fulfill({ status: 200, json: { path: "/Users/demo/EdgeCoder", source: "default", defaultPath: "/Users/demo/EdgeCoder" } });
    if (/\/v1\/ide\/checkpoints\//.test(url)) return route.fulfill({ status: 200, json: { turnId: "turn1", changes: FILES } });
    if (/\/v1\/ide\/project\/trust/.test(url)) return route.fulfill({ status: 200, json: { projectRoot, trusted: true } });
    if (/\/v1\/ide\/diagnostics/.test(url)) return route.fulfill({ status: 200, json: { byPath: {} } });
    const body = method === "GET" ? fixtureFor(url) : {};
    if (body === NOT_FOUND) return route.fulfill({ status: 404, json: { error: "not_found" } });
    return route.fulfill({ status: 200, json: body });
  });
  await page.addInitScript(({ project, root, api }) => {
    localStorage.setItem("edgecoder_session_token", "shots-token");
    localStorage.setItem("edgecoder-starter-model", "done");
    if (project) localStorage.setItem("edgecoder-project-root", root);
    localStorage.setItem("edgecoder-recent-projects", JSON.stringify([{ root, openedAt: Date.now() - 60_000 }, { root: api, openedAt: Date.now() - 86_400_000 }]));
  }, { project: opts.project, root: ROOT, api: API });
}

async function seed(page: Page, project: boolean, last = true) {
  await page.addInitScript(({ now, root, api, generic, reply, toolEvents, project, last }) => {
    const req = indexedDB.open("edgecoder-chat", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("conversations", { keyPath: "id" });
    req.onsuccess = () => {
      const tx = req.result.transaction("conversations", "readwrite");
      const store = tx.objectStore("conversations");
      const conv = (id: string, title: string, at: number, extra: Record<string, unknown>, messages: unknown[]) =>
        store.put({ id, title, messages, createdAt: at, updatedAt: at, source: "editor", selectedModel: "auto", ...extra });
      conv("e1", "Add a contact form", now - 60_000, { projectRoot: root }, [
        { id: "m1", role: "user", content: "Add a contact form to the home page", timestamp: now - 120_000 },
        { id: "m2", role: "assistant", content: reply, timestamp: now - 60_000, toolEvents, turnId: "turn1", changedFiles: ["index.html", "src/styles.css"], usage: { cSats: 0, where: "This computer · qwen2.5-coder:7b" } },
      ]);
      conv("e2", "Fix the header layout on mobile", now - 3 * 3_600_000, { projectRoot: root }, [{ id: "m3", role: "user", content: "Fix the header layout on mobile", timestamp: now - 3 * 3_600_000 }]);
      conv("e3", "Add rate limiting", now - 86_400_000, { projectRoot: api }, [{ id: "m4", role: "user", content: "Add rate limiting", timestamp: now - 86_400_000 }]);
      conv("e4", "Lets build a website.", now - 30_000, {}, [
        { id: "m5", role: "user", content: "Lets build a website.", timestamp: now - 40_000 },
        { id: "m6", role: "assistant", content: generic, timestamp: now - 30_000 },
      ]);
      tx.oncomplete = () => req.result.close();
    };
    if (last) localStorage.setItem("edgecoder-last-editor-id", project ? "e1" : "e4");
  }, { now: NOW, root: ROOT, api: API, generic: GENERIC, reply: REPLY, toolEvents: TOOL_EVENTS, project, last });
}

async function open(page: Page, project: boolean, last = true) {
  await stub(page, { project });
  await seed(page, project, last);
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.titlebar = "overlay"; }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0, { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important} html[data-titlebar=overlay] body::after{content:'';position:fixed;left:18px;top:16px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;z-index:9999;pointer-events:none}" });
  await page.getByRole("tab", { name: /^(EdgeCoder|Code)$/ }).click();
  await page.waitForLoadState("networkidle");
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** Run a step the build may not have; false (and no screenshot) when it doesn't. */
async function maybe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1100, height: 720 },
];

for (const theme of ["dark", "light"] as const)
for (const vp of SIZES) {
  const tag = `${theme}-${vp.width}x${vp.height}`;
  test.describe(tag, () => {
    test.use({ viewport: vp });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("edgecoder-theme", t), theme);
    });

    test("no project", async ({ page }) => {
      await open(page, false);
      await shot(page, `code-noproject-${tag}`);
      const trigger = page.getByRole("banner").getByRole("button", { name: "New", exact: true });
      await trigger.click();
      await shot(page, `code-newmenu-${tag}`);
      await page.keyboard.press("Escape");
      if (await maybe(() => page.getByRole("button", { name: /^New project/ }).first().click({ timeout: 2_000 }))) {
        await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
        await shot(page, `code-newproject-${tag}`);
        await page.getByRole("dialog", { name: "New project" }).locator("label", { hasText: "Clone from GitHub" }).click();
        await shot(page, `code-newproject-clone-${tag}`);
      }
    });

    test("no project, new chat", async ({ page }) => {
      await open(page, false, false);
      await shot(page, `code-pickproject-${tag}`);
    });

    test("project open", async ({ page }) => {
      await open(page, true);
      await expect(page.getByText("contact form").first()).toBeVisible();
      await shot(page, `code-project-${tag}`);
      if (await maybe(() => page.getByRole("button", { name: /^Branch/ }).first().click({ timeout: 2_000 }))) {
        await shot(page, `code-branchmenu-${tag}`);
        await page.keyboard.press("Escape");
      }
      if (await maybe(() => page.getByRole("button", { name: /5 steps/ }).first().click({ timeout: 2_000 }))) {
        await maybe(() => page.getByRole("button", { name: /Edited index\.html/ }).first().click({ timeout: 2_000 }));
        await shot(page, `code-steps-${tag}`);
      }
      if (await maybe(() => page.getByRole("button", { name: "Files and editor" }).click({ timeout: 2_000 }))) {
        await page.locator(".explorer-panel").getByText("index.html").first().click();
        await page.waitForTimeout(800);
        await shot(page, `code-workspace-${tag}`);
      }
    });
  });
}

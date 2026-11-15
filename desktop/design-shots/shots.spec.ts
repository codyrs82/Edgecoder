// The six states the desktop-polish review compares, in both themes at two window sizes.
// Backend answers come from a11y/fixtures.ts plus the project, file and bot answers below.
import { expect, test, type Page } from "@playwright/test";
import { fixtureFor, NOT_FOUND } from "../a11y/fixtures";

const OUT = process.env.SHOTS_DIR ?? "shots";
const NOW = Date.now();
const USER = { userId: "u_shots", email: "cody@example.org", displayName: "Cody Smith", emailVerified: true };
const ROOT = "/Users/demo/EdgeCoder/website";

const REPLY = [
  "This component renders the chat composer and sends the message when you press **Enter**.",
  "",
  "## How it works",
  "",
  "1. `ChatInput` keeps the draft in a `$state` variable and grows the textarea as you type.",
  "2. On submit it trims the text, calls `onSend`, and clears the draft.",
  "3. While a reply streams, the send button turns into **Stop**.",
  "",
  "### The key handler",
  "",
  "```ts",
  "function onKeydown(e: KeyboardEvent) {",
  "  if (e.key === \"Enter\" && !e.shiftKey) {",
  "    e.preventDefault();",
  "    submit();",
  "  }",
  "}",
  "```",
  "",
  "- **Shift+Enter** inserts a newline instead of sending.",
  "- Mentions (`@file`) are expanded before the message is sent.",
  "",
  "Want me to add a test for the Shift+Enter case?",
].join("\n");

const BOTS = [
  {
    id: "bot_harry", name: "Harry", role: "Lead Developer", instructions: "", projectRoot: `${ROOT}`, enabled: true, schedule: "", budgetCSatsPerDay: 100,
    allowedTools: [], autoApproveEdits: false, color: "#e5484d", createdAtMs: NOW - 86_400_000, updatedAtMs: NOW, status: "idle", spentTodayCSats: 3, pending: [], queuedMessages: 0,
    lastRun: { id: "run_1", trigger: "message", startedAtMs: NOW - 600_000, endedAtMs: NOW - 540_000, status: "done", summary: '{"name": "git_status", "arguments": {}}', cSats: 0.4 },
  },
  {
    id: "bot_ada", name: "Ada", role: "Test runner", instructions: "", projectRoot: `${ROOT}`, enabled: true, schedule: "0 9 * * 1-5", budgetCSatsPerDay: 50,
    allowedTools: [], autoApproveEdits: false, color: "#3e63dd", createdAtMs: NOW - 86_400_000, updatedAtMs: NOW, status: "idle", spentTodayCSats: 0, pending: [], queuedMessages: 0,
    lastRun: { id: "run_2", trigger: "schedule", startedAtMs: NOW - 7_200_000, endedAtMs: NOW - 7_100_000, status: "done", summary: "All 214 tests pass on main.", cSats: 1.2 },
  },
];

const TREE: Record<string, Array<{ name: string; path: string; kind: "file" | "dir" }>> = {
  "": [
    { name: "src", path: "src", kind: "dir" },
    { name: "public", path: "public", kind: "dir" },
    { name: "index.html", path: "index.html", kind: "file" },
    { name: "package.json", path: "package.json", kind: "file" },
    { name: "README.md", path: "README.md", kind: "file" },
  ],
  src: [
    { name: "main.ts", path: "src/main.ts", kind: "file" },
    { name: "styles.css", path: "src/styles.css", kind: "file" },
  ],
};
const FILE = `import "./styles.css";\n\nconst app = document.querySelector<HTMLDivElement>("#app")!;\n\napp.innerHTML = \`\n  <h1>Hello, EdgeCoder</h1>\n  <p>Edit src/main.ts and save to reload.</p>\n\`;\n\nexport function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`;

async function stub(page: Page, opts: { project: boolean }) {
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, async (route) => {
    const url = route.request().url();
    if (/\/me(\?|$)/.test(url)) return route.fulfill({ status: 200, json: { user: USER } });
    if (/\/v1\/ide\/bots$/.test(url)) return route.fulfill({ status: 200, json: { bots: BOTS } });
    if (/\/v1\/ide\/project$/.test(url)) return route.fulfill({ status: 200, json: { projectRoot: opts.project ? ROOT : null } });
    if (/\/v1\/ide\/fs\/list/.test(url)) {
      const path = new URL(url).searchParams.get("path") ?? "";
      return route.fulfill({ status: 200, json: { entries: TREE[path] ?? [] } });
    }
    if (/\/v1\/ide\/fs\/read/.test(url)) return route.fulfill({ status: 200, json: { path: "src/main.ts", content: FILE, mtimeMs: NOW, size: FILE.length } });
    if (/\/v1\/ide\/fs\/git-status/.test(url)) return route.fulfill({ status: 200, json: { branch: "main", files: { "src/main.ts": "M" } } });
    if (/\/v1\/ide\/fs\/stat/.test(url)) return route.fulfill({ status: 200, json: { mtimes: { "src/main.ts": NOW } } });
    if (/\/v1\/ide\/project\/trust/.test(url)) return route.fulfill({ status: 200, json: { trusted: true, needsTrust: false } });
    if (/\/v1\/ide\/diagnostics/.test(url)) return route.fulfill({ status: 200, json: { diagnostics: [] } });
    const body = route.request().method() === "GET" ? fixtureFor(url) : {};
    if (body === NOT_FOUND) return route.fulfill({ status: 404, json: { error: "not_found" } });
    return route.fulfill({ status: 200, json: body });
  });
  await page.addInitScript(({ project, root }) => {
    localStorage.setItem("edgecoder_session_token", "shots-token");
    localStorage.setItem("edgecoder-starter-model", "done");
    if (project) localStorage.setItem("edgecoder-project-root", root);
  }, { project: opts.project, root: ROOT });
}

/** Chats in the app's IndexedDB store: one with a markdown reply (opened) and a few older ones. */
async function seed(page: Page, reply: string) {
  await page.addInitScript(({ reply, now }) => {
    const req = indexedDB.open("edgecoder-chat", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("conversations", { keyPath: "id" });
    req.onsuccess = () => {
      const tx = req.result.transaction("conversations", "readwrite");
      const store = tx.objectStore("conversations");
      const conv = (id: string, title: string, at: number, messages: unknown[] = []) => store.put({ id, title, messages, createdAt: at, updatedAt: at, source: "chat", selectedModel: "auto" });
      conv("c1", "Explain how this code works", now - 60_000, [
        { id: "m1", role: "user", content: "Explain how this code works", timestamp: now - 70_000 },
        { id: "m2", role: "assistant", content: reply, timestamp: now - 60_000, usage: { cSats: 0, where: "This computer · qwen2.5-coder:7b" } },
      ]);
      conv("c2", "Help me write tests", now - 3_600_000, [{ id: "m3", role: "user", content: "Help me write tests", timestamp: now - 3_600_000 }]);
      conv("c3", "Set up the deploy workflow", now - 2 * 86_400_000, [{ id: "m4", role: "user", content: "Set up the deploy workflow", timestamp: now - 2 * 86_400_000 }]);
      conv("c4", "Why is the build slow?", now - 9 * 86_400_000, [{ id: "m5", role: "user", content: "Why is the build slow?", timestamp: now - 9 * 86_400_000 }]);
      tx.oncomplete = () => req.result.close();
    };
    localStorage.setItem("edgecoder-last-chat-id", "c1");
  }, { reply, now: NOW });
}

async function open(page: Page, project = false) {
  await stub(page, { project });
  await seed(page, REPLY);
  // The app window on macOS draws its own title bar around the traffic lights (main.ts sets this
  // in the app). SIM_TITLEBAR=1 does the same here and paints stand-in lights where macOS puts them.
  if (process.env.SIM_TITLEBAR) {
    await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.titlebar = "overlay"; }));
  }
  await page.goto("/");
  await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0, { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  // Hide first-run overlays that are not part of these states.
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
  if (process.env.SIM_TITLEBAR) {
    await page.addStyleTag({ content: "html[data-titlebar=overlay] body::after{content:'';position:fixed;left:18px;top:16px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;z-index:9999;pointer-events:none}" });
  }
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function editorTab(page: Page) {
  await page.getByRole("tab", { name: /^(EdgeCoder|Code)$/ }).click();
  await page.waitForLoadState("networkidle");
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

    test("chat states, bots and settings", async ({ page }) => {
      await open(page);
      await expect(page.getByText("How it works").first()).toBeVisible();
      await shot(page, `chat-reply-${tag}`);
      await shot(page, `bots-list-${tag}`);
      await page.getByRole("button", { name: /^New chat$/ }).first().click();
      await shot(page, `chat-empty-${tag}`);
      await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await shot(page, `settings-${tag}`);
    });

    test("coding view, no folder", async ({ page }) => {
      await open(page);
      await editorTab(page);
      await shot(page, `coding-nofolder-${tag}`);
    });

    test("coding view, folder open", async ({ page }) => {
      await open(page, true);
      await editorTab(page);
      // The Code view is chat-first; the files and editor come in on this toggle.
      await page.getByRole("button", { name: "Files and editor" }).click({ timeout: 2_000 }).catch(() => {});
      await page.getByText("main.ts").first().click({ timeout: 5_000 }).catch(async () => {
        await page.getByText("src", { exact: true }).first().click();
        await page.getByText("main.ts").first().click();
      });
      await page.waitForTimeout(800);
      await shot(page, `coding-folder-${tag}`);
    });
  });
}

// Every settings section (SECTIONS=1), dark at 1440x900: a review aid, not one of the six states.
test.describe("settings sections", () => {
  test.skip(!process.env.SECTIONS, "SECTIONS=1 only");
  test.use({ viewport: SIZES[0] });
  test("each section", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => localStorage.setItem("edgecoder-theme", "dark"));
    await open(page);
    await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
    const tabs = page.getByRole("dialog", { name: "Settings" }).getByRole("tab");
    for (let i = 0; i < (await tabs.count()); i++) {
      const name = ((await tabs.nth(i).textContent()) ?? String(i)).trim().toLowerCase().replace(/\W+/g, "-");
      await tabs.nth(i).click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1200);
      await shot(page, `section-${name}`);
    }
  });
});

// Settings > Network, the world view (NETWORK_WORLD=1): graph with a machine selected, and cards,
// in both themes, against a11y/world-fixture.ts.
test.describe("network world view", () => {
  test.skip(!process.env.NETWORK_WORLD, "NETWORK_WORLD=1 only");
  test.use({ viewport: SIZES[0] });
  for (const theme of ["light", "dark"] as const) {
    test(theme, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("edgecoder-theme", t), theme);
      await open(page);
      await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
      await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Network" }).click();
      const graph = page.getByRole("group", { name: /network graph/i });
      await expect(graph).toBeVisible();
      await graph.getByRole("button", { name: /3f2a/ }).click();
      await shot(page, `network-world-graph-${theme}`);
      await page.getByRole("button", { name: "Cards" }).click();
      await shot(page, `network-world-cards-${theme}`);
    });
  }
});

// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Records one Getting started step for its explainer video (docs/videos/README.md).
//
// Serves the real portal pages (registerPortalPages) on 127.0.0.1 with fixture data for every
// /portal/api call and /me, so nothing reaches a real account, then opens /portal/welcome/<step>
// in Chromium at 1280×720, dark theme, with Playwright's video capture on, and highlights what each
// narration segment talks about at that segment's time (the timeline from build.mjs).
//
// Usage (build.mjs runs it):
//   node --import tsx scripts/videos/record.mjs <timeline.json> <out-dir>
// Writes <out-dir>/screen.webm and <out-dir>/record.json ({ offset }: seconds of page loading at
// the start of the recording, which the mux trims off).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { chromium } from "playwright";
import { registerPortalPages } from "../../src/portal/pages/index.js";

const [timelinePath, outDir] = process.argv.slice(2);
if (!timelinePath || !outDir) {
  console.error("usage: node --import tsx scripts/videos/record.mjs <timeline.json> <out-dir>");
  process.exit(2);
}
const tl = JSON.parse(readFileSync(timelinePath, "utf8"));
mkdirSync(outDir, { recursive: true });

const SIZE = { width: 1280, height: 720 };
const STEP_ORDER = ["welcome", "how", "this-machine", "machines", "models", "fund", "tools", "try", "host", "done"];
const done = STEP_ORDER.slice(0, Math.max(0, STEP_ORDER.indexOf(tl.step)));

/** A made-up new account: no machines or cSats yet, the steps before this one done. */
const FIXTURES = {
  "/me": { user: { email: "demo@example.com", displayName: "Demo", roles: {} } },
  "/portal/api/compute/summary": { connected: true, cSats: 0 },
  "/portal/api/onboarding": {
    state: { goal: "both", done, skipped: [], current: tl.step, routing: null, dismissed: false, completedAtMs: null, firstSeenAtMs: 1, firstTaskAtMs: null, updatedAtMs: 1 },
    signals: { machines: 0, machinesOnline: 0, balanceCSats: 0, apiKeys: 0, github: false, firstTask: false, hostApproved: false, hostRequested: false, newAccount: true, localModels: null, cliInstalled: null },
  },
  "/portal/api/wallet/overview": { models: [{ model: "qwen3-coder:30b", cSatsPerMTokens: { input: 322.7, output: 939.8 } }], btcUsd: 176600, launch: { mode: "invite", maxBuySatsPerDay: 50000 } },
  "/portal/api/wallet/onchain": { enabled: false },
};

const HIGHLIGHT_CSS = `
  html { scrollbar-width: none; }
  ::-webkit-scrollbar { display: none; }
  /* The step's own video player (this recording, once shipped) stays out of the recording. */
  .wz-video { display: none !important; }
  .wz-card, #wzNext, .wz-panel h2 { transition: opacity .35s ease, transform .35s ease, box-shadow .35s ease, outline-color .35s ease; }
  .vid-dim .wz-card { opacity: .38; }
  .vid-dim .wz-card.vid-on { opacity: 1; }
  .wz-card.vid-on { outline: 2px solid var(--brand); outline-offset: 0; transform: translateY(-2px) scale(1.03); box-shadow: 0 6px 24px rgba(0,0,0,.35); }
  .vid-on:not(.wz-card):not(#wzNext) { outline: 2px solid var(--brand); outline-offset: 4px; border-radius: var(--radius-sm); transition: outline-color .35s ease; }
  #wzNext.vid-on { transform: scale(1.08); box-shadow: 0 0 0 4px var(--brand-soft, rgba(120,120,255,.3)); }
`;

const app = Fastify();
registerPortalPages(app);
await app.listen({ host: "127.0.0.1", port: 0 });
const { port } = app.server.address();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, colorScheme: "dark", recordVideo: { dir: outDir, size: SIZE } });
  await context.addInitScript(() => { try { localStorage.setItem("edgecoder-theme", "dark"); } catch {} });
  await context.route(/\/(me|portal\/api\/.*|dashboard\/summary)(\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === "POST" ? FIXTURES["/portal/api/onboarding"] : FIXTURES[path] ?? {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const t0 = Date.now();
  const page = await context.newPage();
  await page.goto(`${base}/portal/welcome/${tl.step}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: HIGHLIGHT_CSS });
  await page.waitForSelector(`[data-video-anchor="welcome-${tl.step}"]`);
  await page.evaluate(() => document.fonts.ready);
  // The guide re-renders every 10 s to pick up account changes; stop that so highlights stay put.
  await page.evaluate(() => { const top = setInterval(() => {}, 1e6); for (let i = 1; i <= top; i++) clearInterval(i); });
  // Keyboard focus on the title draws a ring; the video doesn't need it.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(400);
  const offset = (Date.now() - t0) / 1000;
  const start = Date.now();

  for (const seg of tl.segments) {
    const wait = seg.focusAt * 1000 - (Date.now() - start);
    if (wait > 0) await page.waitForTimeout(wait);
    await page.evaluate((focus) => {
      const panel = document.querySelector(".wz-panel");
      document.querySelectorAll(".vid-on").forEach((e) => e.classList.remove("vid-on"));
      panel.classList.remove("vid-dim");
      const kind = focus.split(":")[0], n = focus.slice(kind.length + 1);
      const lists = document.querySelectorAll(".wz-panel .wz-cards");
      let targets = [];
      if (kind === "card") targets = [lists[0]?.children[Number(n) - 1]];
      else if (kind === "more" && n) targets = [lists[1]?.children[Number(n) - 1]];
      else if (kind === "more") targets = Array.from(lists[1]?.children ?? []);
      else if (kind === "next") targets = [document.getElementById("wzNext")];
      else if (kind === "sel") targets = Array.from(document.querySelectorAll(n));
      targets = targets.filter(Boolean);
      if (kind === "card" || kind === "more") panel.classList.add("vid-dim");
      targets.forEach((t) => t.classList.add("vid-on"));
      const first = targets[0];
      if (kind === "title") window.scrollTo({ top: 0, behavior: "smooth" });
      else if (first) {
        const r = first.getBoundingClientRect();
        if (r.top < 60 || r.bottom > window.innerHeight - 40) window.scrollBy({ top: r.top - window.innerHeight / 2 + r.height / 2, behavior: "smooth" });
      }
    }, seg.focus);
  }
  const rest = tl.total * 1000 - (Date.now() - start);
  if (rest > 0) await page.waitForTimeout(rest + 300);
  const video = page.video();
  await context.close();
  renameSync(await video.path(), join(outDir, "screen.webm"));
  writeFileSync(join(outDir, "record.json"), JSON.stringify({ offset }, null, 2));
  console.log(`record: ${join(outDir, "screen.webm")} (trim ${offset.toFixed(2)} s of loading)`);
} finally {
  await browser.close();
  await app.close();
}

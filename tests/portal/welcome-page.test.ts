import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import * as O from "../../src/common/onboarding.js";
import { CLIENT_ESCAPE_JS } from "../../src/portal/pages/escape.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { ONBOARDING_BROWSER_LIB, WELCOME_RENDER_SCRIPT } from "../../src/portal/pages/welcome.js";

async function page(url: string): Promise<string> {
  const app = Fastify();
  registerPortalPages(app);
  const res = await app.inject({ url });
  await app.close();
  expect(res.statusCode, url).toBe(200);
  return res.body;
}

const SIGNALS: O.OnboardingSignals = {
  machines: 1, machinesOnline: 1, balanceCSats: 0, apiKeys: 0, github: false, firstTask: false,
  hostApproved: false, hostRequested: false, newAccount: true, localModels: null, cliInstalled: null
};

type Render = { wzPanel(ctx: unknown): string; wzStepNav(ctx: unknown): string };
const R = new Function(`${CLIENT_ESCAPE_JS}; ${ONBOARDING_BROWSER_LIB}; ${WELCOME_RENDER_SCRIPT}; return { wzPanel, wzStepNav };`)() as Render;
const ctx = (current: O.StepId, over: Record<string, unknown> = {}) => ({
  state: { ...O.emptyOnboardingState(0), current, goal: "both" },
  signals: SIGNALS,
  origin: "https://edgecoder.io",
  wallet: { models: [{ model: "qwen3-coder:30b", cSatsPerMTokens: { input: 322.7, output: 939.8 } }], btcUsd: 176_600, launch: { mode: "invite", maxBuySatsPerDay: 50_000 } },
  onchain: false,
  calls: 100,
  classId: "35b",
  ...over
});

describe("/portal/welcome (Getting started on the web)", () => {
  it("serves the guide and one stable URL per step, in the Settings frame", async () => {
    const html = await page("/portal/welcome");
    expect(html).toContain('<h1 id="wzHeading">Getting started</h1>');
    expect(html).toContain('aria-label="Getting started steps"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('<progress class="wz-progress"');
    expect(html).toContain('href="/portal/welcome"');
    for (const id of O.STEP_IDS) expect((await page(`/portal/welcome/${id}`)).length).toBeGreaterThan(1000);
  });

  it("is reachable from Settings and the account menu", async () => {
    const html = await page("/portal/settings");
    expect(html).toMatch(/<a class="settings-link" href="\/portal\/welcome" data-section="welcome">.*Getting started/);
    expect(html).toMatch(/role="menuitem" tabindex="-1" href="\/portal\/welcome"/);
  });

  it("the overview sends a new account to the guide once per session", async () => {
    const html = await page("/portal/dashboard");
    expect(html).toContain('api("/portal/api/onboarding"');
    expect(html).toContain("edgecoder-welcome-offered");
  });

  it("each step panel has a heading, the video anchor and a video slot, hidden until the step has a video", () => {
    for (const id of O.STEP_IDS) {
      const html = R.wzPanel(ctx(id));
      expect(html).toContain(`data-video-anchor='welcome-${id}'`);
      if (O.stepById(id).video.src) expect(html).toContain(`<div class='wz-video' data-video-slot='${id}'><video `);
      else expect(html).toContain(`<div class='wz-video' data-video-slot='${id}' hidden></div>`);
      expect(html).toContain("<h2 id='wzTitle' tabindex='-1'>");
      expect(html).not.toMatch(/\sstyle\s*=/);
    }
  });

  it("How EdgeCoder works shows its explainer video with a poster and English captions", () => {
    const html = R.wzPanel(ctx("how"));
    expect(html).toContain("<div class='wz-video' data-video-slot='how'><video controls preload='none' src='/assets/videos/how-it-works.mp4' poster='/assets/videos/how-it-works.jpg'>");
    expect(html).toContain("<track kind='captions' srclang='en' label='English' default src='/assets/videos/how-it-works.vtt'>");
    // The page the browser gets carries the same video settings.
    expect(ONBOARDING_BROWSER_LIB).toContain('"src":"/assets/videos/how-it-works.mp4"');
  });

  it("shows a video with captions once a step has one", () => {
    const step = O.stepById("tools");
    const saved = step.video;
    step.video = { src: "/v/tools.mp4", poster: "/v/tools.jpg", captions: "/v/tools.vtt" };
    try {
      const R2 = new Function(`${CLIENT_ESCAPE_JS}; ${ONBOARDING_BROWSER_LIB.replace(/var ONBOARDING_STEPS = .*;/, `var ONBOARDING_STEPS = ${JSON.stringify(O.ONBOARDING_STEPS)};`)}; ${WELCOME_RENDER_SCRIPT}; return { wzPanel };`)() as Render;
      const html = R2.wzPanel(ctx("tools"));
      expect(html).toContain("<video controls preload='none' src='/v/tools.mp4' poster='/v/tools.jpg'>");
      expect(html).toContain("<track kind='captions' srclang='en' label='English' default src='/v/tools.vtt'>");
    } finally {
      step.video = saved;
    }
  });

  it("serves the video files: whole, by byte range, and never outside the videos folder", async () => {
    const app = Fastify();
    registerPortalPages(app);
    try {
      const mp4 = await app.inject({ url: "/assets/videos/how-it-works.mp4" });
      expect(mp4.statusCode).toBe(200);
      expect(mp4.headers["content-type"]).toBe("video/mp4");
      expect(mp4.headers["accept-ranges"]).toBe("bytes");
      expect(mp4.headers["access-control-allow-origin"]).toBe("*");
      expect(mp4.rawPayload.subarray(4, 8).toString("ascii")).toBe("ftyp");
      expect(mp4.rawPayload.length).toBeLessThan(8_000_000);

      const part = await app.inject({ url: "/assets/videos/how-it-works.mp4", headers: { range: "bytes=0-99" } });
      expect(part.statusCode).toBe(206);
      expect(part.headers["content-range"]).toBe(`bytes 0-99/${mp4.rawPayload.length}`);
      expect(part.rawPayload.equals(mp4.rawPayload.subarray(0, 100))).toBe(true);
      const tail = await app.inject({ url: "/assets/videos/how-it-works.mp4", headers: { range: "bytes=-10" } });
      expect(tail.rawPayload.equals(mp4.rawPayload.subarray(-10))).toBe(true);
      expect((await app.inject({ url: "/assets/videos/how-it-works.mp4", headers: { range: `bytes=${mp4.rawPayload.length}-` } })).statusCode).toBe(416);

      const vtt = await app.inject({ url: "/assets/videos/how-it-works.vtt" });
      expect(vtt.headers["content-type"]).toBe("text/vtt; charset=utf-8");
      expect(vtt.body.startsWith("WEBVTT")).toBe(true);
      expect((await app.inject({ url: "/assets/videos/how-it-works.webm" })).headers["content-type"]).toBe("video/webm");
      expect((await app.inject({ url: "/assets/videos/how-it-works.jpg" })).headers["content-type"]).toBe("image/jpeg");

      for (const bad of ["/assets/videos/nope.mp4", "/assets/videos/..%2Fassets.ts", "/assets/videos/README.md", "/assets/videos/how-it-works.mp4.bak"]) {
        expect((await app.inject({ url: bad })).statusCode, bad).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("machines: installer command and download links, not local detection; the Local Network note", () => {
    const html = R.wzPanel(ctx("machines"));
    expect(html).toContain("curl -fsSLo install.sh https://edgecoder.io/install.sh &amp;&amp; sudo bash install.sh --token YOUR_TOKEN");
    expect(html).toContain("Local Network");
    expect(html).toContain("Machines on your account: <strong id='wzMachineCount'>1</strong>");
    expect(R.wzPanel(ctx("this-machine"))).toContain("Download for Mac");
    expect(R.wzPanel(ctx("this-machine"))).not.toContain("Download the suggested model");
  });

  it("fund: the estimator from live prices, Lightning live and Bitcoin coming soon", () => {
    const html = R.wzPanel(ctx("fund"));
    expect(html).toContain("Fund with Lightning");
    expect(html).toMatch(/<button type='button' class='wz-btn' disabled aria-describedby='wzOnchainSoon'>Fund with Bitcoin<\/button> <span id='wzOnchainSoon' class='wz-muted'>Coming soon<\/span>/);
    expect(html).toMatch(/XL \(20–35B\)<\/td><td class='num'>2\.\d<\/td><td class='num'>about 3\d\d</);
    expect(html).toContain("Early access: up to 50,000 sats a day.");
    expect(html.toLowerCase()).not.toContain("invoice");
    expect(R.wzPanel(ctx("fund", { onchain: true }))).toContain("<a class='wz-btn' href='/portal/settings/plan'>Fund with Bitcoin</a>");
  });

  it("checklists say done or not yet in words, and the step list marks the current step", () => {
    const html = R.wzPanel(ctx("this-machine"));
    expect(html).toContain("<span class='wz-sr'>: Done</span>");
    const nav = R.wzStepNav(ctx("fund"));
    expect(nav).toContain("data-step='fund' class='wz-step-link' aria-current='step'");
    expect(nav).toContain("href='/portal/welcome/machines'");
  });

  it("hides a checklist that repeats the step's choice; the step list tells moved-past steps from ones complete ahead", () => {
    expect(R.wzPanel(ctx("welcome"))).not.toContain("wz-checklist");
    expect(R.wzPanel(ctx("models"))).not.toContain("data-item='routing'");
    expect(R.wzPanel(ctx("fund"))).toContain("data-item='funded'");
    const c = ctx("how", { state: { ...O.emptyOnboardingState(0), current: "how", goal: "both", done: ["welcome"] } });
    const nav = R.wzStepNav(c);
    expect(nav).toContain("data-step='welcome' class='wz-step-link done'");
    // this-machine is complete from the account (a machine is connected) but not reached: quieter.
    expect(nav).toContain("data-step='this-machine' class='wz-step-link ready'");
    expect(nav).toContain("data-step='how' class='wz-step-link' aria-current='step'");
    expect(nav).toContain("<span class='wz-step-label'>Choose models and where they run</span>");
  });

  it("centres the guide in the wide Settings pane", async () => {
    const html = await page("/portal/welcome");
    expect(html).toContain('<div class="wz-wrap">');
    expect(html).toMatch(/\.wz-wrap \{ max-width: \d+px; margin: 0 auto; \}/);
  });
});

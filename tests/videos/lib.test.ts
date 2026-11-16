import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as O from "../../src/common/onboarding.js";
// @ts-expect-error plain .mjs build helpers, no type declarations
import * as V from "../../scripts/videos/lib.mjs";

/* The explainer video pipeline (scripts/videos, docs/videos/README.md): the parts that need no TTS,
 * browser or ffmpeg. */

describe("explainer video scripts", () => {
  it("How EdgeCoder works: one segment per card, in the cards' order, then Next", () => {
    const s = V.scriptForStep("how");
    expect(s.meta).toMatchObject({ step: "how", name: "how-it-works" });
    expect(s.segments.map((x: { focus: string }) => x.focus)).toEqual([
      "title", ...O.HOW_CARDS.map((_, i) => `card:${i + 1}`), ...O.HOW_MORE.map((_, i) => `more:${i + 1}`), "next",
    ]);
    const text = s.segments.map((x: { text: string }) => x.text).join(" ");
    // The facts the owner asked to get right.
    expect(text).toContain("One cSat is one sat.");
    expect(text).toContain("Hosts keep 95 percent");
    expect(text).toContain("not end to end");
    expect(text).toContain("/remote");
    expect(text.toLowerCase()).not.toContain("end-to-end encrypted");
  });

  it("every script names a real step and a video the step points at", () => {
    for (const id of O.STEP_IDS) {
      const s = V.scriptForStep(id);
      if (!s) continue;
      const v = O.stepById(id).video;
      if (v.src) expect(v.src).toBe(`/assets/videos/${s.meta.name}.mp4`);
    }
    expect(() => V.parseScript("no front matter")).toThrow(/front matter/);
    expect(() => V.parseScript("---\nstep: how\nname: x\ntitle: X\n---\n### a\nfocus: sideways\n\nHi.\n")).toThrow(/bad focus/);
  });

  it("the voice says cSats and /remote the way they are meant; captions keep the written form", () => {
    expect(V.spokenText("1 cSat = 1 sat; 10 cSats. Type /remote in edgecoder code.")).toBe("1 see sat = 1 sat; 10 see sats. Type forward slash remote in edge coder code.");
  });

  it("timeline and captions follow the audio lengths", () => {
    const segs = [{ id: "a", focus: "title", text: "One. Two two." }, { id: "b", focus: "next", text: "Three." }];
    const tl = V.timeline(segs, [2, 1]);
    expect(tl.segments[0]).toMatchObject({ start: V.LEAD_IN_S, end: V.LEAD_IN_S + 2 });
    // The highlight lands a moment before the voice.
    expect(tl.segments[1].focusAt).toBeCloseTo(tl.segments[1].start - V.FOCUS_LEAD_S);
    expect(tl.segments[1].start).toBeCloseTo(V.LEAD_IN_S + 2 + V.GAP_S);
    expect(tl.total).toBeCloseTo(tl.segments[1].end + V.TAIL_S);
    const vtt = V.toVtt(tl);
    expect(vtt.startsWith("WEBVTT\n\n1\n00:00:01.000 --> ")).toBe(true);
    expect(vtt.match(/-->/g)).toHaveLength(3);
    expect(vtt).toContain("\nTwo two.\n");
  });

  it("WAV in and out (16-bit mono), clips placed at their start times", () => {
    const pcm = Buffer.alloc(200, 1);
    const wav = V.wavFile(1000, pcm);
    expect(V.readWav(wav)).toEqual({ rate: 1000, samples: pcm });
    const tl = { segments: [{ start: 0.5, end: 0.6 }], total: 1 };
    const out = V.readWav(V.mixNarration(1000, [pcm], tl));
    expect(out.samples.length).toBe(2000);
    expect(out.samples[999]).toBe(0);
    expect(out.samples[1000]).toBe(1);
  });

  it("the shipped captions are the How EdgeCoder works script", () => {
    const vtt = readFileSync(new URL("../../src/portal/assets/videos/how-it-works.vtt", import.meta.url), "utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("One cSat is one sat.");
  });
});

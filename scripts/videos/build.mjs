#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Builds the explainer video for one Getting started step (docs/videos/README.md):
//   1. narration: each segment of docs/videos/scripts/<name>.md spoken by Piper (local, offline),
//      or macOS `say` when Piper isn't set up;
//   2. timeline + WebVTT captions from the segments' audio lengths;
//   3. screen: record.mjs walks /portal/welcome/<step> with fixture data, in time with the narration;
//   4. mux with ffmpeg: H.264/AAC MP4, VP9/Opus WebM, a JPEG poster;
//   5. copies <name>.{mp4,webm,vtt,jpg} to src/portal/assets/videos/ (served at /assets/videos/).
//
// Usage: node scripts/videos/build.mjs <step> [--say] [--no-copy]
// Env:   PIPER_PYTHON  python with piper-tts installed   (default: $VIDEO_WORK_DIR/piper-venv/bin/python)
//        PIPER_VOICE   voice model .onnx                 (default: $VIDEO_WORK_DIR/voices/<script voice>.onnx)
//        SAY_VOICE     macOS voice for the fallback      (default: Samantha)
//        VIDEO_WORK_DIR intermediate files              (default: <tmp>/edgecoder-videos)
// Needs ffmpeg/ffprobe on PATH and Playwright's Chromium (npx playwright install chromium).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { LENGTH_SCALE, PORTAL_VIDEO_DIR, ROOT, SENTENCE_SILENCE_S, mixNarration, readWav, scriptForStep, spokenText, timeline, toVtt } from "./lib.mjs";

const args = process.argv.slice(2);
const step = args.find((a) => !a.startsWith("--"));
if (!step) {
  console.error("usage: node scripts/videos/build.mjs <step> [--say] [--no-copy]");
  process.exit(2);
}
const script = scriptForStep(step);
if (!script) {
  console.error(`build: no script for step "${step}" in docs/videos/scripts/ (front matter step: ${step})`);
  process.exit(1);
}
const name = script.meta.name;
const WORK_ROOT = process.env.VIDEO_WORK_DIR || join(tmpdir(), "edgecoder-videos");
const work = join(WORK_ROOT, name);
mkdirSync(join(work, "segments"), { recursive: true });

/** This build is meant for a shared laptop: wait while the machine is busy, stop when disk is low. */
function guard(what) {
  const free = (() => { const s = statfsSync(WORK_ROOT); return (s.bavail * s.bsize) / 1e9; })();
  if (free < 10) throw new Error(`build: only ${free.toFixed(1)} GB free; stopping before ${what}`);
  for (let i = 0; loadavg()[0] > 30; i++) {
    if (i >= 60) throw new Error(`build: load still ${loadavg()[0].toFixed(1)} after 10 minutes; stopping before ${what}`);
    if (i === 0) console.log(`build: load ${loadavg()[0].toFixed(1)}, waiting before ${what}`);
    spawnSync("sleep", ["10"]);
  }
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync("nice", ["-n", "10", cmd, ...argv], { stdio: ["pipe", "inherit", "inherit"], ...opts });
  if (r.status !== 0) throw new Error(`build: ${cmd} failed (exit ${r.status})`);
}

// ── 1. Narration ──

const PIPER_PYTHON = process.env.PIPER_PYTHON || join(WORK_ROOT, "piper-venv/bin/python");
const PIPER_VOICE = process.env.PIPER_VOICE || join(WORK_ROOT, "voices", `${script.meta.voice || "en_GB-cori-high"}.onnx`);
const usePiper = !args.includes("--say") && existsSync(PIPER_PYTHON) && existsSync(PIPER_VOICE);

// espeak-ng (inside Piper) silently ignores a data path over 160 characters, so the helper runs
// from Piper's package folder and passes the data folder relative to it.
const PIPER_HELPER = `
import json, sys, wave
from piper import PiperVoice, SynthesisConfig
job = json.load(sys.stdin)
voice = PiperVoice.load(job["model"], espeak_data_dir="espeak-ng-data")
cfg = SynthesisConfig(length_scale=job["lengthScale"])
silence = bytes(int(voice.config.sample_rate * job["sentenceSilence"]) * 2)
for item in job["items"]:
    with wave.open(item["out"], "wb") as w:
        for i, chunk in enumerate(voice.synthesize(item["text"], cfg)):
            if i == 0:
                w.setframerate(chunk.sample_rate); w.setsampwidth(2); w.setnchannels(1)
            else:
                w.writeframes(silence)
            w.writeframes(chunk.audio_int16_bytes)
`;

const segWav = (s) => join(work, "segments", `${s.id}.wav`);
guard("narration");
if (usePiper) {
  const pkg = execFileSync(PIPER_PYTHON, ["-I", "-c", "import os, piper; print(os.path.dirname(piper.__file__))"], { encoding: "utf8" }).trim();
  const job = { model: PIPER_VOICE, lengthScale: LENGTH_SCALE, sentenceSilence: SENTENCE_SILENCE_S, items: script.segments.map((s) => ({ text: spokenText(s.text), out: segWav(s) })) };
  run(PIPER_PYTHON, ["-I", "-c", PIPER_HELPER], { cwd: pkg, input: JSON.stringify(job) });
  console.log(`narration: Piper, ${PIPER_VOICE.split("/").pop()}`);
} else {
  const voice = process.env.SAY_VOICE || "Samantha";
  for (const s of script.segments) run("say", ["-v", voice, "-r", "160", "--file-format=WAVE", "--data-format=LEI16@22050", "-o", segWav(s), spokenText(s.text)]);
  console.log(`narration: macOS say, ${voice}`);
}
const clips = script.segments.map((s) => readWav(readFileSync(segWav(s))));
const rate = clips[0].rate;
if (clips.some((c) => c.rate !== rate)) throw new Error("build: segments have different sample rates");

// ── 2. Timeline and captions ──

const tl = { step, name, ...timeline(script.segments, clips.map((c) => c.samples.length / 2 / rate)) };
writeFileSync(join(work, "timeline.json"), JSON.stringify(tl, null, 2));
writeFileSync(join(work, "narration.wav"), mixNarration(rate, clips.map((c) => c.samples), tl));
writeFileSync(join(work, `${name}.vtt`), toVtt(tl));
console.log(`timeline: ${tl.segments.length} segments, ${tl.total.toFixed(1)} s`);

// ── 3. Screen ──

guard("recording");
run("node", ["--import", "tsx", join(ROOT, "scripts/videos/record.mjs"), join(work, "timeline.json"), work], { cwd: ROOT });
const { offset } = JSON.parse(readFileSync(join(work, "record.json"), "utf8"));

// ── 4. Mux ──

const T = tl.total.toFixed(2);
const inputs = ["-y", "-hide_banner", "-loglevel", "error", "-ss", offset.toFixed(2), "-i", join(work, "screen.webm"), "-i", join(work, "narration.wav")];
const audio = ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ac", "1", "-ar", "48000"];
const common = ["-map", "0:v:0", "-map", "1:a:0", "-r", "25", "-t", T, "-threads", "4"];
guard("MP4 encode");
run("ffmpeg", [...inputs, ...common, "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-tune", "stillimage", "-pix_fmt", "yuv420p", ...audio, "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", join(work, `${name}.mp4`)]);
guard("WebM encode");
run("ffmpeg", [...inputs, ...common, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", ...audio, "-c:a", "libopus", "-b:a", "48k", join(work, `${name}.webm`)]);
// Poster: the middle of the first segment (the step as it opens, nothing highlighted yet).
const first = tl.segments[0];
run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", ((first.start + first.end) / 2).toFixed(2), "-i", join(work, `${name}.mp4`), "-frames:v", "1", "-q:v", "4", join(work, `${name}.jpg`)]);

// ── 5. Results ──

const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());
const files = ["mp4", "webm", "vtt", "jpg"].map((ext) => join(work, `${name}.${ext}`));
for (const f of files) console.log(`${f}  ${(statSync(f).size / 1e6).toFixed(2)} MB${/\.(mp4|webm)$/.test(f) ? `  ${probe(f).toFixed(1)} s` : ""}`);
if (!args.includes("--no-copy")) {
  mkdirSync(PORTAL_VIDEO_DIR, { recursive: true });
  for (const f of files) copyFileSync(f, join(PORTAL_VIDEO_DIR, f.split("/").pop()));
  console.log(`copied to ${PORTAL_VIDEO_DIR}`);
}

#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// Builds the explainer video for one Getting started step (docs/videos/README.md):
//   1. narration: each segment of docs/videos/scripts/<name>.md spoken by Kokoro or Piper (local,
//      offline), or macOS `say` when neither is set up;
//   2. timeline + WebVTT captions from the segments' audio lengths;
//   3. screen: record.mjs walks /portal/welcome/<step> with fixture data, in time with the narration;
//   4. mux with ffmpeg: H.264/AAC MP4, VP9/Opus WebM, a JPEG poster;
//   5. copies <name>.{mp4,webm,vtt,jpg} to src/portal/assets/videos/ (served at /assets/videos/).
//
// Usage: node scripts/videos/build.mjs <step> [--tts=piper|kokoro|say] [--voice=<id>] [--tag=<t>] [--no-copy]
//   The script's front matter picks the engine (`tts:`, default kokoro) and `voice:` (default
//   af_heart for Kokoro, en_GB-cori-high for Piper); the flags
//   override them for a trial. --tag=<t> names the files <name>-<t>.* and leaves the repo alone.
// Env:   KOKORO_PYTHON python with kokoro-onnx installed  (default: $VIDEO_WORK_DIR/kokoro-venv/bin/python)
//        KOKORO_DIR    kokoro-v1.0.onnx + voices-v1.0.bin  (default: $VIDEO_WORK_DIR/kokoro)
//        PIPER_PYTHON  python with piper-tts installed   (default: $VIDEO_WORK_DIR/piper-venv/bin/python)
//        PIPER_VOICE   voice model .onnx                 (default: $VIDEO_WORK_DIR/voices/<script voice>.onnx)
//        SAY_VOICE     macOS voice for the fallback      (default: Samantha)
//        VIDEO_WORK_DIR intermediate files              (default: <tmp>/edgecoder-videos)
// Needs ffmpeg/ffprobe on PATH and Playwright's Chromium (npx playwright install chromium).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { KOKORO_SPEED, LENGTH_SCALE, PORTAL_VIDEO_DIR, ROOT, SENTENCE_SILENCE_S, mixNarration, readWav, scriptForStep, spokenText, timeline, toVtt } from "./lib.mjs";

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
const flag = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const tag = flag("tag");
const name = tag ? `${script.meta.name}-${tag}` : script.meta.name;
const tts = args.includes("--say") ? "say" : flag("tts") || script.meta.tts || "kokoro";
const voiceId = flag("voice") || script.meta.voice;
if (!["piper", "kokoro", "say"].includes(tts)) throw new Error(`build: unknown tts "${tts}" (piper, kokoro or say)`);
const copyToRepo = !args.includes("--no-copy") && !tag;
const WORK_ROOT = process.env.VIDEO_WORK_DIR || join(tmpdir(), "edgecoder-videos");
const work = join(WORK_ROOT, script.meta.name);
mkdirSync(join(work, `segments-${tag || "main"}`), { recursive: true });

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
const PIPER_VOICE = process.env.PIPER_VOICE || join(WORK_ROOT, "voices", `${voiceId || "en_GB-cori-high"}.onnx`);
const KOKORO_PYTHON = process.env.KOKORO_PYTHON || join(WORK_ROOT, "kokoro-venv/bin/python");
const KOKORO_DIR = process.env.KOKORO_DIR || join(WORK_ROOT, "kokoro");
const KOKORO_FILES = [join(KOKORO_DIR, "kokoro-v1.0.onnx"), join(KOKORO_DIR, "voices-v1.0.bin")];
const usePiper = tts === "piper" && existsSync(PIPER_PYTHON) && existsSync(PIPER_VOICE);
const useKokoro = tts === "kokoro" && existsSync(KOKORO_PYTHON) && KOKORO_FILES.every((f) => existsSync(f));
if (tts !== "say" && !usePiper && !useKokoro) console.warn(`build: ${tts} is not set up (see docs/videos/README.md); using macOS say`);

// Kokoro (kokoro-onnx): one sentence at a time with a pause between, 24 kHz. Voices starting
// with b (bf_, bm_) are British English.
const KOKORO_HELPER = `
import json, re, sys, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
job = json.load(sys.stdin)
k = Kokoro(job["model"], job["voices"])
lang = "en-gb" if job["voice"].startswith("b") else "en-us"
for item in job["items"]:
    parts, sr = [], 24000
    for s in re.findall(r"[^.!?]+[.!?]+|[^.!?]+$", item["text"]):
        if not s.strip():
            continue
        a, sr = k.create(s.strip(), voice=job["voice"], speed=job["speed"], lang=lang)
        if parts:
            parts.append(np.zeros(int(sr * job["sentenceSilence"]), dtype=a.dtype))
        parts.append(a)
    sf.write(item["out"], np.concatenate(parts), sr, subtype="PCM_16")
`;

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

const segWav = (s) => join(work, `segments-${tag || "main"}`, `${s.id}.wav`);
guard("narration");
if (usePiper) {
  const pkg = execFileSync(PIPER_PYTHON, ["-I", "-c", "import os, piper; print(os.path.dirname(piper.__file__))"], { encoding: "utf8" }).trim();
  const job = { model: PIPER_VOICE, lengthScale: LENGTH_SCALE, sentenceSilence: SENTENCE_SILENCE_S, items: script.segments.map((s) => ({ text: spokenText(s.text), out: segWav(s) })) };
  run(PIPER_PYTHON, ["-I", "-c", PIPER_HELPER], { cwd: pkg, input: JSON.stringify(job) });
  console.log(`narration: Piper, ${PIPER_VOICE.split("/").pop()}`);
} else if (useKokoro) {
  const voice = voiceId || "af_heart";
  const job = { model: KOKORO_FILES[0], voices: KOKORO_FILES[1], voice, speed: KOKORO_SPEED, sentenceSilence: SENTENCE_SILENCE_S, items: script.segments.map((s) => ({ text: spokenText(s.text), out: segWav(s) })) };
  run(KOKORO_PYTHON, ["-I", "-c", KOKORO_HELPER], { input: JSON.stringify(job) });
  console.log(`narration: Kokoro, ${voice}`);
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
if (copyToRepo) {
  mkdirSync(PORTAL_VIDEO_DIR, { recursive: true });
  for (const f of files) copyFileSync(f, join(PORTAL_VIDEO_DIR, f.split("/").pop()));
  console.log(`copied to ${PORTAL_VIDEO_DIR}`);
}

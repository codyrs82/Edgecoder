// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Explainer videos for the Getting started guide: shared helpers for build.mjs and record.mjs.
// Pure functions (script parsing, pronunciation, WAV, WebVTT) so tests can run them without TTS,
// a browser or ffmpeg. See docs/videos/README.md.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SCRIPTS_DIR = join(ROOT, "docs/videos/scripts");
/** Where the portal serves the finished files (/assets/videos/<file>, src/portal/assets.ts). */
export const PORTAL_VIDEO_DIR = join(ROOT, "src/portal/assets/videos");

/** Silence before the first segment, between segments and after the last, in seconds. */
export const LEAD_IN_S = 1.0;
export const GAP_S = 1.0;
export const TAIL_S = 2.0;
/** The highlight moves this long before the voice starts, so a card is on screen before it's read. */
export const FOCUS_LEAD_S = 0.6;
/** Piper: speaking pace (>1 is slower) and the pause between sentences within a segment. */
export const LENGTH_SCALE = 1.12;
export const SENTENCE_SILENCE_S = 0.35;

/**
 * How the voice should say words the captions spell differently. Applied to the spoken text only;
 * the captions keep the script's wording.
 */
export const PRONOUNCE = [
  [/\bcSats\b/g, "see sats"],
  [/\bcSat\b/g, "see sat"],
  [/\/remote\b/g, "forward slash remote"],
  [/\bedgecoder code\b/g, "edge coder code"],
  [/\bEdgeCoder\b/g, "Edge Coder"],
  [/\bAPI\b/g, "A P I"],
  [/\b95 percent\b/g, "ninety-five percent"],
];

/** A narration script: front matter (step, name, title, voice) and `### <id>` segments. */
export function parseScript(md) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!fm) throw new Error("script: missing front matter");
  const meta = {};
  for (const line of fm[1].split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].trim();
  }
  for (const k of ["step", "name", "title"]) if (!meta[k]) throw new Error(`script: front matter needs ${k}`);
  const segments = [];
  const parts = md.slice(fm[0].length).split(/^### /m).slice(1);
  for (const part of parts) {
    const lines = part.split("\n");
    const id = lines.shift().trim();
    let focus = "title";
    const text = [];
    for (const line of lines) {
      const f = /^focus:\s*(.+?)\s*$/.exec(line);
      if (f) focus = f[1];
      else if (line.trim()) text.push(line.trim());
    }
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`script: bad segment id "${id}"`);
    if (!/^(title|next|more|card:\d+|more:\d+|sel:.+)$/.test(focus)) throw new Error(`script: segment ${id}: bad focus "${focus}"`);
    if (!text.length) throw new Error(`script: segment ${id} has no narration`);
    segments.push({ id, focus, text: text.join(" ") });
  }
  if (!segments.length) throw new Error("script: no segments");
  return { meta, segments };
}

/** The script for a wizard step id (front matter `step:`), from docs/videos/scripts/. */
export function scriptForStep(step, dir = SCRIPTS_DIR) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const path = join(dir, f);
    const parsed = parseScript(readFileSync(path, "utf8"));
    if (parsed.meta.step === step) return { path, ...parsed };
  }
  return null;
}

export function spokenText(text) {
  let out = text;
  for (const [re, say] of PRONOUNCE) out = out.replace(re, say);
  return out;
}

/** Sentences of a segment, for one caption cue each. */
export function sentences(text) {
  return text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

/** Segment start/end times (s) from each segment's audio length (s). */
export function timeline(segments, durations) {
  let t = LEAD_IN_S;
  const out = segments.map((s, i) => {
    const seg = { id: s.id, focus: s.focus, text: s.text, focusAt: Math.max(0, t - FOCUS_LEAD_S), start: t, end: t + durations[i] };
    t = seg.end + GAP_S;
    return seg;
  });
  const total = out[out.length - 1].end + TAIL_S;
  return { segments: out, total };
}

function vttTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(sec)}.${p(ms % 1000, 3)}`;
}

/** WebVTT: one cue per sentence, each segment's time shared by sentence length. */
export function toVtt(tl) {
  const cues = [];
  for (const seg of tl.segments) {
    const parts = sentences(seg.text);
    const total = parts.reduce((n, p) => n + p.length, 0);
    let t = seg.start;
    for (const p of parts) {
      const d = ((seg.end - seg.start) * p.length) / total;
      cues.push(`${vttTime(t)} --> ${vttTime(t + d)}\n${p}`);
      t += d;
    }
  }
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${c}`).join("\n\n")}\n`;
}

// ── WAV (16-bit PCM mono) ──

export function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") {
      if (!fmt || fmt.bits !== 16 || fmt.channels !== 1) throw new Error("WAV must be 16-bit mono PCM");
      return { rate: fmt.rate, samples: buf.subarray(off + 8, off + 8 + Math.min(size, buf.length - off - 8)) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export function wavFile(rate, pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Segment clips placed at their timeline starts, silence between, as one WAV. */
export function mixNarration(rate, clips, tl) {
  const pcm = Buffer.alloc(Math.ceil(tl.total * rate) * 2);
  tl.segments.forEach((seg, i) => clips[i].copy(pcm, Math.round(seg.start * rate) * 2));
  return wavFile(rate, pcm);
}

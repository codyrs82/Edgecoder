// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Degenerate model output (token padding). A network model call is priced per output token, and
 * the output is never verified, so a dishonest agent could stream filler (a phrase repeated over
 * and over, one word, junk) and bill the requester for it up to the call's output cap. An honest
 * small model at temperature 0 can also get stuck in a loop and run to the cap.
 *
 * When a call settles, the coordinator looks at the text it relayed to the requester (its own view
 * of the stream, not what the agent reports) and finds where the reply turns degenerate. Text from
 * there on is not billed: the call is charged for the clean prefix only and the rest of the reserve
 * goes back to the requester.
 *
 * The detectors are deliberately conservative: real replies (code, tables, JSON, lists, prose) have
 * plenty of repetition, but not hundreds of verbatim copies of one unit, nor a 4 KB stretch that
 * compresses like a loop. Nothing is judged in a reply shorter than `minChars`, and a degenerate
 * stretch must cover at least `minRunChars`, so the most an honest reply can lose is the tail of a
 * genuinely repetitive answer (for example "print 'hello' 1000 times"), which the requester is then
 * not charged for. Detection is a speed bump, not a proof: padding that varies (counting, random
 * words) passes it. The output cap (INFERENCE_DEFAULT_MAX_TOKENS) bounds that case.
 *
 * Signals (the earliest one wins):
 * - repeated_ngram: the same run of 1 to `maxWordPeriod` words repeated at least `minCopies` times
 *   in a row (whitespace-separated words, so re-flowed whitespace does not hide it);
 * - repeated_chars: inside one very long word (no whitespace), the same 1 to `maxCharPeriod`
 *   characters repeated at least `minCopies` times;
 * - compression: a `compressionWindowChars` stretch that deflates `compressionMinRatio` times or
 *   more (prose deflates about 2 to 4 times, code 3 to 8, generated JSON fixtures and hex dumps up
 *   to about 25: see the tests);
 * - dominant_token: windows of `dominanceWindowWords` words where one word (one with a letter in
 *   it, case and surrounding punctuation ignored) is `dominanceMinShare` of all words. Numbers and
 *   punctuation never count here (hex dumps, zero tables, markdown pipes).
 */
import { deflateRawSync } from "node:zlib";

export interface DegeneracyConfig {
  /** Replies shorter than this (characters) are never judged. */
  minChars: number;
  /** A degenerate stretch must cover at least this many characters. */
  minRunChars: number;
  /** A repeated unit must occur at least this many times in a row. */
  minCopies: number;
  maxWordPeriod: number;
  maxCharPeriod: number;
  compressionWindowChars: number;
  compressionStepChars: number;
  compressionMinRatio: number;
  dominanceWindowWords: number;
  dominanceStepWords: number;
  dominanceMinShare: number;
  /** Only this much of a reply is analysed (the stream holds at most 2M characters). */
  maxAnalysedChars: number;
}

export const DEFAULT_DEGENERACY: DegeneracyConfig = {
  minChars: 2_000,
  minRunChars: 2_000,
  minCopies: 10,
  maxWordPeriod: 64,
  maxCharPeriod: 32,
  compressionWindowChars: 4_096,
  compressionStepChars: 2_048,
  compressionMinRatio: 32,
  dominanceWindowWords: 200,
  dominanceStepWords: 50,
  dominanceMinShare: 0.6,
  maxAnalysedChars: 2_000_000
};

export type DegeneracyReason = "repeated_ngram" | "repeated_chars" | "compression" | "dominant_token";

export interface DegeneracyVerdict {
  degenerate: boolean;
  totalChars: number;
  /** Characters before the degenerate stretch (the billable prefix); totalChars when clean. */
  cleanChars: number;
  reason?: DegeneracyReason;
  detail?: Record<string, number | string>;
}

interface Finding {
  cleanChars: number;
  reason: DegeneracyReason;
  detail: Record<string, number | string>;
}

function earliest(a: Finding | undefined, b: Finding | undefined): Finding | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.cleanChars < a.cleanChars ? b : a;
}

/**
 * Earliest tandem repeat in `seq`: a unit of `period` items (1..maxPeriod) repeated at least
 * minCopies times in a row, covering at least minRunChars. The billable part keeps the first copy.
 */
function tandemRepeat(
  seq: ArrayLike<number>,
  maxPeriod: number,
  cfg: DegeneracyConfig,
  charStart: (i: number) => number,
  charEnd: (i: number) => number,
  reason: DegeneracyReason
): Finding | undefined {
  const n = seq.length;
  let best: Finding | undefined;
  const top = Math.min(maxPeriod, Math.floor(n / cfg.minCopies));
  for (let p = 1; p <= top; p++) {
    let run = 0;
    const check = (endExclusive: number) => {
      // Items [s, s + run + p) are p-periodic.
      const s = endExclusive - run;
      const span = run + p;
      if (span / p < cfg.minCopies) return;
      const startChar = charStart(s);
      const chars = charEnd(s + span - 1) - startChar;
      if (chars < cfg.minRunChars) return;
      const clean = charStart(s + p);
      if (!best || clean < best.cleanChars) best = { cleanChars: clean, reason, detail: { period: p, copies: Math.floor(span / p), runChars: chars, startChar } };
    };
    for (let i = 0; i + p < n; i++) {
      if (seq[i] === seq[i + p]) run++;
      else {
        if (run > 0) check(i);
        run = 0;
      }
    }
    if (run > 0) check(n - p);
  }
  return best;
}

interface Words {
  ids: Int32Array;
  starts: number[];
  ends: number[];
  norm: string[];
}

function words(text: string): Words {
  const ids: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const norm: string[] = [];
  const dict = new Map<string, number>();
  for (const m of text.matchAll(/\S+/g)) {
    const w = m[0];
    let id = dict.get(w);
    if (id === undefined) {
      id = dict.size;
      dict.set(w, id);
    }
    ids.push(id);
    starts.push(m.index as number);
    ends.push((m.index as number) + w.length);
    // For the dominance signal: only words with a letter, case and edge punctuation ignored.
    norm.push(/\p{L}/u.test(w) ? w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") : "");
  }
  return { ids: Int32Array.from(ids), starts, ends, norm };
}

function repeatedChars(text: string, w: Words, cfg: DegeneracyConfig): Finding | undefined {
  let best: Finding | undefined;
  for (let k = 0; k < w.starts.length; k++) {
    const len = w.ends[k] - w.starts[k];
    if (len < cfg.minRunChars) continue;
    const base = w.starts[k];
    const codes = new Uint16Array(len);
    for (let i = 0; i < len; i++) codes[i] = text.charCodeAt(base + i);
    const f = tandemRepeat(codes, cfg.maxCharPeriod, cfg, (i) => base + i, (i) => base + i + 1, "repeated_chars");
    best = earliest(best, f);
    if (best) break; // words are in order: a later word cannot start earlier
  }
  return best;
}

function deflateRatio(s: string): number {
  const raw = Buffer.from(s, "utf8");
  if (raw.length === 0) return 0;
  return raw.length / Math.max(1, deflateRawSync(raw).length);
}

function compression(text: string, cfg: DegeneracyConfig): Finding | undefined {
  const W = cfg.compressionWindowChars;
  if (text.length < W) return undefined;
  const bad = (start: number) => deflateRatio(text.slice(start, start + W)) >= cfg.compressionMinRatio;
  let prevStart = -1;
  for (let start = 0; start + W <= text.length; start += cfg.compressionStepChars) {
    if (bad(start)) {
      // The previous window was clean: the loop starts between it and here. Narrow it down.
      let onset = start;
      for (let o = Math.max(0, prevStart + 256); o < start; o += 256) {
        if (o + W <= text.length && bad(o)) {
          onset = o;
          break;
        }
      }
      return { cleanChars: onset, reason: "compression", detail: { windowStart: onset, ratio: Number(deflateRatio(text.slice(onset, onset + W)).toFixed(1)) } };
    }
    prevStart = start;
  }
  return undefined;
}

function dominantToken(w: Words, cfg: DegeneracyConfig): Finding | undefined {
  const n = w.norm.length;
  const W = cfg.dominanceWindowWords;
  if (n < W) return undefined;
  let regionStart = -1;
  let regionEnd = -1;
  let token = "";
  let share = 0;
  for (let s = 0; s + W <= n; s += cfg.dominanceStepWords) {
    const counts = new Map<string, number>();
    let top = 0;
    let topTok = "";
    for (let i = s; i < s + W; i++) {
      const t = w.norm[i];
      if (!t) continue;
      const c = (counts.get(t) ?? 0) + 1;
      counts.set(t, c);
      if (c > top) {
        top = c;
        topTok = t;
      }
    }
    if (top / W >= cfg.dominanceMinShare) {
      if (regionStart < 0) {
        // The stretch starts somewhere since the previous (clean) window: find the first word from
        // which a whole window is dominated by this token.
        regionStart = s;
        for (let i = Math.max(0, s - cfg.dominanceStepWords + 1); i < s; i++) {
          let c = 0;
          for (let j = i; j < i + W; j++) if (w.norm[j] === topTok) c++;
          if (c / W >= cfg.dominanceMinShare) {
            regionStart = i;
            break;
          }
        }
        // ... and skip the clean words at its head: start where the next 20 words are dominated too.
        const dense = (i: number) => {
          let c = 0;
          for (let j = i; j < i + 20 && j < n; j++) if (w.norm[j] === topTok) c++;
          return w.norm[i] === topTok && c / 20 >= cfg.dominanceMinShare;
        };
        while (regionStart < s + W - 20 && !dense(regionStart)) regionStart++;
        token = topTok;
        share = top / W;
      }
      regionEnd = s + W - 1;
    } else if (regionStart >= 0) {
      break;
    }
  }
  if (regionStart < 0) return undefined;
  const startChar = w.starts[regionStart];
  const chars = w.ends[regionEnd] - startChar;
  if (chars < cfg.minRunChars) return undefined;
  return { cleanChars: startChar, reason: "dominant_token", detail: { token: token.slice(0, 40), share: Number(share.toFixed(2)), runChars: chars } };
}

/** Where (if anywhere) a reply turns degenerate. */
export function detectDegenerateOutput(text: string, cfg: DegeneracyConfig = DEFAULT_DEGENERACY): DegeneracyVerdict {
  const totalChars = text.length;
  if (totalChars < cfg.minChars) return { degenerate: false, totalChars, cleanChars: totalChars };
  const t = totalChars > cfg.maxAnalysedChars ? text.slice(0, cfg.maxAnalysedChars) : text;
  const w = words(t);
  let found = tandemRepeat(w.ids, cfg.maxWordPeriod, cfg, (i) => w.starts[i], (i) => w.ends[i], "repeated_ngram");
  found = earliest(found, repeatedChars(t, w, cfg));
  found = earliest(found, compression(t, cfg));
  found = earliest(found, dominantToken(w, cfg));
  if (!found) return { degenerate: false, totalChars, cleanChars: totalChars };
  return { degenerate: true, totalChars, cleanChars: Math.max(0, Math.min(totalChars, found.cleanChars)), reason: found.reason, detail: found.detail };
}

/**
 * The share of a reply that is billed: the clean text plus any tool calls (which are not judged),
 * over everything the stream holds, both in UTF-8 bytes (the unit replyBytes and the token bounds use).
 */
export function billableFraction(text: string, cleanChars: number, toolBytes = 0): number {
  const total = Buffer.byteLength(text, "utf8") + toolBytes;
  if (total <= 0) return 1;
  const clean = Buffer.byteLength(text.slice(0, cleanChars), "utf8") + toolBytes;
  return Math.max(0, Math.min(1, clean / total));
}

export interface DegenerateReplyTrackerOptions {
  windowMs: number;
  /** Degenerate replies in the window before any strike. */
  minDegenerate: number;
  /** ... and their share of the agent's model calls in the window. */
  minShare: number;
}

export const DEFAULT_DEGENERATE_TRACKER: DegenerateReplyTrackerOptions = { windowMs: 60 * 60_000, minDegenerate: 3, minShare: 0.5 };

/**
 * Per agent: which of its recent model calls were degenerate. A degenerate reply is never paid for
 * its degenerate part (that is the main defence: padding earns nothing). A behaviour strike only
 * follows a pattern, at least `minDegenerate` degenerate replies making up at least `minShare` of
 * the agent's calls in the window, because honest small models do loop now and then.
 */
export class DegenerateReplyTracker {
  private readonly byAgent = new Map<string, Array<{ atMs: number; degenerate: boolean }>>();
  private recorded = 0;

  constructor(private readonly opts: DegenerateReplyTrackerOptions = DEFAULT_DEGENERATE_TRACKER) {}

  record(agentId: string, degenerate: boolean, nowMs: number): { degenerate: number; total: number; strike: boolean } {
    const cutoff = nowMs - this.opts.windowMs;
    const list = (this.byAgent.get(agentId) ?? []).filter((e) => e.atMs >= cutoff);
    list.push({ atMs: nowMs, degenerate });
    if (list.length > 500) list.splice(0, list.length - 500);
    this.byAgent.set(agentId, list);
    if (++this.recorded % 1000 === 0) this.prune(nowMs);
    const bad = list.filter((e) => e.degenerate).length;
    return { degenerate: bad, total: list.length, strike: degenerate && bad >= this.opts.minDegenerate && bad / list.length >= this.opts.minShare };
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - this.opts.windowMs;
    for (const [id, list] of this.byAgent) if (!list.some((e) => e.atMs >= cutoff)) this.byAgent.delete(id);
  }
}

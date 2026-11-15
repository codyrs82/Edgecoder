import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DegenerateReplyTracker, billableFraction, detectDegenerateOutput } from "../../src/swarm/inference-degeneracy.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

const VOCAB = (
  "the a of to and in is it for on with as by that this from at be are or an was can each when which their " +
  "request response cache config handler schema value error retry timeout service client server queue worker token model " +
  "parse read write check build return update create delete start stop open close send receive store load save " +
  "file record header body field index list map set key node agent result task call stream byte line test case " +
  "first last next new old small large fast slow safe valid empty full local remote public private stale fresh " +
  "before after while then because unless only also never always often again once twice later early quickly"
).split(" ");

/** An honest-looking answer of about `chars` characters: sentences of words drawn at random (fixed seed). */
function prose(chars: number, seed = 7): string {
  let x = seed;
  const rnd = (n: number) => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x % n;
  };
  let out = "";
  while (out.length < chars) {
    const len = 6 + rnd(14);
    const words = Array.from({ length: len }, () => VOCAB[rnd(VOCAB.length)]);
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    out += `${words.join(" ")}${rnd(6) === 0 ? ",\n" : ". "}`;
  }
  return out.slice(0, chars);
}

describe("detectDegenerateOutput: padding is found where it starts", () => {
  it("a phrase repeated to the cap", () => {
    const clean = prose(3_000);
    const text = `${clean}\n${"I hope this helps! ".repeat(400)}`;
    const v = detectDegenerateOutput(text);
    expect(v.degenerate).toBe(true);
    expect(v.reason).toBe("repeated_ngram");
    // The first copy is kept; everything after it is not billed.
    expect(v.cleanChars).toBeGreaterThan(clean.length);
    expect(v.cleanChars).toBeLessThan(clean.length + 40);
  });

  it("a paragraph repeated (a model stuck in a loop)", () => {
    const para = "Step: open the file, read the header, check the magic number, then parse the rest of the records into memory.\n";
    const text = prose(2_500) + "\n\n" + para.repeat(60);
    const v = detectDegenerateOutput(text);
    expect(v.degenerate).toBe(true);
    expect(v.cleanChars).toBeGreaterThanOrEqual(2_500);
    expect(v.cleanChars).toBeLessThan(2_502 + para.length + 1);
  });

  it("one word over and over", () => {
    const v = detectDegenerateOutput(prose(1_000) + " the".repeat(3_000));
    expect(v.degenerate).toBe(true);
    expect(v.cleanChars).toBeGreaterThan(990);
    expect(v.cleanChars).toBeLessThan(1_010);
  });

  it("junk with no whitespace", () => {
    const v = detectDegenerateOutput(prose(2_000) + " " + "xq7".repeat(2_000));
    expect(v).toMatchObject({ degenerate: true, reason: "repeated_chars" });
    expect(v.cleanChars).toBeGreaterThan(2_000);
    expect(v.cleanChars).toBeLessThan(2_010);
  });

  it("a loop that varies now and then (no long verbatim run) is caught by compression", () => {
    const para = "Then we check the value again and return the same result to the caller as before. ";
    let loop = "";
    for (let i = 0; loop.length < 16_000; i++) loop += i % 12 === 11 ? para.replace("again", `again (${i})`) : para;
    const v = detectDegenerateOutput(prose(4_000) + " " + loop);
    expect(v).toMatchObject({ degenerate: true, reason: "compression" });
    expect(v.cleanChars).toBeGreaterThan(3_000);
    expect(v.cleanChars).toBeLessThanOrEqual(4_100);
  });

  it("not caught: padding that varies all the time (a counting loop); the output cap bounds it", () => {
    let loop = "";
    for (let i = 0; loop.length < 12_000; i++) loop += `Step ${i}: repeat the previous step. `;
    expect(detectDegenerateOutput(prose(4_000) + " " + loop).degenerate).toBe(false);
  });

  it("filler dominated by one word", () => {
    const fill = Array.from({ length: 1_500 }, (_, i) => (i % 3 === 2 ? `w${i}` : "lorem")).join(" ");
    const v = detectDegenerateOutput(prose(2_500) + " " + fill);
    expect(v.degenerate).toBe(true);
    expect(v.cleanChars).toBeGreaterThan(2_000);
  });

  it("a reply that is padding from the start bills nothing", () => {
    const v = detectDegenerateOutput("ok ".repeat(5_000));
    expect(v.degenerate).toBe(true);
    expect(v.cleanChars).toBeLessThan(10);
  });
});

describe("detectDegenerateOutput: real replies are left alone", () => {
  it("short replies are never judged, however repetitive", () => {
    expect(detectDegenerateOutput("yes ".repeat(400)).degenerate).toBe(false);
  });

  it("varied prose", () => {
    expect(detectDegenerateOutput(prose(40_000)).degenerate).toBe(false);
  });

  it("a markdown feature table with many similar rows", () => {
    const rows = Array.from({ length: 150 }, (_, i) => `| Feature ${i} | ${i % 3 ? "✅" : "❌"} | ${i % 2 ? "✅" : "✅"} | ${i % 5 ? "Yes" : "No"} | v${1 + (i % 4)}.${i % 10} |`);
    const table = `| Feature | Linux | macOS | Supported | Since |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
    expect(table.length).toBeGreaterThan(5_000);
    expect(detectDegenerateOutput(table).degenerate).toBe(false);
  });

  it("JSON test data with incrementing ids", () => {
    const data = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: `user${i}`, active: i % 7 !== 0, role: i % 3 ? "member" : "admin" })), null, 2);
    expect(data.length).toBeGreaterThan(10_000);
    expect(detectDegenerateOutput(data).degenerate).toBe(false);
  });

  it("CSV rows with repeated categories", () => {
    const csv = ["date,region,product,units,price", ...Array.from({ length: 400 }, (_, i) => `2026-0${1 + (i % 9)}-${10 + (i % 18)},${["north", "south", "east", "west"][i % 4]},widget,${(i * 37) % 101},${(9.99 + (i % 5)).toFixed(2)}`)].join("\n");
    expect(detectDegenerateOutput(csv).degenerate).toBe(false);
  });

  it("a code file with repetitive structure (switch cases, test blocks)", () => {
    const cases = Array.from({ length: 120 }, (_, i) => `    case "op${i}":\n      return handle${i % 7}(input, ${i});`).join("\n");
    const code = `export function dispatch(op: string, input: Input): Output {\n  switch (op) {\n${cases}\n    default:\n      throw new Error("unknown op");\n  }\n}\n`;
    expect(detectDegenerateOutput(code).degenerate).toBe(false);
    const tests = Array.from({ length: 60 }, (_, i) => `it("handles case ${i}", () => {\n  expect(parse("${"ab".repeat(i % 5)}${i}")).toEqual({ ok: true, value: ${i} });\n});`).join("\n\n");
    expect(detectDegenerateOutput(tests).degenerate).toBe(false);
  });

  it("generated fixtures, hex dumps and separators: structured repetition that is not a loop", () => {
    const fixtures = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, enabled: true, tags: [], meta: null })), null, 2);
    const hex = Array.from({ length: 200 }, (_, i) => `0x${(i * 16).toString(16).padStart(8, "0")}: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  ................`).join("\n");
    const sections = Array.from({ length: 100 }, (_, i) => `## Section ${i}\n\n${"-".repeat(60)}\n\nTODO\n`).join("\n");
    for (const text of [fixtures, hex, sections]) expect(detectDegenerateOutput(text).degenerate).toBe(false);
  });

  it("this repository's own source and docs, sliced like replies", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|md)$/.test(name)) files.push(p);
      }
    };
    walk(join(root, "src/swarm"));
    walk(join(root, "docs"));
    const flagged: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      for (let o = 0; o < s.length; o += 32_000) if (detectDegenerateOutput(s.slice(o, o + 32_000)).degenerate) flagged.push(`${f}@${o}`);
    }
    expect(files.length).toBeGreaterThan(50);
    expect(flagged).toEqual([]);
  });
});

describe("billableFraction", () => {
  it("is the clean share of the stream's bytes; tool calls are always billed", () => {
    expect(billableFraction("abcd", 4)).toBe(1);
    expect(billableFraction("abcd", 1)).toBe(0.25);
    expect(billableFraction("abcd", 0, 4)).toBe(0.5);
    expect(billableFraction("", 0)).toBe(1);
  });
});

describe("DegenerateReplyTracker", () => {
  it("strikes only on a pattern: enough degenerate replies and most of the agent's calls", () => {
    const t = new DegenerateReplyTracker({ windowMs: 60_000, minDegenerate: 3, minShare: 0.5 });
    // An honest agent whose model loops now and then: never a strike.
    for (let i = 0; i < 20; i++) expect(t.record("honest", i % 5 === 0, 1_000 + i).strike).toBe(false);
    // A padder: the third padded reply is a strike, and each one after.
    expect(t.record("padder", true, 1_000).strike).toBe(false);
    expect(t.record("padder", true, 1_001).strike).toBe(false);
    expect(t.record("padder", true, 1_002)).toMatchObject({ strike: true, degenerate: 3, total: 3 });
    expect(t.record("padder", false, 1_003).strike).toBe(false);
    expect(t.record("padder", true, 1_004).strike).toBe(true);
    // Old replies leave the window.
    expect(t.record("padder", true, 200_000)).toMatchObject({ strike: false, degenerate: 1, total: 1 });
  });
});

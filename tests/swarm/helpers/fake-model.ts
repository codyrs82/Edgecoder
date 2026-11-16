import { inferenceTag } from "../../../src/swarm/benchmark.js";

/**
 * Same "model" (variant) + same nonce => same text, like greedy decoding of one model.
 * Different variants must give unrelated text for every nonce: the LCG multiplies with Math.imul,
 * because a plain `h * 1103515245` exceeds 2^53, drops the low bits, and made the sequence collapse
 * so that, for about 1 nonce in 4,000, two "models" produced near-identical lines (a flaky witness
 * agreement in tests/swarm/hardware-verification.test.ts).
 */
export function fakeModelOutput(nonce: string, lines: number, variant = "a"): string {
  // A few hundred letter-only "words" (a vocabulary closer to real text than a short list).
  const words = Array.from({ length: 400 }, (_, i) => "w" + i.toString(26).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]));
  const tag = inferenceTag(nonce);
  const out: string[] = [];
  let h = 0;
  for (const ch of `${variant}:${nonce}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  for (let n = 1; n <= lines; n++) {
    const sentence: string[] = [];
    for (let w = 0; w < 15; w++) {
      h = (Math.imul(h, 1103515245) + 12345) >>> 0;
      sentence.push(words[(h >>> 16) % words.length]);
    }
    out.push(`${n}. ${tag}-${n} ${sentence.join(" ")}.`);
  }
  return out.join("\n");
}

import { describe, expect, it } from "vitest";
import { diffLines } from "../src/lib/line-diff";

/** Apply hunks, accepting those whose index is in `accept`, rejecting the rest. */
function apply(oldLines: string[], newLines: string[], accept: Set<number>): string[] {
  const hunks = diffLines(oldLines, newLines);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  hunks.forEach((h, k) => {
    while (i < h.oldStart) out.push(oldLines[i++]);
    j = h.newStart;
    if (accept.has(k)) out.push(...newLines.slice(h.newStart, h.newStart + h.newCount));
    else out.push(...h.oldLines);
    i += h.oldLines.length;
    j += h.newCount;
  });
  while (i < oldLines.length) out.push(oldLines[i++]);
  return out;
}

describe("diffLines", () => {
  it("finds separate changes", () => {
    const a = ["a", "b", "c", "d", "e"];
    const b = ["a", "B", "c", "d", "e", "f"];
    const h = diffLines(a, b);
    expect(h).toEqual([
      { oldStart: 1, oldLines: ["b"], newStart: 1, newCount: 1 },
      { oldStart: 5, oldLines: [], newStart: 5, newCount: 1 },
    ]);
  });

  it("accepting every hunk gives the new text, rejecting every hunk the old", () => {
    const a = ["def f(x):", "    return x", "", "print(f(1))"];
    const b = ["def f(x: int) -> int:", "    # double", "    return 2 * x", "", "print(f(1))", "print(f(2))"];
    const n = diffLines(a, b).length;
    expect(apply(a, b, new Set(Array.from({ length: n }, (_, k) => k)))).toEqual(b);
    expect(apply(a, b, new Set())).toEqual(a);
  });

  it("handles pure insertion, pure deletion and empty sides", () => {
    expect(diffLines([], ["x"])).toEqual([{ oldStart: 0, oldLines: [], newStart: 0, newCount: 1 }]);
    expect(diffLines(["x"], [])).toEqual([{ oldStart: 0, oldLines: ["x"], newStart: 0, newCount: 0 }]);
    expect(diffLines(["x"], ["x"])).toEqual([]);
  });
});

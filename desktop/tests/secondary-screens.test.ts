import { describe, expect, it } from "vitest";
import { visibleRange } from "../src/lib/virtual-list";
import { clampIndex, fitViewBox, nextNodeIndex, radialLayout } from "../src/lib/mesh-layout";

describe("visibleRange (#28 virtualized log)", () => {
  it("renders only the viewport plus overscan, with spacers for the rest", () => {
    expect(visibleRange(0, 100, 20, 1000, 2)).toEqual({ start: 0, end: 8, padTop: 0, padBottom: 992 * 20 });
    expect(visibleRange(2000, 100, 20, 1000, 2)).toEqual({ start: 98, end: 108, padTop: 1960, padBottom: 892 * 20 });
  });

  it("clamps at the end, for negative scroll, and for empty lists", () => {
    const r = visibleRange(1e9, 100, 20, 50, 2);
    expect(r.end).toBe(50);
    expect(r.padBottom).toBe(0);
    expect(visibleRange(-50, 100, 20, 10, 0).start).toBe(0);
    expect(visibleRange(0, 100, 20, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(visibleRange(0, 100, 0, 10)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("total height is preserved", () => {
    for (const top of [0, 333, 5000, 19980]) {
      const r = visibleRange(top, 240, 20, 1000);
      expect(r.padTop + (r.end - r.start) * 20 + r.padBottom).toBe(1000 * 20);
    }
  });
});

describe("radialLayout (#28 mesh graph)", () => {
  it("puts this node in the centre, peers on a ring, one edge each", () => {
    const l = radialLayout(["b", "self", "a", "a"], "self", 400);
    expect(l.nodes[0]).toEqual({ id: "self", x: 200, y: 200, self: true });
    expect(l.nodes.slice(1).map((n) => n.id)).toEqual(["a", "b"]);
    expect(l.edges).toEqual([{ from: "self", to: "a" }, { from: "self", to: "b" }]);
    expect(l.nodes[1].y).toBeLessThan(200); // first peer at 12 o'clock
  });

  it("is stable across polls regardless of input order", () => {
    expect(radialLayout(["c", "a", "b"], "s")).toEqual(radialLayout(["b", "c", "a"], "s"));
  });

  it("grows the ring so many peers don't overlap", () => {
    const l = radialLayout(Array.from({ length: 60 }, (_, i) => `p${i}`), "s", 400, 56);
    const [a, b] = [l.nodes[1], l.nodes[2]];
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(55);
    const [, , w] = fitViewBox(l.nodes).split(" ").map(Number);
    expect(w).toBeGreaterThan(400);
  });

  it("handles no peers and an unknown self id", () => {
    expect(radialLayout([], "")).toEqual({ nodes: [{ id: "", x: 200, y: 200, self: true }], edges: [] });
  });

  it("a peer literally named \"self\" doesn't collide with the centre (#150 review)", () => {
    const l = radialLayout(["self", ""], "");
    expect(l.nodes.map((n) => [n.id, n.self])).toEqual([["", true], ["self", false]]);
    expect(l.edges).toEqual([{ from: "", to: "self" }]);
  });

  it("clamps the roving focus index when peers drop (#150 review)", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(4, 0)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
  });

  it("arrow keys wrap around the ring", () => {
    expect(nextNodeIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextNodeIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextNodeIndex("End", 0, 3)).toBe(2);
    expect(nextNodeIndex("a", 0, 3)).toBeNull();
    expect(nextNodeIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

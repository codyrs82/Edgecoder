import { describe, expect, it } from "vitest";
import { distanceRttMs, regionDistanceKm, regionPoint } from "../../src/common/geo-regions.js";

/* #526: where a buyer's or a host's region is, for locality-aware routing. */

describe("region distance", () => {
  it("knows Fly regions, cc-<country> and bare country codes", () => {
    expect(regionPoint("lhr")).not.toBeNull();
    expect(regionPoint("LHR")).toEqual(regionPoint("lhr"));
    expect(regionPoint("cc-gb")).toEqual(regionPoint("GB"));
    expect(regionPoint("atlantis")).toBeNull();
    expect(regionPoint(null)).toBeNull();
    expect(regionPoint("")).toBeNull();
  });

  it("is a great-circle distance in km", () => {
    expect(regionDistanceKm("lhr", "lhr")).toBe(0);
    // London to Frankfurt ~650 km, to Washington ~5,900 km, Sydney to Singapore ~6,300 km.
    expect(regionDistanceKm("lhr", "fra")).toBeGreaterThan(550);
    expect(regionDistanceKm("lhr", "fra")).toBeLessThan(750);
    expect(regionDistanceKm("lhr", "iad")).toBeGreaterThan(5_700);
    expect(regionDistanceKm("lhr", "iad")).toBeLessThan(6_100);
    expect(regionDistanceKm("syd", "sin")).toBeGreaterThan(6_000);
    expect(regionDistanceKm("syd", "sin")).toBeLessThan(6_500);
    // A country stands in for a region: a GB buyer is next to lhr, far from syd.
    expect(regionDistanceKm("cc-gb", "lhr")!).toBeLessThan(100);
    expect(regionDistanceKm("cc-gb", "syd")!).toBeGreaterThan(15_000);
    expect(regionDistanceKm("lhr", "nowhere")).toBeNull();
  });

  it("turns distance into a rough round trip", () => {
    expect(distanceRttMs(0)).toBe(0);
    expect(distanceRttMs(7_000)).toBe(100);
    expect(distanceRttMs(-5)).toBe(0);
  });
});

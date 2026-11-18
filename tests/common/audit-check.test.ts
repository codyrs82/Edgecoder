import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs CI script
import { acceptedIds, blockingAdvisories } from "../../scripts/ci/audit-check.mjs";

const id = "GHSA-fc5q-39xc-vjpf";
const entry = (expires: string) => ({ exceptions: [{ id, expires, reason: "no fix yet" }] });

describe("audit-check exceptions", () => {
  it("accepts an unexpired exception", () => {
    expect([...acceptedIds(entry("2026-12-18"), "2026-11-18").ok]).toEqual([id]);
  });
  it("rejects an expired one and one more than 30 days out", () => {
    expect(acceptedIds(entry("2026-11-17"), "2026-11-18").problems[0]).toMatch(/expired/);
    expect(acceptedIds(entry("2027-01-30"), "2026-11-18").problems[0]).toMatch(/more than 30 days/);
  });
  it("rejects an entry without a reason", () => {
    expect(acceptedIds({ exceptions: [{ id, expires: "2026-12-01" }] }, "2026-11-18").problems).toHaveLength(1);
  });
  it("finds only high and critical advisories", () => {
    const report = { vulnerabilities: {
      picomatch: { via: [{ severity: "high", name: "picomatch", title: "ReDoS", url: `https://github.com/advisories/${id}` }] },
      vite: { via: ["picomatch"] },
      deepmerge: { via: [{ severity: "low", name: "deepmerge", title: "x", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }] },
    } };
    expect([...blockingAdvisories(report).keys()]).toEqual([id]);
  });
});

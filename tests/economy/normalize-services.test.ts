import { describe, expect, it } from "vitest";
import { normalizeServices } from "../../src/economy/host-attestation.js";

describe("normalizeServices", () => {
  it("should trim and lowercase entries", () => {
    const input = ["  BITCOIND  ", "  Lightning  ", " ELECTRS "];
    const result = normalizeServices(input);
    expect(result).toEqual(["bitcoind", "electrs", "lightning"]);
  });

  it("should remove duplicates after normalizing", () => {
    const input = ["bitcoind", "BITCOIND", "Bitcoind", "lightning"];
    const result = normalizeServices(input);
    expect(result).toEqual(["bitcoind", "lightning"]);
  });

  it("should drop empty and whitespace-only entries", () => {
    const input = ["", "  ", "bitcoind", "", "  \t\n  ", "lightning"];
    const result = normalizeServices(input);
    expect(result).toEqual(["bitcoind", "lightning"]);
  });

  it("should sort the result", () => {
    const input = ["z", "a", "c", "b"];
    const result = normalizeServices(input);
    expect(result).toEqual(["a", "b", "c", "z"]);
  });

  it("should return empty array for empty input", () => {
    const result = normalizeServices([]);
    expect(result).toEqual([]);
  });

  it("should handle mixed case, whitespace, and duplicates", () => {
    const input = ["  COORDINATOR  ", "BITCOIND", "  lightning  ", "BITCOIND", "  ", "", "COORDINATOR", "Electrs"];
    const result = normalizeServices(input);
    expect(result).toEqual(["bitcoind", "coordinator", "electrs", "lightning"]);
  });
});
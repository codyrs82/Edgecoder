import { describe, expect, it } from "vitest";
import { isLightningNodeId } from "../../src/economy/service-probes.js";

describe("isLightningNodeId", () => {
  it("should return true for valid 66-character hex id starting with 02 or 03 (lowercase)", () => {
    // Valid 02 prefix
    const valid02 = "02" + "a".repeat(64);
    expect(isLightningNodeId(valid02)).toBe(true);
    
    // Valid 03 prefix
    const valid03 = "03" + "b".repeat(64);
    expect(isLightningNodeId(valid03)).toBe(true);
  });

  it("should return true for valid 66-character hex id starting with 02 or 03 (uppercase)", () => {
    // Valid 02 prefix uppercase
    const valid02 = "02" + "A".repeat(64);
    expect(isLightningNodeId(valid02)).toBe(true);
    
    // Valid 03 prefix uppercase
    const valid03 = "03" + "B".repeat(64);
    expect(isLightningNodeId(valid03)).toBe(true);
  });

  it("should return false for 04 prefix", () => {
    const invalid04 = "04" + "a".repeat(64);
    expect(isLightningNodeId(invalid04)).toBe(false);
  });

  it("should return false for 64-character hex id", () => {
    const invalid64 = "02" + "a".repeat(62); // Only 64 chars total (02 + 62)
    expect(isLightningNodeId(invalid64)).toBe(false);
  });

  it("should return false for 68-character hex id", () => {
    const invalid68 = "02" + "a".repeat(66); // 68 chars total (02 + 66)
    expect(isLightningNodeId(invalid68)).toBe(false);
  });

  it("should return false for non-hex characters", () => {
    // Contains 'g' which is not a valid hex character
    const invalidHex = "02" + "a".repeat(63) + "g";
    expect(isLightningNodeId(invalidHex)).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isLightningNodeId("")).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(isLightningNodeId(undefined)).toBe(false);
  });

  it("should return false for null", () => {
    // @ts-expect-error - testing invalid input
    expect(isLightningNodeId(null)).toBe(false);
  });

  it("should return false for number", () => {
    // @ts-expect-error - testing invalid input
    expect(isLightningNodeId(123)).toBe(false);
  });
});
import { describe, expect, it } from "vitest";
import { isValidPayloadHex } from "../../src/economy/anchor-proxy-app.js";

describe("isValidPayloadHex", () => {
  it("should return true for valid even-length hex strings (lowercase)", () => {
    expect(isValidPayloadHex("1234567890abcdef")).toBe(true);
    expect(isValidPayloadHex("a1b2c3d4e5f67890")).toBe(true);
  });

  it("should return true for valid even-length hex strings (uppercase)", () => {
    expect(isValidPayloadHex("1234567890ABCDEF")).toBe(true);
    expect(isValidPayloadHex("A1B2C3D4E5F67890")).toBe(true);
  });

  it("should return true for valid even-length hex strings with mixed case", () => {
    expect(isValidPayloadHex("1234567890AbCdEf")).toBe(true);
    expect(isValidPayloadHex("A1b2C3d4E5f67890")).toBe(true);
  });

  it("should return false for empty string", () => {
    expect(isValidPayloadHex("")).toBe(false);
  });

  it("should return false for odd length hex strings", () => {
    expect(isValidPayloadHex("1234567890abcde")).toBe(false); // 15 chars
    expect(isValidPayloadHex("a1b2c3d4e5f6789")).toBe(false); // 15 chars
  });

  it("should return false for non-hex characters", () => {
    expect(isValidPayloadHex("1234567890abcdefg")).toBe(false); // contains 'g'
    expect(isValidPayloadHex("1234567890abcdeF!")).toBe(false); // contains '!'
    expect(isValidPayloadHex("1234567890abcdeF@")).toBe(false); // contains '@'
  });

  it("should return true for exactly 160 characters (valid length)", () => {
    const longHex = "a".repeat(160);
    expect(isValidPayloadHex(longHex)).toBe(true);
  });

  it("should return false for exactly 162 characters (too long)", () => {
    const tooLongHex = "a".repeat(162);
    expect(isValidPayloadHex(tooLongHex)).toBe(false);
  });

  it("should return false for non-string values", () => {
    expect(isValidPayloadHex(null)).toBe(false);
    expect(isValidPayloadHex(undefined)).toBe(false);
    expect(isValidPayloadHex(123)).toBe(false);
    expect(isValidPayloadHex({})).toBe(false);
    expect(isValidPayloadHex([])).toBe(false);
  });

  it("should return false for string with length 0", () => {
    expect(isValidPayloadHex("")).toBe(false);
  });
});
import { describe, expect, it } from "vitest";
import { errorText } from "../src/lib/errors";

describe("errorText (#24)", () => {
  it("prefers an Error message, then a string, then the fallback", () => {
    expect(errorText(new Error("  boom "))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(new Error("   "))).toBe("Something went wrong");
    expect(errorText(undefined, "Copy failed")).toBe("Copy failed");
    expect(errorText({ message: "not an Error" })).toBe("Something went wrong");
  });
});

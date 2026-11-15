import { describe, expect, it } from "vitest";
import { upstreamPathSegment } from "../../src/control-plane/path-segment.js";

describe("upstreamPathSegment", () => {
  it("percent-encodes path separators and query/fragment characters", () => {
    expect(upstreamPathSegment("acct-1")).toBe("acct-1");
    expect(upstreamPathSegment("../../economy/treasury")).toBe("..%2F..%2Feconomy%2Ftreasury");
    expect(upstreamPathSegment("a?b#c")).toBe("a%3Fb%23c");
    expect(upstreamPathSegment("user@example.com")).toBe("user%40example.com");
  });

  it("refuses empty, dot-segment, over-long, control-character and non-string ids", () => {
    for (const bad of ["", ".", "..", "x".repeat(257), "a\nb", "a\u0000b", 5, undefined]) {
      expect(upstreamPathSegment(bad)).toBeNull();
    }
  });
});

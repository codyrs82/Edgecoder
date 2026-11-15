import { describe, expect, it } from "vitest";
import { stripQuery } from "../../src/common/redaction.js";

describe("stripQuery", () => {
  it("returns a URL with no query or fragment unchanged", () => {
    expect(stripQuery("https://example.com/path")).toBe("https://example.com/path");
    expect(stripQuery("/path")).toBe("/path");
    expect(stripQuery("https://example.com")).toBe("https://example.com");
  });

  it("drops a query string", () => {
    expect(stripQuery("https://example.com/path?param=value")).toBe("https://example.com/path");
    expect(stripQuery("https://example.com/path?param1=value1&param2=value2")).toBe("https://example.com/path");
    expect(stripQuery("?param=value")).toBe("");
  });

  it("drops a fragment", () => {
    expect(stripQuery("https://example.com/path#section")).toBe("https://example.com/path");
    expect(stripQuery("https://example.com/path?param=value#section")).toBe("https://example.com/path");
    expect(stripQuery("#section")).toBe("");
  });

  it("handles both query and fragment together", () => {
    expect(stripQuery("https://example.com/path?param=value#section")).toBe("https://example.com/path");
  });

  it("handles '?' or '#' at the very end", () => {
    expect(stripQuery("https://example.com/path?")).toBe("https://example.com/path");
    expect(stripQuery("https://example.com/path#")).toBe("https://example.com/path");
    expect(stripQuery("https://example.com/path?#")).toBe("https://example.com/path");
  });

  it("handles relative paths", () => {
    expect(stripQuery("/path?param=value")).toBe("/path");
    expect(stripQuery("/path#section")).toBe("/path");
    expect(stripQuery("../path?param=value#section")).toBe("../path");
  });
});
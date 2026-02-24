import { describe, it, expect } from "vitest";
import { detectOS } from "../../src/portal/server.js";

describe("detectOS", () => {
  it("detects macOS from Safari User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe("macos");
  });

  it("detects macOS from Chrome on Apple Silicon", () => {
    expect(detectOS("Mozilla/5.0 (Macintosh; ARM Mac OS X 14_0) AppleWebKit/537.36 Chrome/120.0")).toBe("macos");
  });

  it("detects Windows from Chrome User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("windows");
  });

  it("detects Linux from Firefox User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/120.0")).toBe("linux");
  });

  it("detects Ubuntu as Linux", () => {
    expect(detectOS("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0")).toBe("linux");
  });

  it("detects iOS from iPhone User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("ios");
  });

  it("detects iOS from iPad User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("ios");
  });

  it("returns unknown for empty User-Agent", () => {
    expect(detectOS("")).toBe("unknown");
  });

  it("returns unknown for bot User-Agent", () => {
    expect(detectOS("Googlebot/2.1")).toBe("unknown");
  });

  it("prioritizes iOS over macOS for iPad user agents with Mac OS X", () => {
    // iPads sometimes report Mac OS X but also include iPad
    expect(detectOS("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("ios");
  });
});

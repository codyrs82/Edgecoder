import { describe, it, expect } from "vitest";
import { appVersion } from "../../src/common/app-version.js";
import { readFileSync } from "fs";

describe("appVersion", () => {
  it("should return the version from package.json", () => {
    const packageJsonContent = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const packageJson = JSON.parse(packageJsonContent);
    
    expect(appVersion()).toBe(packageJson.version);
  });

  it("should not return '0.1.0' unless package.json says so", () => {
    const packageJsonContent = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const packageJson = JSON.parse(packageJsonContent);
    
    if (packageJson.version === "0.1.0") {
      expect(appVersion()).toBe("0.1.0");
    } else {
      expect(appVersion()).not.toBe("0.1.0");
    }
  });

  it("should return the same value twice (caching)", () => {
    const version1 = appVersion();
    const version2 = appVersion();
    
    expect(version1).toBe(version2);
  });
});
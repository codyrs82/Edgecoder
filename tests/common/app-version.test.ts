import { describe, it, expect } from "vitest";
import { appVersion, desktopAppVersion } from "../../src/common/app-version.js";
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

  it("network run 19: takes the desktop app's version (EDGECODER_APP_VERSION) when it is a plain semver", () => {
    expect(desktopAppVersion("1.4.75")).toBe("1.4.75");
    expect(desktopAppVersion(" 1.4.75-beta.1 ")).toBe("1.4.75-beta.1");
    expect(desktopAppVersion(undefined)).toBeUndefined();
    expect(desktopAppVersion("")).toBeUndefined();
    expect(desktopAppVersion("latest")).toBeUndefined();
    expect(desktopAppVersion("1.4")).toBeUndefined();
  });
});

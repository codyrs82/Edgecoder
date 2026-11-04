import { describe, expect, it } from "vitest";
import { DESKTOP_APP_ORIGINS, desktopOriginOf } from "../../src/common/desktop-origins.js";
import { DEFAULT_ALLOWED_ORIGINS } from "../../src/apps/ide/ide-auth.js";

describe("desktop app origins", () => {
  it("include the Windows WebView2 origin (http://tauri.localhost) next to macOS/Linux and https", () => {
    expect(DESKTOP_APP_ORIGINS).toEqual(
      expect.arrayContaining(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])
    );
  });
  it("desktopOriginOf echoes only an exact desktop origin", () => {
    expect(desktopOriginOf("http://tauri.localhost")).toBe("http://tauri.localhost");
    expect(desktopOriginOf(["tauri://localhost"])).toBe("tauri://localhost");
    expect(desktopOriginOf("http://tauri.localhost.evil.example")).toBeUndefined();
    expect(desktopOriginOf("https://edgecoder.io")).toBeUndefined();
    expect(desktopOriginOf(undefined)).toBeUndefined();
  });
  it("the IDE allowlist is unchanged: the three app origins, not the Vite dev server", () => {
    expect([...DEFAULT_ALLOWED_ORIGINS].sort()).toEqual(["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"]);
  });
});

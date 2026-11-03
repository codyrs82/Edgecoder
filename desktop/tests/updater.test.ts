import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AUTO_UPDATE_KEY, CHECK_INTERVAL_MS, FOCUS_CHECK_MIN_MS, autoUpdateEnabled, focusCheckDue } from "../src/lib/updater";

const store = (v: string | null) => ({ getItem: (k: string) => (k === AUTO_UPDATE_KEY ? v : null) });

describe("auto-update", () => {
  it("is on by default and when storage is unavailable", () => {
    expect(autoUpdateEnabled(store(null))).toBe(true);
    expect(autoUpdateEnabled(null)).toBe(true);
  });

  it("can be opted out", () => {
    expect(autoUpdateEnabled(store("off"))).toBe(false);
  });

  it("polls a fixed feed signed by the current key", () => {
    const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    const updater = conf.plugins.updater;
    expect(updater.endpoints).toEqual(["https://github.com/codyrs82/Edgecoder/releases/download/desktop-updates/latest.json"]);
    expect(Buffer.from(updater.pubkey, "base64").toString()).toContain("172D1026D3468293");
    expect(conf.bundle.createUpdaterArtifacts).toBe(true);
  });

  it("checks every 30 minutes and on focus at most every 10 minutes", () => {
    expect(CHECK_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(focusCheckDue(FOCUS_CHECK_MIN_MS, 0)).toBe(true);
    expect(focusCheckDue(FOCUS_CHECK_MIN_MS - 1, 0)).toBe(false);
  });

  it("never restarts by itself: it downloads, then waits for Restart to update", () => {
    const src = readFileSync(new URL("../src/lib/updater.ts", import.meta.url), "utf8");
    const check = src.slice(src.indexOf("export async function checkForUpdate"), src.indexOf("async function download("));
    expect(check).toContain("downloadInBackground()");
    expect(check).not.toMatch(/relaunch|downloadAndInstall/);
    const menu = readFileSync(new URL("../src/components/ProfileMenu.svelte", import.meta.url), "utf8");
    expect(menu).toContain("Restart to update");
  });

  it("starts checking at launch, not only after sign-in", () => {
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
    expect(app).toMatch(/\$effect\(\(\) => \{\s*\/\/[^\n]*\n\s*startPeriodicCheck\(\);/);
  });
});

describe("bundled agent spawn", () => {
  it("starts the local coordinator with payments off (no Lightning node on desktops)", () => {
    const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
    expect(main).toMatch(/\.env\("ECONOMY_PAYMENTS_ENABLED", "0"\)/);
  });
});

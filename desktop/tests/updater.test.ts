import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AUTO_UPDATE_KEY, autoUpdateEnabled } from "../src/lib/updater";

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

  it("starts checking at launch, not only after sign-in", () => {
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
    expect(app).toMatch(/\$effect\(\(\) => \{\s*\/\/[^\n]*\n\s*startPeriodicCheck\(\);/);
  });
});

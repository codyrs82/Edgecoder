import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDGECODER_SEED_KEYS, isEdgecoderNetworkUrl, withNetworkTrustDefaults } from "../../src/trust/seed-keys.js";
import { PinnedKeyStore, parseTrustEntries } from "../../src/trust/pinned-keys.js";

describe("seed keys", () => {
  it("match the desktop app's EDGECODER_SEED_KEYS", () => {
    const rust = readFileSync(join(__dirname, "../../desktop/src-tauri/src/network_enrollment.rs"), "utf8");
    const block = /pub const EDGECODER_SEED_KEYS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(rust);
    expect(block).not.toBeNull();
    const fromRust = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...EDGECODER_SEED_KEYS]).toEqual(fromRust);
    expect(parseTrustEntries(EDGECODER_SEED_KEYS.join(",")).size).toBe(EDGECODER_SEED_KEYS.length);
  });

  it("defaults edgecoder.io agents to strict with the seed keys", () => {
    const env = withNetworkTrustDefaults({ COORDINATOR_URL: "https://coordinator.edgecoder.io" });
    expect(env.EDGECODER_TRUST_MODE).toBe("strict");
    expect(env.TRUSTED_COORDINATOR_KEYS).toBe(EDGECODER_SEED_KEYS.join(","));
    const store = PinnedKeyStore.fromEnv(env, { pinFile: "" });
    expect(store.mode).toBe("strict");
    expect(store.configProblem()).toBeFalsy();
  });

  it("leaves explicit settings and other coordinators alone", () => {
    expect(withNetworkTrustDefaults({ COORDINATOR_URL: "https://coordinator.edgecoder.io", EDGECODER_TRUST_MODE: "tofu" }).TRUSTED_COORDINATOR_KEYS).toBeUndefined();
    expect(withNetworkTrustDefaults({ COORDINATOR_URL: "https://coordinator.edgecoder.io", TRUSTED_COORDINATOR_KEYS: "c:" + "a".repeat(64) }).EDGECODER_TRUST_MODE).toBeUndefined();
    expect(withNetworkTrustDefaults({ COORDINATOR_URL: "https://my-coordinator.example" }).EDGECODER_TRUST_MODE).toBeUndefined();
    expect(withNetworkTrustDefaults({}).EDGECODER_TRUST_MODE).toBeUndefined();
    expect(isEdgecoderNetworkUrl("http://coordinator.edgecoder.io")).toBe(false);
    expect(isEdgecoderNetworkUrl("https://edgecoder.io.evil.example")).toBe(false);
    expect(isEdgecoderNetworkUrl("https://evil-edgecoder.io")).toBe(false);
  });
});

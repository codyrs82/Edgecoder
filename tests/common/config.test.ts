import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/common/config.js";
import { inferenceConfigSchema, trustedCoordinatorKeys } from "../../src/inference/config.js";

const base = { INFERENCE_AUTH_TOKEN: "t".repeat(32) };

describe("loadConfig (#15)", () => {
  it("applies defaults and coerces types", () => {
    const c = loadConfig("inference", inferenceConfigSchema, base);
    expect(c.INFERENCE_MAX_SIGNATURE_SKEW_MS).toBe(120_000);
    expect(c.INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS).toBe(false);
    expect(c.OLLAMA_HOST).toBe("http://127.0.0.1:11434");
    expect(c.OLLAMA_MODEL).toBe("qwen3.5:9b");
  });

  it("treats empty values as unset", () => {
    expect(loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_NONCE_TTL_MS: " " }).INFERENCE_NONCE_TTL_MS).toBe(300_000);
  });

  it("lists every problem in one error", () => {
    let err: unknown;
    try {
      loadConfig("inference", inferenceConfigSchema, {
        INFERENCE_MAX_SIGNATURE_SKEW_MS: "soon",
        INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: "maybe",
        OLLAMA_HOST: "ftp://x",
        INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: "[1]"
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    for (const key of ["INFERENCE_AUTH_TOKEN", "INFERENCE_MAX_SIGNATURE_SKEW_MS", "INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS", "OLLAMA_HOST", "INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON"]) {
      expect(msg).toContain(key);
    }
  });

  it("rejects out-of-range integers", () => {
    expect(() => loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_NONCE_TTL_MS: "5" })).toThrow(/INFERENCE_NONCE_TTL_MS: must be >= 1000/);
  });

  it("accepts case-insensitive booleans", () => {
    expect(loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: "TRUE", INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: '{"c":"pem"}' }).INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS).toBe(true);
  });

  it("requires the coordinator peer id and key together (#127 review)", () => {
    expect(() => loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_COORDINATOR_PUBLIC_KEY_PEM: "pem" })).toThrow(/must be set together/);
    expect(() => loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_COORDINATOR_PEER_ID: "coord-a" })).toThrow(/must be set together/);
    const c = loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_COORDINATOR_PEER_ID: "coord-a", INFERENCE_COORDINATOR_PUBLIC_KEY_PEM: "pem" });
    expect(trustedCoordinatorKeys(c)).toEqual(new Map([["coord-a", "pem"]]));
  });

  it("validates the trusted-keys JSON shape", () => {
    for (const bad of ['{"c":""}', '{"":"pem"}', '{"c":1}', "[1]", "not json"]) {
      expect(() => loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: bad }), bad).toThrow(/INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON/);
    }
    const c = loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: '{"a":"k1","b":"k2"}' });
    expect(trustedCoordinatorKeys(c).size).toBe(2);
  });

  it("needs a minimum token length in production only", () => {
    expect(() => loadConfig("inference", inferenceConfigSchema, { NODE_ENV: "production", INFERENCE_AUTH_TOKEN: "changeme" })).toThrow(/at least 32 characters in production/);
    expect(loadConfig("inference", inferenceConfigSchema, { NODE_ENV: "production", INFERENCE_AUTH_TOKEN: "x".repeat(32) }).INFERENCE_AUTH_TOKEN).toHaveLength(32);
    expect(loadConfig("inference", inferenceConfigSchema, { INFERENCE_AUTH_TOKEN: "short" }).INFERENCE_AUTH_TOKEN).toBe("short");
  });

  it("requires a trusted key when signed coordinator requests are required", () => {
    expect(() => loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: "true" })).toThrow(/needs at least one trusted key/);
    expect(() => loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: "true", INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: "{}" })).toThrow(/needs at least one trusted key/);
    expect(
      loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: "true", INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: '{"c":"pem"}' })
        .INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS
    ).toBe(true);
  });
});

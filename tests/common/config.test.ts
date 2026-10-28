import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/common/config.js";
import { inferenceConfigSchema } from "../../src/inference/config.js";

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

  it("requires a trusted key when signed coordinator requests are required", () => {
    expect(() => loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: "true" })).toThrow(/needs INFERENCE_COORDINATOR_PUBLIC_KEY_PEM/);
    expect(
      loadConfig("inference", inferenceConfigSchema, { ...base, INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: "true", INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: '{"c":"pem"}' })
        .INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS
    ).toBe(true);
  });
});

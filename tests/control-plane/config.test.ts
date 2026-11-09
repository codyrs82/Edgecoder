import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/common/config.js";
import { ADMIN_PROD_MIN_TOKEN_LENGTH, controlPlaneConfigSchema } from "../../src/control-plane/config.js";

describe("control-plane config: ADMIN_API_TOKEN", () => {
  it("requires at least 32 characters in production", () => {
    expect(ADMIN_PROD_MIN_TOKEN_LENGTH).toBe(32);
    expect(() => loadConfig("control-plane", controlPlaneConfigSchema, { NODE_ENV: "production", ADMIN_API_TOKEN: "changeme" })).toThrow(/at least 32 characters in production/);
    expect(loadConfig("control-plane", controlPlaneConfigSchema, { NODE_ENV: "production", ADMIN_API_TOKEN: "a".repeat(32) }).ADMIN_API_TOKEN).toHaveLength(32);
  });

  it("keeps accepting shorter tokens outside production", () => {
    expect(loadConfig("control-plane", controlPlaneConfigSchema, { ADMIN_API_TOKEN: "dev-token" }).ADMIN_API_TOKEN).toBe("dev-token");
  });
});

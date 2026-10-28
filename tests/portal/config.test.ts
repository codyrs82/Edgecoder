import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/common/config.js";
import { portalConfigSchema, portalProductionProblems } from "../../src/portal/config.js";
import { coordinatorConfigSchema } from "../../src/swarm/coordinator-config.js";
import { controlPlaneConfigSchema } from "../../src/control-plane/config.js";

const prodOk = {
  NODE_ENV: "production",
  PORTAL_PUBLIC_URL: "https://edgecoder.io",
  PORTAL_SERVICE_TOKEN: "t",
  WALLET_SECRET_PEPPER: "p",
  RESEND_API_KEY: "r",
  CONTROL_PLANE_URL: "https://control.example",
  CONTROL_PLANE_ADMIN_TOKEN: "a",
  DOCS_SITE_URL: "https://docs.edgecoder.io"
};

describe("portal config (#15)", () => {
  it("applies the previous defaults", () => {
    const c = loadConfig("portal", portalConfigSchema, {});
    expect(c.PORTAL_PUBLIC_URL).toBe("http://127.0.0.1:4310");
    expect(c.PORTAL_EXTERNAL_HTTP_TIMEOUT_MS).toBe(7000);
    expect(c.PORTAL_SESSION_TTL_MS).toBe(604_800_000);
    expect(c.WALLET_DEFAULT_NETWORK).toBe("signet");
    expect(c.DOCS_SITE_URL).toBeUndefined();
  });

  it("lists every invalid value at once", () => {
    try {
      loadConfig("portal", portalConfigSchema, { PORTAL_SESSION_TTL_MS: "abc", WALLET_DEFAULT_NETWORK: "mainnet", DOCS_SITE_URL: "docs" });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const problems = (e as ConfigError).problems.join("\n");
      expect(problems).toContain("PORTAL_SESSION_TTL_MS");
      expect(problems).toContain("WALLET_DEFAULT_NETWORK");
      expect(problems).toContain("DOCS_SITE_URL");
    }
  });

  it("requires DOCS_SITE_URL (https) in production", () => {
    const ok = loadConfig("portal", portalConfigSchema, prodOk);
    expect(portalProductionProblems(ok, false)).toEqual([]);
    const { DOCS_SITE_URL: _d, ...noDocs } = prodOk;
    expect(portalProductionProblems(loadConfig("portal", portalConfigSchema, noDocs), false).join(" ")).toContain("DOCS_SITE_URL");
    const httpDocs = loadConfig("portal", portalConfigSchema, { ...prodOk, DOCS_SITE_URL: "http://docs.example" });
    expect(portalProductionProblems(httpDocs, false)).toContain("DOCS_SITE_URL must use https in production.");
  });

  it("skips production rules outside production", () => {
    expect(portalProductionProblems(loadConfig("portal", portalConfigSchema, {}), false)).toEqual([]);
  });
});

describe("coordinator config (#15)", () => {
  it("keeps the previous defaults", () => {
    const c = loadConfig("coordinator", coordinatorConfigSchema, {});
    expect(c.COORDINATOR_FEE_BPS).toBe(150);
    expect(c.ISSUANCE_WINDOW_MS).toBe(86_400_000);
    expect(c.ISSUANCE_SMOOTHING_ALPHA).toBe(0.35);
    expect(c.ROBOT_QUEUE_ENABLED).toBe(false);
    expect(c.BITCOIN_NETWORK).toBe("testnet");
  });

  it("rejects NaN, bad flags and bad enums", () => {
    expect(() =>
      loadConfig("coordinator", coordinatorConfigSchema, { ANCHOR_INTERVAL_MS: "2h", ROBOT_QUEUE_ENABLED: "maybe", BITCOIN_NETWORK: "regtest" })
    ).toThrow(/ANCHOR_INTERVAL_MS[\s\S]*ROBOT_QUEUE_ENABLED[\s\S]*BITCOIN_NETWORK/);
  });
});

describe("control-plane config (#15)", () => {
  it("requires ADMIN_API_TOKEN", () => {
    expect(() => loadConfig("control-plane", controlPlaneConfigSchema, {})).toThrow(/ADMIN_API_TOKEN/);
  });

  it("accepts a path or URL for UI_RETIRE_REDIRECT_URL", () => {
    expect(loadConfig("control-plane", controlPlaneConfigSchema, { ADMIN_API_TOKEN: "x", UI_RETIRE_REDIRECT_URL: "/" }).UI_RETIRE_REDIRECT_URL).toBe("/");
    expect(() => loadConfig("control-plane", controlPlaneConfigSchema, { ADMIN_API_TOKEN: "x", UI_RETIRE_REDIRECT_URL: "javascript:x" })).toThrow();
  });
});

import { describe, expect, test } from "vitest";
import { checkSharedToken, requireProdEnv, resolveListenHost } from "../../src/common/env-guard.js";

describe("env-guard (#5)", () => {
  test("production + missing vars -> throws listing the names", () => {
    expect(() =>
      requireProdEnv("coordinator", ["MESH_AUTH_TOKEN", "ADMIN_API_TOKEN", "PORTAL_SERVICE_TOKEN"], {
        NODE_ENV: "production",
        MESH_AUTH_TOKEN: "   ",
        ADMIN_API_TOKEN: "set"
      })
    ).toThrow("[coordinator] missing required production env: MESH_AUTH_TOKEN, PORTAL_SERVICE_TOKEN");
  });

  test("production + all vars set -> no throw", () => {
    expect(() => requireProdEnv("x", ["A"], { NODE_ENV: "production", A: "1" })).not.toThrow();
  });

  test("dev -> no throw even when vars are missing", () => {
    expect(() => requireProdEnv("x", ["A", "B"], { NODE_ENV: "development" })).not.toThrow();
    expect(() => requireProdEnv("x", ["A"], {})).not.toThrow();
  });

  test("LISTEN_HOST defaults to 127.0.0.1 and honours HOST", () => {
    expect(resolveListenHost({})).toBe("127.0.0.1");
    expect(resolveListenHost({ HOST: "" })).toBe("127.0.0.1");
    expect(resolveListenHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  test("checkSharedToken: empty token is open in dev, not_configured in prod", () => {
    expect(checkSharedToken("", undefined, false)).toBe("ok");
    expect(checkSharedToken("", "anything", true)).toBe("not_configured");
    expect(checkSharedToken("secret", "secret", true)).toBe("ok");
    expect(checkSharedToken("secret", "wrong", true)).toBe("unauthorized");
    expect(checkSharedToken("secret", undefined, false)).toBe("unauthorized");
  });
});

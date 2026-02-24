import { describe, expect, test } from "vitest";
import { safeTokenEqual } from "../../src/swarm/coordinator-utils.js";

// ---------------------------------------------------------------------------
// Local helpers that reimplement the guard patterns from coordinator.ts.
// The real functions use module-level env vars and are not exported, so we
// recreate the logic here on top of the exported `safeTokenEqual`.
// ---------------------------------------------------------------------------

function hasMeshToken(
  headers: Record<string, unknown>,
  meshAuthToken: string,
): boolean {
  if (!meshAuthToken) return true;
  const token = headers["x-mesh-token"];
  return typeof token === "string" && safeTokenEqual(token, meshAuthToken);
}

function hasPortalServiceToken(
  headers: Record<string, unknown>,
  portalServiceToken: string,
): boolean {
  if (!portalServiceToken) return true;
  const token = headers["x-portal-service-token"];
  return typeof token === "string" && safeTokenEqual(token, portalServiceToken);
}

function requireMeshToken(
  headers: Record<string, unknown>,
  meshAuthToken: string,
): { ok: true } | { ok: false; code: number } {
  if (!meshAuthToken) return { ok: true };
  const token = headers["x-mesh-token"];
  if (typeof token === "string" && safeTokenEqual(token, meshAuthToken))
    return { ok: true };
  return { ok: false, code: 401 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coordinator auth guards", () => {
  // ---- requireMeshToken pattern ----

  describe("requireMeshToken pattern", () => {
    test("no global token configured (empty string) -> always passes", () => {
      const result = requireMeshToken({}, "");
      expect(result).toEqual({ ok: true });
    });

    test("correct token -> passes", () => {
      const secret = "mesh-secret-42";
      const result = requireMeshToken(
        { "x-mesh-token": secret },
        secret,
      );
      expect(result).toEqual({ ok: true });
    });

    test("wrong token -> 401", () => {
      const result = requireMeshToken(
        { "x-mesh-token": "wrong-token" },
        "correct-token",
      );
      expect(result).toEqual({ ok: false, code: 401 });
    });
  });

  // ---- hasMeshToken pattern ----

  describe("hasMeshToken pattern", () => {
    test("no global token configured -> true", () => {
      expect(hasMeshToken({}, "")).toBe(true);
    });

    test("correct token -> true", () => {
      const secret = "mesh-secret-99";
      expect(hasMeshToken({ "x-mesh-token": secret }, secret)).toBe(true);
    });

    test("missing header -> false", () => {
      expect(hasMeshToken({}, "some-secret")).toBe(false);
    });

    test("non-string header value -> false", () => {
      expect(hasMeshToken({ "x-mesh-token": 12345 }, "some-secret")).toBe(
        false,
      );
    });
  });

  // ---- hasPortalServiceToken pattern ----

  describe("hasPortalServiceToken pattern", () => {
    test("no global token configured -> true", () => {
      expect(hasPortalServiceToken({}, "")).toBe(true);
    });

    test("correct token -> true", () => {
      const secret = "portal-secret-77";
      expect(
        hasPortalServiceToken({ "x-portal-service-token": secret }, secret),
      ).toBe(true);
    });

    test("missing header -> false", () => {
      expect(hasPortalServiceToken({}, "portal-secret")).toBe(false);
    });
  });

  // ---- Payment webhook secret / safeTokenEqual directly ----

  describe("payment webhook secret (safeTokenEqual)", () => {
    test("timing-safe comparison succeeds for matching strings", () => {
      const webhookSecret = "whsec_abc123xyz";
      expect(safeTokenEqual(webhookSecret, webhookSecret)).toBe(true);
    });

    test("type check: non-string values are rejected before reaching safeTokenEqual", () => {
      // safeTokenEqual expects strings; the guard pattern checks typeof first.
      // Verify that the guard rejects a numeric header before calling safeTokenEqual.
      const headers: Record<string, unknown> = {
        "x-mesh-token": 99999,
      };
      const token = headers["x-mesh-token"];
      const accepted =
        typeof token === "string" && safeTokenEqual(token, "real-secret");
      expect(accepted).toBe(false);
    });
  });
});

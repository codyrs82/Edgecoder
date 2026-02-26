import { describe, expect, test } from "vitest";
import {
  defaultDeploymentPlan,
  type CoordinatorDeploymentPlan,
} from "../../src/control-plane/deployment.js";

// ---------------------------------------------------------------------------
// defaultDeploymentPlan
// ---------------------------------------------------------------------------

describe("defaultDeploymentPlan", () => {
  test("returns a non-null object", () => {
    const plan = defaultDeploymentPlan();
    expect(plan).toBeDefined();
    expect(typeof plan).toBe("object");
  });

  // ---- coordinatorUiHome ----

  describe("coordinatorUiHome", () => {
    test("service is control-plane", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.coordinatorUiHome.service).toBe("control-plane");
    });

    test("route is /ui", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.coordinatorUiHome.route).toBe("/ui");
    });

    test("notes is a non-empty string", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.coordinatorUiHome.notes.length).toBeGreaterThan(0);
    });
  });

  // ---- firstCoordinatorRuntime ----

  describe("firstCoordinatorRuntime", () => {
    test("target is fly_io_app", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.firstCoordinatorRuntime.target).toBe("fly_io_app");
    });

    test("containerized is true", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.firstCoordinatorRuntime.containerized).toBe(true);
    });

    test("recommendation is a non-empty string", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.firstCoordinatorRuntime.recommendation.length).toBeGreaterThan(0);
    });

    test("regionHint is a non-empty string", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.firstCoordinatorRuntime.regionHint.length).toBeGreaterThan(0);
    });
  });

  // ---- sqlBackend ----

  describe("sqlBackend", () => {
    test("engine is fly_postgres", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.sqlBackend.engine).toBe("fly_postgres");
    });

    test("version is 16", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.sqlBackend.version).toBe("16");
    });

    test("connectionEnv is DATABASE_URL", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.sqlBackend.connectionEnv).toBe("DATABASE_URL");
    });

    test("rationale is a non-empty string", () => {
      const plan = defaultDeploymentPlan();
      expect(plan.sqlBackend.rationale.length).toBeGreaterThan(0);
    });
  });

  // ---- Immutability / factory behavior ----

  test("each call returns a fresh object (not the same reference)", () => {
    const plan1 = defaultDeploymentPlan();
    const plan2 = defaultDeploymentPlan();
    expect(plan1).not.toBe(plan2);
    expect(plan1).toEqual(plan2);
  });

  test("mutating one plan does not affect a subsequent call", () => {
    const plan1 = defaultDeploymentPlan();
    plan1.sqlBackend.version = "99";
    const plan2 = defaultDeploymentPlan();
    expect(plan2.sqlBackend.version).toBe("16");
  });

  // ---- Shape / type guard ----

  test("plan has exactly the three expected top-level keys", () => {
    const plan = defaultDeploymentPlan();
    const keys = Object.keys(plan).sort();
    expect(keys).toEqual(["coordinatorUiHome", "firstCoordinatorRuntime", "sqlBackend"]);
  });
});

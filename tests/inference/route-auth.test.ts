import { describe, expect, it } from "vitest";
import { inferenceRouteAuth } from "../../src/inference/route-auth.js";

describe("inference route auth (#119 review)", () => {
  it("model mutations need the token; read-only model GETs stay public", () => {
    expect(inferenceRouteAuth("POST", "/model/pull")).toBe("token");
    expect(inferenceRouteAuth("POST", "/model/swap")).toBe("token");
    expect(inferenceRouteAuth("GET", "/model/status")).toBe("public");
    expect(inferenceRouteAuth("GET", "/model/list")).toBe("public");
    expect(inferenceRouteAuth("GET", "/model/pull/progress?x=1")).toBe("public");
    expect(inferenceRouteAuth("GET", "/model/anything-else")).toBe("token");
  });

  it("health, metrics and dashboard are public; everything else is full auth", () => {
    expect(inferenceRouteAuth("GET", "/health")).toBe("public");
    expect(inferenceRouteAuth("GET", "/metrics")).toBe("public");
    expect(inferenceRouteAuth("GET", "/dashboard/x")).toBe("public");
    expect(inferenceRouteAuth("GET", "/dashboardevil")).toBe("full");
    expect(inferenceRouteAuth("POST", "/decompose")).toBe("full");
  });
});

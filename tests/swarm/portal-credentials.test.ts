import { describe, expect, it } from "vitest";
import { checkPortalInboundToken, portalOutboundHeaders } from "../../src/swarm/coordinator/portal-credentials.js";
import { tokenSet } from "../../src/common/token-rotation.js";
import { bootstrapRegisterLogLevel } from "../../src/mesh/peer-trust.js";

describe("coordinator inbound portal token", () => {
  const service = tokenSet("portal-service-token", undefined, undefined);

  it("accepts the portal's service token", () => {
    expect(checkPortalInboundToken(service, "shared-coordinator-token", "portal-service-token", true)).toBe("ok");
    expect(checkPortalInboundToken(service, "", "portal-service-token", true)).toBe("ok");
  });

  it("never accepts the outbound-only coordinator token as the portal", () => {
    expect(checkPortalInboundToken(service, "shared-coordinator-token", "shared-coordinator-token", true)).toBe("unauthorized");
    // Even when PORTAL_SERVICE_TOKEN was set to the same value.
    const same = tokenSet("shared-coordinator-token", undefined, undefined);
    expect(checkPortalInboundToken(same, "shared-coordinator-token", "shared-coordinator-token", true)).toBe("unauthorized");
    expect(checkPortalInboundToken(service, "shared-coordinator-token", "wrong", true)).toBe("unauthorized");
  });

  it("keeps the unset behaviour (closed in production)", () => {
    expect(checkPortalInboundToken(tokenSet("", undefined, undefined), "", "x", true)).toBe("not_configured");
  });
});

describe("coordinator outbound portal headers", () => {
  it("names the coordinator when it is enrolled", () => {
    expect(portalOutboundHeaders("coord-a", "coord-a-registration", "tok")).toEqual({
      "content-type": "application/json",
      "x-portal-service-token": "tok",
      "x-coordinator-node-id": "coord-a",
      "x-coordinator-registration-token": "coord-a-registration"
    });
    expect(portalOutboundHeaders("coord-a", "", "")).toEqual({ "content-type": "application/json" });
  });
});

describe("mesh_bootstrap_registered log level", () => {
  it("warns when the peer refused the registration", () => {
    expect(bootstrapRegisterLogLevel(200)).toBe("info");
    expect(bootstrapRegisterLogLevel(204)).toBe("info");
    expect(bootstrapRegisterLogLevel(401)).toBe("warn");
    expect(bootstrapRegisterLogLevel(403)).toBe("warn");
    expect(bootstrapRegisterLogLevel(500)).toBe("warn");
  });
});

import { describe, expect, it } from "vitest";
import { paramsB, routeFromModelId, routeModelId } from "../../src/inference-api/auto-route.js";
import { parseNetworkModel } from "../../src/apps/ide/network-inference.js";
import { parseModelId } from "../../src/apps/ide/sessions.js";
import { cloudHostAllowed, filterCloudModels, parseCloudHostOwners } from "../../src/swarm/coordinator/cloud-hosts.js";

/* Cloud model ids on the network ("network/glm-5.3@cloud") and the coordinator's cloud-host rules. */

describe("network ids with the cloud class", () => {
  it("parse everywhere a network model id is read", () => {
    const r = routeFromModelId("network/glm-5.3@cloud")!;
    expect(r).toMatchObject({ placement: "network", model: "glm-5.3", computeClass: "cloud" });
    expect(routeModelId(r)).toBe("network/glm-5.3@cloud");
    expect(parseNetworkModel("network/deepseek-v4.1-flash@cloud")).toEqual({ model: "deepseek-v4.1-flash", computeClass: "cloud" });
    expect(parseModelId("network/glm-5.3@cloud")).toEqual({ model: "glm-5.3", compute: { target: "network", computeClass: "cloud" } });
    expect(routeFromModelId("network/glm-5.3")).toMatchObject({ model: "glm-5.3", computeClass: "any" });
  });

  it("size a cloud model by its catalog parameters (Auto's sizing), not the 7B default", () => {
    expect(paramsB("glm-5.3")).toBe(744);
    expect(paramsB("deepseek-v4.1-flash")).toBe(552);
    expect(paramsB("qwen3-coder:30b")).toBe(30);
  });
});

describe("coordinator cloud-host rules", () => {
  it("only allowlisted, approved owners may run a cloud host", () => {
    const owners = parseCloudHostOwners(" Ops@EdgeCoder.io, nonsense ,b@x.io");
    expect([...owners]).toEqual(["ops@edgecoder.io", "b@x.io"]);
    expect(cloudHostAllowed(owners, "ops@edgecoder.io", true)).toBe(true);
    expect(cloudHostAllowed(owners, "OPS@edgecoder.io", undefined)).toBe(true);
    expect(cloudHostAllowed(owners, "ops@edgecoder.io", false)).toBe(false);
    expect(cloudHostAllowed(owners, "other@x.io", true)).toBe(false);
    expect(cloudHostAllowed(owners, undefined, true)).toBe(false);
    expect(cloudHostAllowed(parseCloudHostOwners(undefined), "ops@edgecoder.io", true)).toBe(false);
  });

  it("cloud ids only on a cloud host, and a cloud host only cloud ids", () => {
    expect(filterCloudModels(["glm-5.3", "qwen3.5:4b", "GLM-5.3:latest"], false)).toEqual(["qwen3.5:4b"]);
    expect(filterCloudModels(["glm-5.3", "qwen3.5:4b", "GLM-5.3:latest", "deepseek-v4.1-flash"], true)).toEqual(["glm-5.3", "deepseek-v4.1-flash"]);
  });
});

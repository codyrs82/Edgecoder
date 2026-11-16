import { describe, expect, it } from "vitest";
import { guideToOpen } from "../src/lib/onboarding-launch";

describe("when the app opens Getting started by itself", () => {
  it("first sign-in: the portal says show, on the saved step or from the start", async () => {
    expect(await guideToOpen("", async () => ({ show: true, state: null }))).toBe("saved");
    expect(await guideToOpen("", async () => ({ show: true, state: { current: "fund" } }))).toBe("fund");
  });
  it("not when dismissed or finished (the portal says no), nor when the portal is unreachable", async () => {
    expect(await guideToOpen("", async () => ({ show: false, state: { current: "fund" } }))).toBeNull();
    expect(await guideToOpen("", async () => { throw new Error("offline"); })).toBeNull();
  });
  it("a #/welcome/<step> route always opens that step (the explainer videos use it)", async () => {
    expect(await guideToOpen("#/welcome/tools", async () => ({ show: false, state: null }))).toBe("tools");
    expect(await guideToOpen("#/welcome/nope", async () => ({ show: false, state: null }))).toBeNull();
  });
});

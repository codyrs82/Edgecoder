import { describe, expect, it } from "vitest";
import { choiceId, choiceLabel, parseChoice, usageText } from "../src/lib/compute-choice";
import { computeFields } from "../src/lib/api";

describe("reply usage text", () => {
  it("says free only where it is free, and nothing when the reply never ran", () => {
    expect(usageText({ cSats: 0 })).toBeNull();
    expect(usageText({ cSats: 0, where: "This computer · qwen2.5-coder:1.5b" })).toBe("This computer · qwen2.5-coder:1.5b · free");
    expect(usageText({ cSats: 0, where: "My machines · qwen3.5:9b" })).toBe("My machines · qwen3.5:9b · free");
    expect(usageText({ cSats: 0, where: "Network GPU · qwen3.5:9b" })).toBe("Network GPU · qwen3.5:9b · 0 cSats");
    expect(usageText({ cSats: 0, where: "Reserved GPU · m" })).toBe("Reserved GPU · m · prepaid");
    expect(usageText({ cSats: 1.5, where: "Network GPU · m" })).toBe("Network GPU · m · 1.5 cSats");
    expect(usageText({ cSats: 2 })).toBe("Network · 2 cSats");
  });
});

describe("compute choice", () => {
  it("round-trips every kind of id", () => {
    for (const id of ["qwen3.5:9b", "mine/qwen3.5:9b", "network/qwen3.5:9b", "network/qwen3.5:9b@gpu.dc", "reserved/res-1/qwen2.5-coder:32b"]) {
      expect(choiceId(parseChoice(id))).toBe(id);
    }
    expect(parseChoice(undefined)).toEqual({ where: "auto" });
  });

  it("labels the model and where it runs", () => {
    expect(choiceLabel("network/qwen2.5-coder:7b-instruct@gpu")).toEqual({ model: "qwen2.5-coder:7b", where: "Network GPU" });
    expect(choiceLabel("mine/qwen3.5:9b")).toEqual({ model: "qwen3.5:9b", where: "My machines" });
    expect(choiceLabel(undefined).model).toBe("Auto");
  });

  it("turns a choice into the IDE chat's model and compute", () => {
    expect(computeFields("network/m@gpu")).toEqual({ model: "m", compute: { target: "network", computeClass: "gpu" } });
    expect(computeFields("reserved/r1/m")).toEqual({ model: "m", compute: { target: "reserved", reservationId: "r1" } });
    expect(computeFields("m")).toEqual({ model: "m" });
  });
});

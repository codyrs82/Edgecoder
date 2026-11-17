import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as S from "../../src/common/served.js";

describe("served (the reply footer, shared by the desktop app and the portal)", () => {
  it("is byte-identical in src/common and desktop/src/lib", () => {
    const shared = readFileSync(new URL("../../src/common/served.ts", import.meta.url), "utf8");
    const desktop = readFileSync(new URL("../../desktop/src/lib/served.ts", import.meta.url), "utf8");
    expect(desktop).toBe(shared);
  });

  const base = { own: false, tier: null, region: null, country: null } as const;
  it("network: class, GPU, tokens with times, cSats", () => {
    const served = { ...base, label: "lin-x", computeClass: "gpu.dc", tier: "gpu.dc40", hardware: "Datacenter GPU (gpu.dc40)", gpu: "NVIDIA A100-SXM4-40GB", promptTokens: 13600, promptMs: 1100, outputTokens: 156, genMs: 1200 };
    expect(S.servedLine([{ cSats: 12.279, served }])).toBe("Datacenter GPU A100-SXM4-40GB · read 13.6k tok in 1.1 s · wrote 156 tok in 1.2 s · 12.279 cSats");
  });

  it("this computer and EdgeCoder's model are free", () => {
    const local = { ...base, own: true, label: "This computer", computeClass: "local", hardware: "This computer (Apple M5 Max)" };
    expect(S.servedLine([{ cSats: 0, model: "qwen2.5-coder:7b", served: local }])).toBe("qwen2.5-coder:7b · This computer (Apple M5 Max) · free");
    const ec = { ...base, label: "EdgeCoder", computeClass: "edgecoder", hardware: "EdgeCoder's model", outputTokens: 12 };
    expect(S.servedLine([{ cSats: 0, served: ec }])).toBe("EdgeCoder's model · wrote 12 tok · free");
  });

  it("runs from its source text (the portal ships it via Function.prototype.toString)", () => {
    const lib = [S.servedTok, S.servedSecs, S.servedCost, S.hardwareShort, S.servedLine, S.servedBreakdown].map((f) => f.toString()).join("\n");
    const line = new Function(`${lib}\nreturn servedLine;`)() as typeof S.servedLine;
    expect(line([{ cSats: 0, model: "m", served: { ...base, own: true, label: "x", computeClass: "apple", hardware: "Apple Silicon", promptTokens: 2000, promptMs: 500 } }])).toBe("m · Apple Silicon · your machine · read 2k tok in 0.5 s · free");
  });
});

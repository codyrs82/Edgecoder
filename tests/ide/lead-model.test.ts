// Context graduation: the lead moves to a larger window as its conversation grows.
import { describe, expect, it } from "vitest";
import { chooseLeadModel, estimateTokens, parseLeadCandidates } from "../../src/apps/ide/lead-model.js";

const candidates = parseLeadCandidates("network/small:8b=16384,network/mid:30b=32768,network/big:70b@gpu=131072");

describe("context graduation", () => {
  it("parses candidates from the env format", () => {
    expect(candidates).toEqual([
      { id: "network/small:8b", contextTokens: 16384, costRank: 0 },
      { id: "network/mid:30b", contextTokens: 32768, costRank: 1 },
      { id: "network/big:70b@gpu", contextTokens: 131072, costRank: 2 },
    ]);
    expect(parseLeadCandidates("junk,=5,a=x")).toEqual([]);
  });
  it("stays while the conversation fits", () => {
    expect(chooseLeadModel({ current: "network/small:8b", promptTokens: 10_000, candidates })).toMatchObject({ changed: false, model: "network/small:8b" });
  });
  it("moves to the smallest window that fits", () => {
    expect(chooseLeadModel({ current: "network/small:8b", promptTokens: 20_000, candidates })).toMatchObject({ changed: true, model: "network/mid:30b" });
    expect(chooseLeadModel({ current: "network/small:8b", promptTokens: 60_000, candidates })).toMatchObject({ changed: true, model: "network/big:70b@gpu" });
  });
  it("prefers the frontier lead (BYOK) when there is one", () => {
    expect(chooseLeadModel({ current: "network/small:8b", promptTokens: 20_000, candidates, frontierLead: { id: "frontier/claude", contextTokens: 200_000 } })).toMatchObject({ changed: true, model: "frontier/claude" });
    expect(chooseLeadModel({ current: "frontier/claude", promptTokens: 190_000, candidates, frontierLead: { id: "frontier/claude", contextTokens: 200_000 } })).toMatchObject({ changed: false });
  });
  it("leaves auto alone without a frontier lead, and takes the largest when nothing fits", () => {
    expect(chooseLeadModel({ current: "auto", promptTokens: 500_000, candidates })).toMatchObject({ changed: false });
    expect(chooseLeadModel({ current: "network/small:8b", promptTokens: 500_000, candidates })).toMatchObject({ changed: true, model: "network/big:70b@gpu" });
    expect(chooseLeadModel({ current: "network/big:70b@gpu", promptTokens: 500_000, candidates })).toMatchObject({ changed: false });
  });
  it("estimates tokens", () => {
    expect(estimateTokens([{ content: "x".repeat(3500) }])).toBe(Math.ceil(3516 / 3.5));
  });
});

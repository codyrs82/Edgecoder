import { describe, expect, it } from "vitest";
import {
  agentHasModel,
  agentRunsModel,
  normalizeReportedModels,
  resultModelMismatch,
  routableModels,
  subtaskModelEligible
} from "../../src/swarm/model-catalog.js";

const reported = { modelsReported: true, activeModel: "qwen2.5-coder:7b", localModelCatalog: ["qwen2.5-coder:7b", "llama3.1:8b"] };
// An older agent (no installedModels): the coordinator assumed its default model.
const assumed = { activeModel: "qwen2.5-coder:7b", localModelCatalog: ["qwen2.5-coder:7b"] };

describe("#54 model catalog", () => {
  it("normalizes a report: trims, de-duplicates, drops the placeholder", () => {
    expect(normalizeReportedModels([" a:1 ", "a:1", "", "edgecoder-default", "b:2"])).toEqual(["a:1", "b:2"]);
    expect(normalizeReportedModels(undefined)).toEqual([]);
  });

  it("only a reported catalog is routable", () => {
    expect(routableModels(reported)).toEqual(["qwen2.5-coder:7b", "llama3.1:8b"]);
    expect(routableModels(assumed)).toEqual([]);
    expect(routableModels(undefined)).toEqual([]);
  });

  it("agentHasModel: installed models of a reporting agent; never an assumed or claimed-active one", () => {
    expect(agentHasModel(reported, "llama3.1:8b")).toBe(true);
    expect(agentHasModel(reported, "mixtral:8x7b")).toBe(false);
    expect(agentHasModel(assumed, "qwen2.5-coder:7b")).toBe(false);
    // A heartbeat-claimed active model that isn't in the reported catalog doesn't count.
    expect(agentHasModel({ ...reported, activeModel: "mixtral:8x7b" }, "mixtral:8x7b")).toBe(false);
    expect(agentHasModel(reported, undefined)).toBe(false);
  });

  it("agentRunsModel: code work needs the active model, installed", () => {
    expect(agentRunsModel(reported, "qwen2.5-coder:7b")).toBe(true);
    expect(agentRunsModel(reported, "llama3.1:8b")).toBe(false);
    expect(agentRunsModel(assumed, "qwen2.5-coder:7b")).toBe(false);
  });

  it("claim gate: a model-named task goes only to an agent with the model", () => {
    expect(subtaskModelEligible(reported, { kind: "inference", requestedModel: "llama3.1:8b" })).toBe(true);
    expect(subtaskModelEligible(reported, { kind: "inference", requestedModel: "mixtral:8x7b" })).toBe(false);
    expect(subtaskModelEligible(reported, { kind: "micro_loop", requestedModel: "llama3.1:8b" })).toBe(false);
    expect(subtaskModelEligible(reported, { kind: "micro_loop", requestedModel: "qwen2.5-coder:7b" })).toBe(true);
    // Tasks that name no model: every agent, including older ones (backward compatible).
    expect(subtaskModelEligible(assumed, { kind: "micro_loop" })).toBe(true);
    expect(subtaskModelEligible(undefined, {})).toBe(true);
    expect(subtaskModelEligible(assumed, { kind: "inference", requestedModel: "qwen2.5-coder:7b" })).toBe(false);
  });

  it("result check: a reported model must be the requested one; older agents don't report", () => {
    expect(resultModelMismatch("llama3.1:8b", "llama3.1:8b")).toBe(false);
    expect(resultModelMismatch("llama3.1:8b", "qwen2.5-coder:7b")).toBe(true);
    expect(resultModelMismatch("llama3.1:8b", undefined)).toBe(false);
    expect(resultModelMismatch(undefined, "qwen2.5-coder:7b")).toBe(false);
  });
});

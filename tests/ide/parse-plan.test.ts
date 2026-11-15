import { describe, expect, it } from "vitest";
import { parsePlan } from "../../src/apps/ide/agent-loop.js";

describe("parsePlan", () => {
  it("should parse a JSON list of steps with index, description and status", () => {
    const body = JSON.stringify([
      { index: 0, description: "Step 1", status: "pending" },
      { index: 1, description: "Step 2", status: "in_progress" },
      { index: 2, description: "Step 3", status: "completed" }
    ]);
    
    const result = parsePlan(body);
    expect(result).toEqual([
      { index: 0, description: "Step 1", status: "pending" },
      { index: 1, description: "Step 2", status: "in_progress" },
      { index: 2, description: "Step 3", status: "completed" }
    ]);
  });

  it("should use position as index when index is missing", () => {
    const body = JSON.stringify([
      { description: "Step 1", status: "pending" },
      { description: "Step 2", status: "in_progress" },
      { description: "Step 3", status: "completed" }
    ]);
    
    const result = parsePlan(body);
    expect(result).toEqual([
      { index: 0, description: "Step 1", status: "pending" },
      { index: 1, description: "Step 2", status: "in_progress" },
      { index: 2, description: "Step 3", status: "completed" }
    ]);
  });

  it("should set status to 'pending' when status is missing", () => {
    const body = JSON.stringify([
      { index: 0, description: "Step 1" },
      { index: 1, description: "Step 2" },
      { index: 2, description: "Step 3" }
    ]);
    
    const result = parsePlan(body);
    expect(result).toEqual([
      { index: 0, description: "Step 1", status: "pending" },
      { index: 1, description: "Step 2", status: "pending" },
      { index: 2, description: "Step 3", status: "pending" }
    ]);
  });

  it("should set description to empty string when description is missing", () => {
    const body = JSON.stringify([
      { index: 0, status: "pending" },
      { index: 1, status: "in_progress" },
      { index: 2, status: "completed" }
    ]);
    
    const result = parsePlan(body);
    expect(result).toEqual([
      { index: 0, description: "", status: "pending" },
      { index: 1, description: "", status: "in_progress" },
      { index: 2, description: "", status: "completed" }
    ]);
  });

  it("should return null when input is not a JSON list", () => {
    const body = JSON.stringify({
      step: "not a list"
    });
    
    const result = parsePlan(body);
    expect(result).toBeNull();
  });

  it("should return null when input is malformed JSON", () => {
    const body = "{ invalid json }";
    
    const result = parsePlan(body);
    expect(result).toBeNull();
  });

  it("should return null when input is not a JSON array", () => {
    const body = JSON.stringify("not an array");
    
    const result = parsePlan(body);
    expect(result).toBeNull();
  });
});
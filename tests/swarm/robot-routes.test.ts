import { describe, expect, test } from "vitest";
import {
  robotAgentRegisterSchema,
  robotTaskCreateSchema,
  robotProofSchema,
  robotDisputeSchema,
  robotClaimSchema,
  robotAgentHeartbeatSchema
} from "../../src/swarm/robot-routes.js";

describe("robot route schemas", () => {
  test("agent register schema validates valid input", () => {
    const result = robotAgentRegisterSchema.safeParse({
      agentId: "robot-1",
      payoutAddress: "tb1qtest123456",
      capabilities: ["camera", "gps"],
      robotKind: "rover"
    });
    expect(result.success).toBe(true);
  });

  test("agent register schema rejects missing payoutAddress", () => {
    const result = robotAgentRegisterSchema.safeParse({
      agentId: "robot-1",
      capabilities: [],
      robotKind: "rover"
    });
    expect(result.success).toBe(false);
  });

  test("agent register schema rejects empty agentId", () => {
    const result = robotAgentRegisterSchema.safeParse({
      agentId: "",
      payoutAddress: "tb1qtest",
      capabilities: [],
      robotKind: "rover"
    });
    expect(result.success).toBe(false);
  });

  test("heartbeat schema validates valid input", () => {
    const result = robotAgentHeartbeatSchema.safeParse({ agentId: "r1" });
    expect(result.success).toBe(true);
  });

  test("task create schema validates valid input", () => {
    const result = robotTaskCreateSchema.safeParse({
      clientAccountId: "client-1",
      title: "Deliver package",
      description: "Deliver to XY",
      taskKind: "physical",
      resourceRequirements: ["gps"],
      amountSats: 100_000
    });
    expect(result.success).toBe(true);
  });

  test("task create schema defaults resourceRequirements to empty array", () => {
    const result = robotTaskCreateSchema.safeParse({
      clientAccountId: "c1",
      title: "t",
      description: "d",
      taskKind: "compute",
      amountSats: 1000
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceRequirements).toEqual([]);
    }
  });

  test("task create schema rejects zero amountSats", () => {
    const result = robotTaskCreateSchema.safeParse({
      clientAccountId: "c1",
      title: "t",
      description: "d",
      taskKind: "compute",
      resourceRequirements: [],
      amountSats: 0
    });
    expect(result.success).toBe(false);
  });

  test("task create schema rejects invalid taskKind", () => {
    const result = robotTaskCreateSchema.safeParse({
      clientAccountId: "c1",
      title: "t",
      description: "d",
      taskKind: "invalid",
      resourceRequirements: [],
      amountSats: 1000
    });
    expect(result.success).toBe(false);
  });

  test("claim schema validates agentId", () => {
    const result = robotClaimSchema.safeParse({ agentId: "r1" });
    expect(result.success).toBe(true);
  });

  test("proof schema validates payload", () => {
    const result = robotProofSchema.safeParse({ payload: { gps: [1.0, 2.0] } });
    expect(result.success).toBe(true);
  });

  test("dispute schema validates reason", () => {
    const result = robotDisputeSchema.safeParse({ reason: "bad quality" });
    expect(result.success).toBe(true);
  });

  test("dispute schema rejects empty reason", () => {
    const result = robotDisputeSchema.safeParse({ reason: "" });
    expect(result.success).toBe(false);
  });
});

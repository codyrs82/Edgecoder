import { describe, expect, it } from "vitest";
import { nodeRemovalBlocker } from "../../src/swarm/coordinator/node-removal.js";

describe("nodeRemovalBlocker", () => {
  it("a lease blocks first, then running tasks, else nothing", () => {
    expect(nodeRemovalBlocker({ lease: { id: "r1", endMs: 0 }, runningClaims: 2 })).toMatchObject({ error: "active_reservation", reservationId: "r1" });
    expect(nodeRemovalBlocker({ runningClaims: 2 })).toMatchObject({ error: "running_task", runningClaims: 2 });
    expect(nodeRemovalBlocker({ runningClaims: 0 })).toBeNull();
  });
});

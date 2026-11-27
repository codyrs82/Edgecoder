import { describe, expect, it } from "vitest";
import { accountActivity, coordinatorLabel, routingFeeTaskId } from "../../src/ledger-service/earnings-view.js";

/*
 * Routing-fee earnings (routing_fee:<task>, the ledger service's routing share) in an account's
 * activity: each row names the coordinator that routed the call, and the total is reported apart.
 */
describe("routing-fee earnings in the account activity", () => {
  it("recognises routing-fee rows by reason", () => {
    expect(routingFeeTaskId("routing_fee:t1")).toBe("t1");
    expect(routingFeeTaskId("routing_fee:")).toBeNull();
    expect(routingFeeTaskId("network_fee:t1")).toBeNull();
    expect(routingFeeTaskId(undefined)).toBeNull();
  });

  it("names a coordinator by its public host, else its operator, else its peer id", () => {
    expect(coordinatorLabel("p1", { urls: ["https://coord.example.org:8443/x"], operator: { name: "Op" } })).toBe("coord.example.org");
    expect(coordinatorLabel("p1", { urls: ["not a url"], operator: { name: "Op" } })).toBe("Op");
    expect(coordinatorLabel("p1", null)).toBe("p1");
  });

  it("labels routing-fee rows with their coordinator and totals them, newest first", () => {
    const history = [
      { type: "earn", credits: 4.75, reason: "compute_contribution", relatedTaskId: "t0", timestampMs: 1 },
      { type: "earn", credits: 0.24, reason: "routing_fee:t1", relatedTaskId: "t1", timestampMs: 3 },
      { type: "earn", credits: 0.1, reason: "routing_fee:t2", relatedTaskId: "t2", timestampMs: 2 },
      { type: "spend", credits: 1, reason: "payout", timestampMs: 4 }
    ];
    const { recent, routingFeeSats } = accountActivity(history, (taskId) => (taskId === "t1" ? "coord.example.org" : undefined));
    expect(routingFeeSats).toBe(0.34);
    expect(recent.map((r) => r.reason)).toEqual(["payout", "routing_fee:t1", "routing_fee:t2", "compute_contribution"]);
    expect(recent[1]).toEqual({ type: "earn", cSats: 0.24, reason: "routing_fee:t1", taskId: "t1", atMs: 3, coordinator: "coord.example.org" });
    expect(recent[2]).not.toHaveProperty("coordinator");
    expect(accountActivity(history, () => undefined, 1).recent).toHaveLength(1);
  });
});

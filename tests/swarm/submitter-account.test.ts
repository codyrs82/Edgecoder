import { describe, expect, it } from "vitest";
import { submitterAccountDecision } from "../../src/swarm/coordinator-utils.js";

const base = { portalService: false, signature: null, loopback: false } as const;

describe("submitterAccountDecision (/submit billing)", () => {
  it("lets the portal name any account", () => {
    expect(submitterAccountDecision({ ...base, requested: "acct-u1", portalService: true })).toEqual({ accountId: "acct-u1" });
  });

  it("refuses a mesh-token caller naming someone's account", () => {
    expect(submitterAccountDecision({ ...base, requested: "acct-victim" })).toEqual({ status: 403, error: "submitter_signature_required" });
  });

  it("still allows anonymous submissions and loopback callers", () => {
    expect(submitterAccountDecision({ ...base, requested: "anonymous" })).toEqual({ accountId: "anonymous" });
    expect(submitterAccountDecision({ ...base, requested: "acct-u1", loopback: true })).toEqual({ accountId: "acct-u1" });
  });

  it("bills a signed agent's owner, whether it names the owner or itself", () => {
    const signed = { ...base, signature: { agentId: "mac-1" }, ownerAccountId: "acct-u1" };
    expect(submitterAccountDecision({ ...signed, requested: "acct-u1" })).toEqual({ accountId: "acct-u1" });
    expect(submitterAccountDecision({ ...signed, requested: "mac-1" })).toEqual({ accountId: "acct-u1" });
  });

  it("refuses a signed agent naming another account", () => {
    const signed = { ...base, signature: { agentId: "mac-1" }, ownerAccountId: "acct-u1" };
    expect(submitterAccountDecision({ ...signed, requested: "acct-victim" })).toEqual({ status: 403, error: "submitter_account_mismatch" });
  });

  it("bills an unowned signed agent's own id", () => {
    expect(submitterAccountDecision({ ...base, signature: { agentId: "mac-1" }, requested: "mac-1" })).toEqual({ accountId: "mac-1" });
  });

  it("rejects a bad signature", () => {
    expect(submitterAccountDecision({ ...base, signature: "rejected", requested: "anonymous" })).toEqual({ status: 401, error: "invalid_signature" });
  });
});

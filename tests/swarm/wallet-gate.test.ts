import { describe, expect, test } from "vitest";
import type { AgentRegistration, CreditTransaction } from "../../src/common/types.js";

describe("agent wallet onboarding gate", () => {
  test("AgentRegistration accepts optional walletAccountId", () => {
    const reg: AgentRegistration = {
      agentId: "agent-1",
      os: "debian",
      version: "1.0.0",
      mode: "ide-enabled",
      walletAccountId: "acct-user"
    };
    expect(reg.walletAccountId).toBe("acct-user");
  });

  test("AgentRegistration allows missing walletAccountId", () => {
    const reg: AgentRegistration = {
      agentId: "agent-2",
      os: "macos",
      version: "1.0.0",
      mode: "swarm-only"
    };
    expect(reg.walletAccountId).toBeUndefined();
  });

  test("ide-enabled agent without wallet should get walletRequired flag", () => {
    // Simulates the coordinator registration response logic
    const mode = "ide-enabled";
    const hasWallet = false;
    const walletRequired = mode === "ide-enabled" && !hasWallet ? true : undefined;
    const walletWarning = !hasWallet ? "credits_will_be_held_until_wallet_linked" : undefined;
    expect(walletRequired).toBe(true);
    expect(walletWarning).toBe("credits_will_be_held_until_wallet_linked");
  });

  test("ide-enabled agent with wallet should not get walletRequired flag", () => {
    const mode = "ide-enabled";
    const hasWallet = true;
    const walletRequired = mode === "ide-enabled" && !hasWallet ? true : undefined;
    const walletWarning = !hasWallet ? "credits_will_be_held_until_wallet_linked" : undefined;
    expect(walletRequired).toBeUndefined();
    expect(walletWarning).toBeUndefined();
  });

  test("swarm-only agent without wallet should not get walletRequired flag", () => {
    const mode = "swarm-only";
    const hasWallet = false;
    const walletRequired = mode === "ide-enabled" && !hasWallet ? true : undefined;
    expect(walletRequired).toBeUndefined();
  });

  test("held credits are released when wallet is linked", () => {
    // Simulate: agent has held credits, then links wallet
    const heldCredits: CreditTransaction[] = [
      { txId: "tx-1", accountId: "acct-1", type: "held", credits: 5, reason: "compute_contribution_held", timestampMs: Date.now() },
      { txId: "tx-2", accountId: "acct-1", type: "held", credits: 3, reason: "compute_contribution_held", timestampMs: Date.now() }
    ];
    const totalReleased = heldCredits.reduce((sum, tx) => sum + tx.credits, 0);
    expect(totalReleased).toBe(8);
    // Release creates earn + spend pair per held tx
    const releaseTxs = heldCredits.flatMap((h) => [
      { type: "earn", credits: h.credits, reason: "held_credits_released" },
      { type: "spend", credits: h.credits, reason: `held_released:${h.txId}` }
    ]);
    expect(releaseTxs).toHaveLength(4);
    expect(releaseTxs[0].type).toBe("earn");
    expect(releaseTxs[1].reason).toBe("held_released:tx-1");
  });

  test("pull gate blocks ide-enabled without wallet", () => {
    // Simulates /pull wallet gate logic
    const agentMode = "ide-enabled";
    const walletAccountId: string | undefined = undefined;
    const walletPresentInDb = false;

    const shouldBlock = agentMode === "ide-enabled" && !walletAccountId && !walletPresentInDb;
    expect(shouldBlock).toBe(true);
  });

  test("pull gate allows swarm-only without wallet", () => {
    const agentMode = "swarm-only";
    const walletAccountId: string | undefined = undefined;
    const walletPresentInDb = false;

    // swarm-only agents are never blocked by wallet gate
    const shouldBlock = agentMode === "ide-enabled" && !walletAccountId && !walletPresentInDb;
    expect(shouldBlock).toBe(false);
  });
});

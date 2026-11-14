import { describe, expect, it } from "vitest";
import {
  anchorConfirmations,
  anchoringStatus,
  checkpointAnchorFinality,
  describeAnchor,
  resolveAnchoringMode
} from "../../src/economy/anchor-status.js";
import { statsFinalityState } from "../../src/ledger/stats-checkpoint.js";
import type { BitcoinAnchorRecord } from "../../src/common/types.js";

// #46: what the status endpoints say. Nothing is "anchored" without a real, confirmed transaction.

const CHECKPOINT = "ab".repeat(32);
const TXID = "cd".repeat(32);
const BLOCK = "00".repeat(28) + "aaaaaaaa";

const real = (over: Partial<BitcoinAnchorRecord> = {}): BitcoinAnchorRecord => ({
  anchorId: "a1",
  epochId: "stats:7",
  checkpointHash: CHECKPOINT,
  anchorNetwork: "signet",
  txRef: TXID,
  status: "pending",
  createdAtMs: 1_000,
  confirmations: 0,
  anchorProvider: "bitcoind",
  ...over
});
const anchoredReal = (confirmations = 6) =>
  real({ status: "anchored", confirmations, blockHash: BLOCK, blockHeight: 100, anchoredAtMs: 5_000 });
/** What the old simulation wrote: instantly "anchored", tx_ref is not a transaction. */
const legacy = (txRef = `anchor:signet:${CHECKPOINT.slice(0, 24)}`): BitcoinAnchorRecord => ({
  anchorId: "old",
  epochId: "stats:1",
  checkpointHash: CHECKPOINT,
  anchorNetwork: "signet",
  txRef,
  status: "anchored",
  anchoredAtMs: 1_000,
  createdAtMs: 1_000
});

describe("resolveAnchoringMode (#46)", () => {
  it("no provider means disabled, in every environment", () => {
    for (const NODE_ENV of [undefined, "development", "test", "production"]) {
      expect(resolveAnchoringMode({ NODE_ENV })).toEqual({ mode: "disabled", provider: null });
    }
    expect(resolveAnchoringMode({ BITCOIN_ANCHOR_PROVIDER: "  " })).toEqual({ mode: "disabled", provider: null });
  });

  it("the mock provider is simulated, only by name, and never in production", () => {
    expect(resolveAnchoringMode({ BITCOIN_ANCHOR_PROVIDER: "mock" })).toEqual({ mode: "simulated", provider: "mock" });
    expect(resolveAnchoringMode({ BITCOIN_ANCHOR_PROVIDER: "Mock", NODE_ENV: "production" })).toMatchObject({
      mode: "disabled",
      problem: expect.stringMatching(/^anchor_provider_mock/)
    });
  });

  it("a real provider is enabled only when it can work", () => {
    const proxy = { BITCOIN_ANCHOR_PROVIDER: "anchor-proxy", ANCHOR_PROXY_URL: "https://proxy", ANCHOR_PROXY_TOKEN: "t" };
    expect(resolveAnchoringMode(proxy)).toEqual({ mode: "enabled", provider: "anchor-proxy" });
    expect(resolveAnchoringMode({ ...proxy, NODE_ENV: "production" })).toEqual({ mode: "enabled", provider: "anchor-proxy" });
    expect(resolveAnchoringMode({ BITCOIN_ANCHOR_PROVIDER: "bitcoind", BITCOIND_RPC_URL: "http://n" })).toMatchObject({
      mode: "disabled",
      provider: "bitcoind",
      problem: expect.stringMatching(/^anchor_provider_missing_env/)
    });
    expect(resolveAnchoringMode({ BITCOIN_ANCHOR_PROVIDER: "blockstream" }).problem).toMatch(/^blockstream_cannot_anchor/);
    expect(resolveAnchoringMode({ BITCOIN_ANCHOR_PROVIDER: "bitcoin" }).problem).toMatch(/^unknown_anchor_provider/);
  });
});

describe("anchoringStatus (#46)", () => {
  const base = { storeAvailable: true, network: "signet" as const, requiredConfirmations: 6 };

  it("says anchoring is disabled when there is no provider", () => {
    expect(anchoringStatus({ ...base, mode: resolveAnchoringMode({}) })).toEqual({
      enabled: false,
      mode: "disabled",
      provider: null,
      network: "signet",
      requiredConfirmations: 6,
      detail: "anchoring_disabled: no BITCOIN_ANCHOR_PROVIDER is configured, so nothing is anchored on Bitcoin",
      tracker: undefined
    });
  });

  it("does not count the mock provider as anchoring", () => {
    const status = anchoringStatus({ ...base, mode: { mode: "simulated", provider: "mock" } });
    expect(status).toMatchObject({ enabled: false, mode: "simulated" });
    expect(status.detail).toMatch(/^anchoring_simulated/);
  });

  it("reports why a configured provider is not used", () => {
    const status = anchoringStatus({ ...base, mode: resolveAnchoringMode({ BITCOIN_ANCHOR_PROVIDER: "bitcoind" }) });
    expect(status).toMatchObject({ enabled: false, mode: "disabled", provider: "bitcoind" });
    expect(status.detail).toMatch(/^anchoring_disabled: anchor_provider_missing_env: bitcoind needs BITCOIND_RPC_URL/);
  });

  it("enabled with a real provider and a database; includes the poll loop state", () => {
    const tracker = { running: true, consecutiveFailures: 2, nextPollDelayMs: 60_000, lastError: "anchor_provider_unavailable" };
    const mode = { mode: "enabled" as const, provider: "anchor-proxy" };
    expect(anchoringStatus({ ...base, mode, tracker })).toMatchObject({ enabled: true, mode: "enabled", tracker });
    expect(anchoringStatus({ ...base, mode, tracker, storeAvailable: false })).toMatchObject({ enabled: false, mode: "disabled", tracker: undefined });
  });
});

describe("describeAnchor (#46)", () => {
  it.each([`anchor:signet:${CHECKPOINT.slice(0, 24)}`, `stats-anchor:bitcoin:${CHECKPOINT.slice(0, 24)}`])(
    "labels the legacy row %s as simulated instead of anchored",
    (txRef) => {
      const view = describeAnchor(legacy(txRef), 6);
      expect(view).toMatchObject({
        status: "simulated",
        simulated: true,
        simulatedReason: "legacy_fake_tx_ref",
        simulatedTxRef: txRef,
        confirmations: 0
      });
      expect(view.txRef).toBeUndefined();
      expect(view.anchoredAtMs).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain('"anchored"');
    }
  );

  it("labels mock-provider rows as simulated even though they look like confirmed transactions", () => {
    const view = describeAnchor({ ...anchoredReal(6), anchorProvider: "mock" }, 6);
    expect(view).toMatchObject({ status: "simulated", simulated: true, simulatedReason: "mock_provider", simulatedTxRef: TXID, confirmations: 0 });
    expect(view.txRef).toBeUndefined();
    expect(view.blockHash).toBeUndefined();
  });

  it("passes real rows through with their stored state", () => {
    expect(describeAnchor(real({ confirmations: 3, blockHash: BLOCK, blockHeight: 100 }), 6)).toMatchObject({
      status: "pending",
      simulated: false,
      txRef: TXID,
      confirmations: 3,
      requiredConfirmations: 6,
      blockHash: BLOCK,
      blockHeight: 100,
      network: "signet",
      provider: "bitcoind"
    });
    expect(describeAnchor(anchoredReal(8), 6)).toMatchObject({ status: "anchored", confirmations: 8, anchoredAtMs: 5_000, txRef: TXID });
    // Rows from before the provider column existed are real if they hold a txid.
    expect(describeAnchor({ ...anchoredReal(6), anchorProvider: undefined }, 6)).toMatchObject({ status: "anchored", simulated: false });
  });

  it("an in-flight or failed broadcast has no txid and no confirmations", () => {
    const inflight = describeAnchor(real({ status: "broadcasting", txRef: "broadcasting:1234" }), 6);
    expect(inflight).toMatchObject({ status: "broadcasting", simulated: false, confirmations: 0 });
    expect(inflight.txRef).toBeUndefined();
    expect(describeAnchor(real({ status: "failed", confirmations: 4 }), 6)).toMatchObject({ status: "failed", confirmations: 0, txRef: TXID });
    expect(anchorConfirmations(null)).toBe(0);
  });
});

describe("checkpointAnchorFinality (#46)", () => {
  const finality = (anchor: BitcoinAnchorRecord | null, minConfirmations = 1) =>
    checkpointAnchorFinality({ anchor, requiredConfirmations: 6, minConfirmations });

  it("a legacy or mock 'anchored' row is neither confirmed nor in progress", () => {
    for (const row of [legacy(), { ...anchoredReal(6), anchorProvider: "mock" }]) {
      expect(finality(row)).toMatchObject({ hardFinalized: false, anchorInProgress: false, anchor: { status: "simulated" } });
    }
    expect(finality(null)).toEqual({ hardFinalized: false, anchorInProgress: false, requiredConfirmations: 6, anchor: undefined });
  });

  it("a pending transaction is in progress, not confirmed, whatever STATS_ANCHOR_MIN_CONFIRMATIONS says", () => {
    for (const min of [0, 1]) {
      expect(finality(real({ confirmations: 5, blockHash: BLOCK }), min)).toMatchObject({ hardFinalized: false, anchorInProgress: true, requiredConfirmations: 6 });
    }
    expect(finality(real({ status: "broadcasting", txRef: "broadcasting:1" }))).toMatchObject({ hardFinalized: false, anchorInProgress: true });
    expect(finality(real({ status: "failed" }))).toMatchObject({ hardFinalized: false, anchorInProgress: false });
  });

  it("confirmed at the required depth; a higher minimum raises the bar", () => {
    expect(finality(anchoredReal(6))).toMatchObject({ hardFinalized: true, anchorInProgress: true, requiredConfirmations: 6 });
    expect(finality(anchoredReal(6), 12)).toMatchObject({ hardFinalized: false, requiredConfirmations: 12 });
    expect(finality(anchoredReal(12), 12)).toMatchObject({ hardFinalized: true });
  });

  it("drives the stats finality state", () => {
    const state = (anchor: BitcoinAnchorRecord | null, anchoringEnabled: boolean) => {
      const f = finality(anchor);
      return statsFinalityState({ hasCommit: true, anchoringEnabled, anchorExists: f.anchorInProgress, hardFinalized: f.hardFinalized });
    };
    // Production today: no provider. Legacy rows no longer read as an anchor on its way.
    expect(state(legacy(), false)).toBe("soft_finalized");
    expect(state(null, false)).toBe("soft_finalized");
    // Mock mode counts as "not anchoring".
    expect(state({ ...anchoredReal(6), anchorProvider: "mock" }, false)).toBe("soft_finalized");
    expect(state(null, true)).toBe("anchored_pending");
    expect(state(real({ confirmations: 1, blockHash: BLOCK }), true)).toBe("anchored_pending");
    expect(state(anchoredReal(6), true)).toBe("anchored_confirmed");
  });
});

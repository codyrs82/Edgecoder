import { describe, expect, test } from "vitest";
import {
  createBitcoinAnchorProviderFromEnv,
  encodeCheckpointForOpReturn,
  decodeOpReturnCheckpoint,
  MockBitcoinAnchorProvider,
  AnchorProxyClientProvider,
  anchorProviderProblem,
  ANCHORING_PROVIDERS,
  BlockstreamProvider
} from "../../src/economy/bitcoin-rpc.js";

describe("bitcoin anchor provider", () => {
  test("mock provider broadcasts and confirms", async () => {
    const provider = new MockBitcoinAnchorProvider();
    const dataHex = "4543" + "01" + "a".repeat(64); // EC + v1 + 32-byte hash
    const result = await provider.broadcastOpReturn(dataHex);
    expect(result.txid).toBeTruthy();
    expect(result.txid.length).toBe(64);
    const conf = await provider.getConfirmations(result.txid);
    expect(conf.confirmed).toBe(true);
    expect(conf.confirmations).toBeGreaterThanOrEqual(1);
  });

  test("factory returns mock provider by default", () => {
    delete process.env.BITCOIN_ANCHOR_PROVIDER;
    const provider = createBitcoinAnchorProviderFromEnv("testnet");
    expect(provider).toBeInstanceOf(MockBitcoinAnchorProvider);
  });

  test("encodeCheckpointForOpReturn produces valid 35-byte payload", () => {
    const hash = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const encoded = encodeCheckpointForOpReturn(hash);
    // 2 bytes "EC" + 1 byte version + 32 bytes hash = 35 bytes = 70 hex chars
    expect(encoded.length).toBe(70);
    expect(encoded.startsWith("4543")).toBe(true); // "EC" in hex
  });

  test("decodeOpReturnCheckpoint round-trips correctly", () => {
    const hash = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const encoded = encodeCheckpointForOpReturn(hash);
    const decoded = decodeOpReturnCheckpoint(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe(1);
    expect(decoded!.checkpointHash).toBe(hash);
  });

  test("decodeOpReturnCheckpoint rejects invalid prefix", () => {
    const bad = "ffff01" + "a".repeat(64);
    expect(decodeOpReturnCheckpoint(bad)).toBeNull();
  });

  test("encodeCheckpointForOpReturn rejects non-32-byte hash", () => {
    expect(() => encodeCheckpointForOpReturn("abcd")).toThrow("checkpoint_hash_must_be_32_bytes");
  });

  test("factory returns anchor-proxy provider when configured", () => {
    process.env.BITCOIN_ANCHOR_PROVIDER = "anchor-proxy";
    process.env.ANCHOR_PROXY_URL = "https://example.com";
    process.env.ANCHOR_PROXY_TOKEN = "test-token";
    const provider = createBitcoinAnchorProviderFromEnv("bitcoin");
    expect(provider).toBeInstanceOf(AnchorProxyClientProvider);
    delete process.env.BITCOIN_ANCHOR_PROVIDER;
    delete process.env.ANCHOR_PROXY_URL;
    delete process.env.ANCHOR_PROXY_TOKEN;
  });

  test("factory throws when anchor-proxy missing env", () => {
    process.env.BITCOIN_ANCHOR_PROVIDER = "anchor-proxy";
    delete process.env.ANCHOR_PROXY_URL;
    delete process.env.ANCHOR_PROXY_TOKEN;
    expect(() => createBitcoinAnchorProviderFromEnv("bitcoin")).toThrow("anchor_proxy_missing_env");
    delete process.env.BITCOIN_ANCHOR_PROVIDER;
  });

  test("mock provider sendToMany returns txid", async () => {
    const provider = new MockBitcoinAnchorProvider();
    const result = await provider.sendToMany([
      { address: "bc1qtest1", amountSats: 50000 },
      { address: "bc1qtest2", amountSats: 30000 }
    ]);
    expect(result.txid).toBeTruthy();
    expect(result.txid.length).toBe(64);
  });

  test("mock provider sendToMany rejects empty outputs", async () => {
    const provider = new MockBitcoinAnchorProvider();
    await expect(provider.sendToMany([])).rejects.toThrow("no_outputs");
  });

  describe("#102: blockstream is read-only, not an anchoring provider", () => {
    test.each(["blockstream", "Blockstream", " blockstream "])("factory rejects BITCOIN_ANCHOR_PROVIDER=%j", (value) => {
      process.env.BITCOIN_ANCHOR_PROVIDER = value;
      try {
        expect(() => createBitcoinAnchorProviderFromEnv("bitcoin")).toThrow("blockstream_cannot_anchor");
      } finally {
        delete process.env.BITCOIN_ANCHOR_PROVIDER;
      }
    });

    test.each([
      [{}, /anchor_provider_unset/],
      [{ BITCOIN_ANCHOR_PROVIDER: "  " }, /anchor_provider_unset/],
      [{ BITCOIN_ANCHOR_PROVIDER: "mock" }, /anchor_provider_mock/],
      [{ BITCOIN_ANCHOR_PROVIDER: "blockstream" }, /blockstream_cannot_anchor/],
      [{ BITCOIN_ANCHOR_PROVIDER: "bitcoin" }, /unknown_anchor_provider/],
      [{ BITCOIN_ANCHOR_PROVIDER: "anchor_proxy" }, /unknown_anchor_provider/],
      [{ BITCOIN_ANCHOR_PROVIDER: "bitcoind" }, /missing_env: bitcoind needs BITCOIND_RPC_URL, BITCOIND_RPC_USER, BITCOIND_RPC_PASSWORD/],
      [{ BITCOIN_ANCHOR_PROVIDER: "anchor-proxy", ANCHOR_PROXY_URL: "https://p.example.org" }, /missing_env: anchor-proxy needs ANCHOR_PROXY_TOKEN$/]
    ])("anchorProviderProblem(%j) is strict for production", (env, re) => {
      expect(anchorProviderProblem(env as NodeJS.ProcessEnv)).toMatch(re);
    });

    test("anchorProviderProblem passes only a fully configured real provider", () => {
      expect(ANCHORING_PROVIDERS).toEqual(["anchor-proxy", "bitcoind"]);
      expect(anchorProviderProblem({ BITCOIN_ANCHOR_PROVIDER: " Anchor-Proxy ", ANCHOR_PROXY_URL: "u", ANCHOR_PROXY_TOKEN: "t" })).toBeNull();
      expect(anchorProviderProblem({ BITCOIN_ANCHOR_PROVIDER: "bitcoind", BITCOIND_RPC_URL: "u", BITCOIND_RPC_USER: "a", BITCOIND_RPC_PASSWORD: "p" })).toBeNull();
    });

    test("the problem never echoes credential values", () => {
      const msg = anchorProviderProblem({ BITCOIN_ANCHOR_PROVIDER: "bitcoind", BITCOIND_RPC_URL: "u", BITCOIND_RPC_USER: "a", BITCOIND_RPC_PASSWORD: "" });
      expect(msg).toMatch(/BITCOIND_RPC_PASSWORD/);
      expect(msg).not.toMatch(/\bu\b|\ba\b/);
    });

    test("factory rejects typos in every environment, still allows mock/unset in dev", () => {
      process.env.BITCOIN_ANCHOR_PROVIDER = "bitcoin-d";
      try {
        expect(() => createBitcoinAnchorProviderFromEnv("testnet")).toThrow("unknown_anchor_provider");
        process.env.BITCOIN_ANCHOR_PROVIDER = "mock";
        expect(createBitcoinAnchorProviderFromEnv("testnet")).toBeInstanceOf(MockBitcoinAnchorProvider);
      } finally {
        delete process.env.BITCOIN_ANCHOR_PROVIDER;
      }
    });

    test("BlockstreamProvider still can't broadcast (why it's rejected)", async () => {
      await expect(new BlockstreamProvider("bitcoin").broadcastOpReturn("00")).rejects.toThrow("blockstream_broadcast_not_supported");
    });
  });
});

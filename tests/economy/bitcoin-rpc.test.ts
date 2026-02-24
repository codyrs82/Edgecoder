import { describe, expect, test } from "vitest";
import {
  createBitcoinAnchorProviderFromEnv,
  encodeCheckpointForOpReturn,
  decodeOpReturnCheckpoint,
  MockBitcoinAnchorProvider,
  AnchorProxyClientProvider
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
});

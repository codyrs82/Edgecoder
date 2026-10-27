import { afterEach, describe, expect, test, vi } from "vitest";
import { createLightningProviderFromEnv } from "../../src/economy/lightning.js";

function clearLightningEnv() {
  vi.stubEnv("LIGHTNING_PROVIDER", "");
  vi.stubEnv("LND_REST_URL", "");
  vi.stubEnv("LND_MACAROON_HEX", "");
  vi.stubEnv("CLN_REST_URL", "");
  vi.stubEnv("CLN_API_TOKEN", "");
  vi.stubEnv("ALLOW_MOCK_LIGHTNING", "");
}

describe("lightning provider adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("uses mock provider by default in test env", async () => {
    clearLightningEnv();
    vi.stubEnv("NODE_ENV", "test");
    const provider = createLightningProviderFromEnv();
    const invoice = await provider.createInvoice({
      amountSats: 1500,
      memo: "test",
      expiresInSeconds: 120
    });
    expect(invoice.invoiceRef.startsWith("mockln:")).toBe(true);
    const settlement = await provider.checkSettlement(invoice.invoiceRef);
    expect(settlement.settled).toBe(true);
  });

  test("production with LIGHTNING_PROVIDER unset throws lightning_provider_required", () => {
    clearLightningEnv();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createLightningProviderFromEnv()).toThrow(/lightning_provider_required/);
  });

  test("production with LIGHTNING_PROVIDER=mock throws", () => {
    clearLightningEnv();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIGHTNING_PROVIDER", "mock");
    vi.stubEnv("ALLOW_MOCK_LIGHTNING", "1");
    expect(() => createLightningProviderFromEnv()).toThrow(/lightning_provider_required/);
  });

  test("production with lnd but missing URL/macaroon throws lnd_provider_missing_env", () => {
    clearLightningEnv();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIGHTNING_PROVIDER", "lnd");
    expect(() => createLightningProviderFromEnv()).toThrow(/lnd_provider_missing_env/);
  });

  test("dev + mock + ALLOW_MOCK_LIGHTNING=1 returns mock provider", async () => {
    clearLightningEnv();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIGHTNING_PROVIDER", "mock");
    vi.stubEnv("ALLOW_MOCK_LIGHTNING", "1");
    const provider = createLightningProviderFromEnv();
    const invoice = await provider.createInvoice({ amountSats: 10, memo: "dev", expiresInSeconds: 60 });
    expect(invoice.invoiceRef.startsWith("mockln:")).toBe(true);
  });

  test("dev + mock without ALLOW_MOCK_LIGHTNING throws mock_lightning_disabled", () => {
    clearLightningEnv();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIGHTNING_PROVIDER", "mock");
    expect(() => createLightningProviderFromEnv()).toThrow(/mock_lightning_disabled/);
  });

  test("unknown provider throws unknown_lightning_provider", () => {
    clearLightningEnv();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIGHTNING_PROVIDER", "bogus");
    expect(() => createLightningProviderFromEnv()).toThrow(/unknown_lightning_provider:bogus/);
  });
});

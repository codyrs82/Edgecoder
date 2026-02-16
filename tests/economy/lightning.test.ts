import { describe, expect, test } from "vitest";
import { createLightningProviderFromEnv } from "../../src/economy/lightning.js";

describe("lightning provider adapter", () => {
  test("uses mock provider by default", async () => {
    delete process.env.LIGHTNING_PROVIDER;
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
});

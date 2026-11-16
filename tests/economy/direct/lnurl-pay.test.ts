import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { preimageProves, resolveLnurlPayInvoice } from "../../../src/economy/direct/lnurl-pay.js";
import { encodeTestBolt11 } from "../helpers/bolt11-encode.js";

const metadata = JSON.stringify([["text/plain", "Pay host1"], ["text/identifier", "host1@hosts.test"]]);
const mdHash = createHash("sha256").update(metadata).digest("hex");
const hash = "11".repeat(32);

function fetcher(opts: { invoiceAmount?: (a: number) => number; network?: "tbs" | "bc"; descHash?: string | null; meta?: Record<string, unknown> } = {}) {
  const urls: string[] = [];
  const f = async (url: string) => {
    urls.push(url);
    if (url.includes("/.well-known/lnurlp/")) return { tag: "payRequest", callback: "https://pay.hosts.test/cb/host1", minSendable: 1000, maxSendable: 1_000_000_000, metadata, ...opts.meta };
    const amount = Number(new URL(url).searchParams.get("amount"));
    const amt = opts.invoiceAmount ? opts.invoiceAmount(amount) : amount;
    const pr = encodeTestBolt11({ network: opts.network ?? "tbs", amountMsat: amt, paymentHashHex: hash, ...(opts.descHash === null ? { description: "faucet" } : { descriptionHashHex: opts.descHash ?? mdHash }) });
    return { pr, routes: [] };
  };
  return { f, urls };
}

describe("LNURL-pay resolution", () => {
  it("resolves a Lightning address to an invoice for exactly the amount", async () => {
    const { f, urls } = fetcher();
    const r = await resolveLnurlPayInvoice("host1@hosts.test", 200_000, { network: "signet", fetcher: f });
    expect(urls[0]).toBe("https://hosts.test/.well-known/lnurlp/host1");
    expect(urls[1]).toBe("https://pay.hosts.test/cb/host1?amount=200000");
    expect(r.decoded).toMatchObject({ amountMsat: 200_000, paymentHash: hash, network: "signet" });
    expect(r.callbackOrigin).toBe("https://pay.hosts.test");
  });

  it("refuses a wrong amount, network or description hash, and out-of-range amounts", async () => {
    await expect(resolveLnurlPayInvoice("host1@hosts.test", 200_000, { network: "signet", fetcher: fetcher({ invoiceAmount: (a) => a + 1000 }).f })).rejects.toThrow(/amount_mismatch/);
    await expect(resolveLnurlPayInvoice("host1@hosts.test", 200_000, { network: "signet", fetcher: fetcher({ network: "bc" }).f })).rejects.toThrow(/wrong_network/);
    await expect(resolveLnurlPayInvoice("host1@hosts.test", 200_000, { network: "signet", fetcher: fetcher({ descHash: "22".repeat(32) }).f })).rejects.toThrow(/description_hash/);
    await expect(resolveLnurlPayInvoice("host1@hosts.test", 500, { network: "signet", fetcher: fetcher().f })).rejects.toThrow(/below_min/);
    await expect(resolveLnurlPayInvoice("host1@hosts.test", 1000, { network: "signet", fetcher: fetcher({ meta: { tag: "withdrawRequest" } }).f })).rejects.toThrow(/not_pay_request/);
  });

  it("test-harness options work only off mainnet and only for local http", async () => {
    const { f } = fetcher({ descHash: null, meta: { callback: "http://127.0.0.1:9/cb" } });
    await expect(resolveLnurlPayInvoice("http://127.0.0.1:9/.well-known/lnurlp/h", 2000, { network: "signet", fetcher: f, devHttp: true, allowUncommittedDescription: true })).resolves.toBeTruthy();
    await expect(resolveLnurlPayInvoice("http://127.0.0.1:9/.well-known/lnurlp/h", 2000, { network: "signet", fetcher: f })).rejects.toThrow();
    await expect(resolveLnurlPayInvoice("h@x.test", 2000, { network: "bitcoin", fetcher: f, devHttp: true })).rejects.toThrow(/mainnet/);
    const remote = fetcher({ meta: { callback: "http://evil.test/cb" } });
    await expect(resolveLnurlPayInvoice("h@x.test", 2000, { network: "signet", fetcher: remote.f, devHttp: true })).rejects.toThrow(/not_pay_request/);
  });

  it("preimage proof", () => {
    const pre = "ab".repeat(32);
    expect(preimageProves(createHash("sha256").update(Buffer.from(pre, "hex")).digest("hex"), pre)).toBe(true);
    expect(preimageProves(hash, pre)).toBe(false);
  });
});

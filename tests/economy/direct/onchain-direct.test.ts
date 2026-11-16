import { describe, expect, it } from "vitest";
import { checkOnchainPayment, deriveChild, parseExtendedPubkey, receiveAddressFromXpub, type ChainSource, type ChainTx } from "../../../src/economy/direct/onchain-direct.js";

describe("xpub receive addresses", () => {
  it("BIP84 test vector: zpub → bc1qcr8te4kr… / bc1qnjg0jd8228…", () => {
    const zpub = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
    expect(receiveAddressFromXpub(zpub, 0, "bitcoin")).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(receiveAddressFromXpub(zpub, 1, "bitcoin")).toBe("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    expect(() => receiveAddressFromXpub(zpub, 0, "signet")).toThrow(/wrong_network/);
  });
  it("BIP32 test vector 1: M/0H → M/0H/1", () => {
    const k = parseExtendedPubkey("xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw");
    expect(Buffer.from(deriveChild(k, 1).publicKey).toString("hex")).toBe("03501e454bf00751f24b1b489aa925215d66af2234e3891c3b21a52bedb3cd711c");
  });
});

function chain(txs: ChainTx[], tip: number): ChainSource {
  return { getTx: async (id) => txs.find((t) => t.txid === id) ?? null, tipHeight: async () => tip };
}
const txid = "a".repeat(64);
const addr = "tb1qhostaddress000000000000000000000000000";

describe("txid + output check", () => {
  const tx: ChainTx = { txid, vout: [{ scriptpubkey_address: "tb1qchange", value: 5000 }, { scriptpubkey_address: addr, value: 100_000 }], status: { confirmed: true, block_height: 100 } };
  it("paid with enough confirmations", async () => {
    expect(await checkOnchainPayment(chain([tx], 102), { txid, address: addr, minSats: 100_000, minConfirmations: 3 })).toEqual({ status: "paid", txid, vout: 1, sats: 100_000, confirmations: 3 });
  });
  it("unconfirmed, underpaid, wrong address, unknown, reused", async () => {
    expect((await checkOnchainPayment(chain([tx], 100), { txid, address: addr, minSats: 1, minConfirmations: 3 })).status).toBe("unconfirmed");
    expect((await checkOnchainPayment(chain([tx], 200), { txid, address: addr, minSats: 100_001, minConfirmations: 1 })).status).toBe("underpaid");
    expect((await checkOnchainPayment(chain([tx], 200), { txid, address: "tb1qother", minSats: 1, minConfirmations: 1 })).status).toBe("no_matching_output");
    expect((await checkOnchainPayment(chain([], 200), { txid, address: addr, minSats: 1, minConfirmations: 1 })).status).toBe("not_found");
    expect((await checkOnchainPayment(chain([tx], 200), { txid, address: addr, minSats: 1, minConfirmations: 1, used: new Set([`${txid}:1`]) })).status).toBe("output_already_used");
  });
});

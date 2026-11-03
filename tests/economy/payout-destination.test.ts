import { describe, expect, it } from "vitest";
import { bech32, bech32m } from "@scure/base";
import { onchainAddressNetworks, validateLightningAddress, validatePayoutDestination } from "../../src/economy/payout-destination.js";

/** Segwit address for `hrp` with witness `version` and a `len`-byte program (bech32 for v0, bech32m for v1+). */
function segwit(hrp: string, version: number, len: number, coder = version === 0 ? bech32 : bech32m): string {
  const program = Uint8Array.from({ length: len }, (_, i) => (i * 7 + 3) & 0xff);
  return coder.encode(hrp, [version, ...bech32.toWords(program)], 90);
}

// BIP 173 / BIP 350 test vectors and well-known base58 addresses.
const MAIN_P2WPKH = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const MAIN_TAPROOT = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const TEST_P2WSH = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
const TEST_TAPROOT = "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c";
const MAIN_P2PKH = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const MAIN_P2SH = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const TEST_P2PKH = "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn";
const TEST_P2SH = "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc";

describe("on-chain address validation per network", () => {
  it("accepts mainnet bech32, bech32m and base58 on bitcoin", () => {
    for (const a of [MAIN_P2WPKH, MAIN_TAPROOT, MAIN_P2PKH, MAIN_P2SH, segwit("bc", 0, 32)]) {
      const v = validatePayoutDestination(a, "bitcoin");
      expect(v, a).toMatchObject({ ok: true, kind: "onchain", network: "bitcoin" });
    }
  });

  it("accepts tb1 and testnet base58 on testnet and signet", () => {
    for (const net of ["testnet", "signet"] as const) {
      for (const a of [TEST_P2WSH, TEST_TAPROOT, TEST_P2PKH, TEST_P2SH, segwit("tb", 0, 20)]) {
        expect(validatePayoutDestination(a, net), `${a} on ${net}`).toMatchObject({ ok: true, kind: "onchain", network: net });
      }
    }
  });

  it("accepts bcrt1 and testnet base58 on regtest", () => {
    for (const a of [segwit("bcrt", 0, 20), segwit("bcrt", 1, 32), TEST_P2PKH]) {
      expect(validatePayoutDestination(a, "regtest"), a).toMatchObject({ ok: true, kind: "onchain", network: "regtest" });
    }
  });

  it("rejects an address for another network with address_network_mismatch", () => {
    const cases: Array<[string, "bitcoin" | "testnet" | "signet" | "regtest"]> = [
      [MAIN_P2WPKH, "signet"],
      [MAIN_P2WPKH, "testnet"],
      [MAIN_P2PKH, "regtest"],
      [TEST_P2WSH, "bitcoin"],
      [TEST_P2PKH, "bitcoin"],
      [TEST_P2WSH, "regtest"],
      [segwit("bcrt", 0, 20), "signet"],
      [segwit("bcrt", 0, 20), "bitcoin"]
    ];
    for (const [a, net] of cases) {
      const v = validatePayoutDestination(a, net);
      expect(v, `${a} on ${net}`).toMatchObject({ ok: false, error: "address_network_mismatch" });
    }
  });

  it("rejects bad checksums, mixed case, wrong checksum variant and bad program lengths", () => {
    const typo = MAIN_P2WPKH.slice(0, -1) + (MAIN_P2WPKH.endsWith("4") ? "5" : "4");
    const mixed = "bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    const v1WithBech32 = segwit("bc", 1, 32, bech32);
    const v0WithBech32m = segwit("bc", 0, 20, bech32m);
    const v0BadLen = segwit("bc", 0, 25);
    const taprootBadLen = segwit("bc", 1, 20);
    const base58Typo = MAIN_P2PKH.slice(0, -1) + "3";
    for (const a of [typo, mixed, v1WithBech32, v0WithBech32m, v0BadLen, taprootBadLen, base58Typo, "bc1", "notanaddress", "0x52908400098527886E0F7030069857D2E4169EE7"]) {
      const v = validatePayoutDestination(a, "bitcoin");
      expect(v, a).toMatchObject({ ok: false, error: "invalid_onchain_address" });
    }
  });

  it("normalises an all-uppercase bech32 address to lower case", () => {
    const r = onchainAddressNetworks(MAIN_P2WPKH.toUpperCase());
    expect(r).toMatchObject({ ok: true, address: MAIN_P2WPKH, networks: ["bitcoin"] });
  });
});

describe("Lightning address validation", () => {
  it("accepts name@domain and lower-cases it", () => {
    expect(validatePayoutDestination("  Alice@WalletOfSatoshi.com ", "bitcoin")).toEqual({ ok: true, kind: "lightning_address", destination: "alice@walletofsatoshi.com", network: "bitcoin" });
    expect(validateLightningAddress("bob.smith+tips@pay.getalby.com")).toEqual({ ok: true, address: "bob.smith+tips@pay.getalby.com" });
    expect(validateLightningAddress("x@xn--80ak6aa92e.com").ok).toBe(true);
  });

  it("rejects malformed addresses and private or reserved hosts", () => {
    for (const a of ["@example.org", "alice@", "alice@com", "a b@wallet.com", "alice@@wallet.com", "alice@wallet..com", "alice@-wallet.com", "alice@192.168.1.10", "alice@localhost", "alice@printer.local", "alice@svc.internal", ".alice@wallet.com", "alice@wallet.c0m", `${"a".repeat(65)}@wallet.com`]) {
      const v = validatePayoutDestination(a, "bitcoin");
      expect(v, a).toMatchObject({ ok: false, error: "invalid_lightning_address" });
    }
  });

  it("explains invoices and LNURLs instead of accepting them", () => {
    expect(validatePayoutDestination("lnbc10u1pjexample", "bitcoin")).toMatchObject({ ok: false, error: "unsupported_destination" });
    expect(validatePayoutDestination("LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS", "bitcoin")).toMatchObject({ ok: false, error: "unsupported_destination" });
  });

  it("requires a destination", () => {
    expect(validatePayoutDestination("   ", "bitcoin")).toMatchObject({ ok: false, error: "destination_required" });
    expect(validatePayoutDestination(undefined, "bitcoin")).toMatchObject({ ok: false, error: "destination_required" });
  });
});

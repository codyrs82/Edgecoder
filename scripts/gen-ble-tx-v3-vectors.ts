// #63: regenerate tests/security/fixtures/ble-tx-v3-vectors.json, the BLE credit-transaction
// test vectors shared by vitest (tests/security/ble-tx-v3-vectors.test.ts) and the iOS Swift check
// (ios/EdgeCoderIOS/EdgeCoderIOSTests/BLETxV3VectorCheck.swift). Only regenerate when the canonical
// encoding changes on purpose, and then update both implementations.
//   npx tsx scripts/gen-ble-tx-v3-vectors.ts
import { createPrivateKey, createPublicKey } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BLE_TX_V3_DOMAIN, bleCreditMillis, bleTxV3CanonicalBytes, signBleTxV3 } from "../src/credits/ble-tx-v3.js";

const out = fileURLToPath(new URL("../tests/security/fixtures/ble-tx-v3-vectors.json", import.meta.url));
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
// RFC 8032 section 7.1, TEST 1. Public test key: never use it for anything real.
const seedHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const privateKey = createPrivateKey({ key: Buffer.from(PKCS8_ED25519_PREFIX + seedHex, "hex"), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey);
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const base = {
  txId: "0b6f3d1e-5a8e-4c1f-9f61-2d7c3e9a4b10",
  requesterId: "iphone-1A2B3C4D",
  requesterAccountId: "acct-requester-01",
  providerId: "mac-worker-7",
  providerAccountId: "acct-provider-02",
  taskHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
};

const cases = [
  { name: "basic", fields: { ...base, cpuMillis: 12345, creditMillis: 3704 } },
  { name: "one-milli", fields: { ...base, txId: "tx-one-milli", cpuMillis: 1, creditMillis: 1 } },
  { name: "zero-cpu", fields: { ...base, txId: "tx-zero-cpu", cpuMillis: 0, creditMillis: 1 } },
  { name: "unicode-and-empty", fields: { ...base, txId: "tx-ünïcødé-✓", requesterId: "agent-日本", providerAccountId: "", cpuMillis: 100000, creditMillis: 100000 } },
  { name: "large-integers", fields: { ...base, txId: "tx-large", cpuMillis: 9007199254740991, creditMillis: 1000000000000 } }
];

const invalid = [
  { name: "newline-in-txId", fields: { ...base, txId: "tx\nbad", cpuMillis: 1, creditMillis: 1 } },
  { name: "newline-in-providerAccountId", fields: { ...base, providerAccountId: "acct\n", cpuMillis: 1, creditMillis: 1 } },
  { name: "negative-creditMillis", fields: { ...base, cpuMillis: 1, creditMillis: -1 } },
  { name: "fractional-cpuMillis", fields: { ...base, cpuMillis: 1.5, creditMillis: 1 } }
];

const creditCases: Array<[number, number]> = [
  [12345, 0], [12345, 1.5], [12345, 3], [12345, 7], [1, 0], [5, 0], [15, 3], [999, 2], [0, 7], [3600000, 13]
];

const fixture = {
  description:
    "#63 BLE credit transaction v3: canonical bytes and Ed25519 signatures. Shared by vitest and the iOS Swift check; regenerate with scripts/gen-ble-tx-v3-vectors.ts.",
  domain: BLE_TX_V3_DOMAIN,
  key: {
    privateKeySeedHex: seedHex,
    publicKeyHex: (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string
  },
  vectors: cases.map((c) => ({
    name: c.name,
    fields: c.fields,
    canonicalHex: bleTxV3CanonicalBytes(c.fields).toString("hex"),
    signatureBase64: signBleTxV3(c.fields, privateKeyPem)
  })),
  invalid,
  creditMillis: creditCases.map(([cpuMillis, modelParamSize]) => ({ cpuMillis, modelParamSize, creditMillis: bleCreditMillis(cpuMillis, modelParamSize) }))
};

writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out}`);

import { describe, expect, test } from "vitest";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BLE_TX_V3_DOMAIN,
  BleTxFieldError,
  bleCreditMillis,
  bleTxV3CanonicalBytes,
  signBleTxV3,
  verifyBleTxV3,
  type BleTxV3Fields
} from "../../src/credits/ble-tx-v3.js";
import { applyBleSyncBatch, createInMemoryBleTransfer } from "../../src/credits/ble-sync.js";
import { CreditEngine } from "../../src/credits/engine.js";

// #63: shared with the iOS app (ios/EdgeCoderIOS/EdgeCoderIOSTests/BLETxV3VectorCheck.swift, run in CI
// with plain swiftc via ios/EdgeCoderIOS/Scripts/ble-tx-v3-vectors). Regenerate only when the encoding
// changes on purpose: npx tsx scripts/gen-ble-tx-v3-vectors.ts

interface Fixture {
  domain: string;
  key: { privateKeySeedHex: string; publicKeyHex: string; publicKeyPem: string };
  vectors: Array<{ name: string; fields: BleTxV3Fields; canonicalHex: string; signatureBase64: string }>;
  invalid: Array<{ name: string; fields: BleTxV3Fields }>;
  creditMillis: Array<{ cpuMillis: number; modelParamSize: number; creditMillis: number }>;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/ble-tx-v3-vectors.json", import.meta.url)), "utf8")
) as Fixture;

const privateKey = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + fixture.key.privateKeySeedHex, "hex"),
  format: "der",
  type: "pkcs8"
});
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

describe("BLE tx v3 shared vectors (#63)", () => {
  test("fixture key matches its seed", () => {
    const publicKey = createPublicKey(privateKey);
    expect(publicKey.export({ type: "spki", format: "pem" })).toBe(fixture.key.publicKeyPem);
    expect((publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex")).toBe(fixture.key.publicKeyHex);
    expect(fixture.domain).toBe(BLE_TX_V3_DOMAIN);
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const vector of fixture.vectors) {
    test(`${vector.name}: canonical bytes and deterministic signature match`, () => {
      const bytes = bleTxV3CanonicalBytes(vector.fields);
      expect(bytes.toString("hex")).toBe(vector.canonicalHex);
      // Layout: domain, six strings, two integers, "\n"-joined, no trailing newline.
      const text = bytes.toString("utf8");
      expect(text.split("\n")).toHaveLength(9);
      expect(text.endsWith("\n")).toBe(false);
      expect(signBleTxV3(vector.fields, privateKeyPem)).toBe(vector.signatureBase64);
      expect(verify(null, Buffer.from(vector.canonicalHex, "hex"), fixture.key.publicKeyPem, Buffer.from(vector.signatureBase64, "base64"))).toBe(true);
      expect(verifyBleTxV3(vector.fields, vector.signatureBase64, fixture.key.publicKeyPem)).toBe(true);
      for (const field of ["cpuMillis", "creditMillis"] as const) {
        const tampered = { ...vector.fields, [field]: vector.fields[field] + 1 };
        if (Number.isSafeInteger(tampered[field])) {
          expect(verifyBleTxV3(tampered, vector.signatureBase64, fixture.key.publicKeyPem)).toBe(false);
        }
      }
    });
  }

  for (const bad of fixture.invalid) {
    test(`${bad.name}: refused`, () => {
      expect(() => bleTxV3CanonicalBytes(bad.fields)).toThrow(BleTxFieldError);
    });
  }

  test("credit calculation table", () => {
    for (const row of fixture.creditMillis) {
      expect(bleCreditMillis(row.cpuMillis, row.modelParamSize), JSON.stringify(row)).toBe(row.creditMillis);
    }
  });

  test("the coordinator accepts a vector signed by both parties and rejects each 1-milli tamper", async () => {
    const vector = fixture.vectors.find((v) => v.name === "basic")!;
    const f = vector.fields;
    // The same test key stands in for both registered agents here.
    const tx = {
      txId: f.txId,
      requesterId: f.requesterId,
      providerId: f.providerId,
      requesterAccountId: f.requesterAccountId,
      providerAccountId: f.providerAccountId,
      credits: f.creditMillis / 1000,
      cpuSeconds: f.cpuMillis / 1000,
      taskHash: f.taskHash,
      timestamp: 0,
      requesterSignature: vector.signatureBase64,
      providerSignature: vector.signatureBase64
    };
    const accounts: Record<string, string> = { [f.requesterId]: f.requesterAccountId, [f.providerId]: f.providerAccountId };
    const run = async (t: typeof tx) => {
      const engine = new CreditEngine();
      engine.adjust(f.requesterAccountId, 100, "seed");
      return applyBleSyncBatch([t], {
        getPublicKeyPem: () => fixture.key.publicKeyPem,
        rewardAccountForAgent: async (id) => accounts[id] ?? id,
        transfer: createInMemoryBleTransfer(engine)
      });
    };
    expect((await run(tx)).applied).toEqual([f.txId]);
    for (const change of [{ credits: tx.credits + 0.001 }, { credits: tx.credits - 0.001 }, { cpuSeconds: tx.cpuSeconds + 0.001 }]) {
      expect((await run({ ...tx, ...change })).skipped[0]?.reason).toBe("invalid_signature");
    }
  });
});

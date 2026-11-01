import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  BLE_TX_V3_DOMAIN,
  bleTxV3CanonicalString,
  bleTxV3FieldsFromTx,
  encodeBleTxV3,
  signBleTxV3,
  toMillis,
  validateBleTxV3Fields,
  verifyBleTxV3,
  type BleTxV3Fields
} from "../../src/credits/ble-tx-canonical.js";

interface VectorFile {
  domain: string;
  key: { seedHex: string; publicKeyRawHex: string; publicKeyPem: string; privateKeyPem: string };
  vectors: Array<{
    name: string;
    tx: { txId: string; requesterId: string; requesterAccountId: string; providerId: string; providerAccountId: string; taskHash: string; cpuSeconds: number; credits: number };
    fields: BleTxV3Fields;
    canonicalUtf8: string;
    canonicalHex: string;
    signatureHex: string;
    signatureBase64: string;
  }>;
  invalid: Array<{ name: string; fields: BleTxV3Fields }>;
}

const file = JSON.parse(readFileSync(new URL("../vectors/ble-tx-v3.json", import.meta.url), "utf8")) as VectorFile;

describe("BLE tx v3 canonical bytes (#63 shared vectors)", () => {
  test("vector file is self-consistent (key seed matches PEMs)", () => {
    expect(file.domain).toBe(BLE_TX_V3_DOMAIN);
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(file.key.seedHex, "hex")]);
    const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    expect(priv.export({ format: "pem", type: "pkcs8" }).toString()).toBe(file.key.privateKeyPem);
    const pub = createPublicKey(priv);
    expect(pub.export({ format: "pem", type: "spki" }).toString()).toBe(file.key.publicKeyPem);
    expect((pub.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex")).toBe(file.key.publicKeyRawHex);
  });

  for (const v of file.vectors) {
    test(`vector '${v.name}': fields, bytes and signature match`, () => {
      expect(bleTxV3FieldsFromTx(v.tx)).toEqual(v.fields);
      const bytes = encodeBleTxV3(v.fields);
      expect(bytes.toString("hex")).toBe(v.canonicalHex);
      expect(bytes.toString("utf8")).toBe(v.canonicalUtf8);
      expect(bleTxV3CanonicalString(v.fields)).toBe(v.canonicalUtf8);
      // ed25519 is deterministic: signing the vector reproduces the checked-in signature.
      expect(signBleTxV3(v.fields, file.key.privateKeyPem)).toBe(v.signatureBase64);
      expect(Buffer.from(v.signatureBase64, "base64").toString("hex")).toBe(v.signatureHex);
      expect(verifyBleTxV3(v.fields, v.signatureBase64, file.key.publicKeyPem)).toBe(true);
      // Node's raw verify over the hex bytes agrees (no hidden re-encoding).
      expect(verify(null, Buffer.from(v.canonicalHex, "hex"), file.key.publicKeyPem, Buffer.from(v.signatureHex, "hex"))).toBe(true);
    });
  }

  for (const bad of file.invalid) {
    test(`invalid vector '${bad.name}' is rejected`, () => {
      expect(validateBleTxV3Fields(bad.fields)).not.toBeNull();
      expect(() => encodeBleTxV3(bad.fields)).toThrow();
      expect(verifyBleTxV3(bad.fields, file.vectors[0].signatureBase64, file.key.publicKeyPem)).toBe(false);
    });
  }

  test("format: domain prefix, newline-joined, no trailing newline, integer milli-units", () => {
    const s = bleTxV3CanonicalString(file.vectors[0].fields);
    const parts = s.split("\n");
    expect(parts).toHaveLength(9);
    expect(parts[0]).toBe("edgecoder-ble-tx-v3");
    expect(s.endsWith("\n")).toBe(false);
    expect(parts[7]).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(parts[8]).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(s).not.toContain("{");
  });

  test("toMillis rounds to integer milli-units and rejects bad amounts", () => {
    expect(toMillis(3.2)).toBe(3200);
    expect(toMillis(0)).toBe(0);
    expect(toMillis(0.0005)).toBe(1);
    expect(toMillis(1.0004)).toBe(1000);
    expect(() => toMillis(-1)).toThrow();
    expect(() => toMillis(Number.NaN)).toThrow();
    expect(() => toMillis(Number.POSITIVE_INFINITY)).toThrow();
  });

  test("any single-field change, including one milli-credit, breaks the signature", () => {
    const v = file.vectors[0];
    const sig = v.signatureBase64;
    const pem = file.key.publicKeyPem;
    expect(verifyBleTxV3(v.fields, sig, pem)).toBe(true);
    const mutations: Array<Partial<BleTxV3Fields>> = [
      { creditMillis: v.fields.creditMillis + 1 },
      { creditMillis: v.fields.creditMillis - 1 },
      { cpuMillis: v.fields.cpuMillis + 1 },
      { txId: v.fields.txId + "x" },
      { requesterId: "someone-else" },
      { requesterAccountId: "victim" },
      { providerId: "other-provider" },
      { providerAccountId: "other-account" },
      { taskHash: v.fields.taskHash.replace(/^./, "0") }
    ];
    for (const m of mutations) {
      expect(verifyBleTxV3({ ...v.fields, ...m }, sig, pem), JSON.stringify(m)).toBe(false);
    }
    // The float-to-milli projection is what is signed: 3.201 credits is one milli off,
    // while 3.2004 rounds to the same 3200 milli-credits.
    expect(verifyBleTxV3(bleTxV3FieldsFromTx({ ...v.tx, credits: 3.201 }), sig, pem)).toBe(false);
    expect(verifyBleTxV3(bleTxV3FieldsFromTx({ ...v.tx, credits: 3.199 }), sig, pem)).toBe(false);
    expect(verifyBleTxV3(bleTxV3FieldsFromTx({ ...v.tx, credits: 3.2004 }), sig, pem)).toBe(true);
  });

  test("wrong key, malformed and wrong-length signatures verify false without throwing", () => {
    const v = file.vectors[0];
    const other = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
      format: "der",
      type: "pkcs8"
    });
    const otherPem = createPublicKey(other).export({ format: "pem", type: "spki" }).toString();
    expect(verifyBleTxV3(v.fields, v.signatureBase64, otherPem)).toBe(false);
    expect(verifyBleTxV3(v.fields, "not-base64!!", file.key.publicKeyPem)).toBe(false);
    expect(verifyBleTxV3(v.fields, Buffer.alloc(10).toString("base64"), file.key.publicKeyPem)).toBe(false);
    expect(verifyBleTxV3(v.fields, v.signatureBase64, "garbage-pem")).toBe(false);
    const sigOtherKey = sign(null, encodeBleTxV3(v.fields), other).toString("base64");
    expect(verifyBleTxV3(v.fields, sigOtherKey, file.key.publicKeyPem)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { nip44ConversationKey, nip44Decrypt, nip44Encrypt, nip44PaddedLength, sharedX } from "../../../src/economy/direct/nip44.js";
import { nip04Decrypt, nip04Encrypt } from "../../../src/economy/direct/nip04.js";

const sk = (n: number) => {
  const b = new Uint8Array(32);
  b[31] = n;
  return b;
};
const pub = (n: number) => Buffer.from(schnorr.getPublicKey(sk(n))).toString("hex");

describe("NIP-44 v2 (official test vectors)", () => {
  it("conversation key for sec1=1, sec2=2", () => {
    expect(nip44ConversationKey(sk(1), pub(2)).toString("hex")).toBe("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    // symmetric
    expect(nip44ConversationKey(sk(2), pub(1)).toString("hex")).toBe("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
  });

  it("encrypts 'a' with nonce 0…01 to the published payload", () => {
    const ck = nip44ConversationKey(sk(1), pub(2));
    const nonce = Buffer.alloc(32);
    nonce[31] = 1;
    const payload = "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb";
    expect(nip44Encrypt("a", ck, nonce)).toBe(payload);
    expect(nip44Decrypt(payload, ck)).toBe("a");
  });

  it("pads to the spec's lengths", () => {
    expect([1, 32, 33, 37, 64, 65, 100, 256, 257, 383, 1025].map(nip44PaddedLength)).toEqual([32, 32, 64, 64, 64, 96, 128, 256, 320, 384, 1280]);
  });

  it("rejects a tampered payload (MAC)", () => {
    const ck = nip44ConversationKey(sk(3), pub(4));
    const p = Buffer.from(nip44Encrypt('{"method":"pay_invoice"}', ck), "base64");
    p[40] ^= 1;
    expect(() => nip44Decrypt(p.toString("base64"), ck)).toThrow(/mac/);
  });
});

describe("NIP-04", () => {
  it("ECDH x of 1·(2G) is the x-coordinate of 2G", () => {
    expect(sharedX(sk(1), pub(2)).toString("hex")).toBe("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
  });

  it("matches a vector cross-checked with `openssl enc -aes-256-cbc`", () => {
    const iv = Buffer.alloc(16, 7);
    const ct = "z0ZoM/JOyeNBYI4BbkCDZjdYALq7LBlPgioyX437wLU=?iv=BwcHBwcHBwcHBwcHBwcHBw==";
    expect(nip04Encrypt('{"method":"get_info"}', sk(1), pub(2), iv)).toBe(ct);
    expect(nip04Decrypt(ct, sk(2), pub(1))).toBe('{"method":"get_info"}');
  });
});

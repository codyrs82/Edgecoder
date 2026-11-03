#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Minisign-compatible Ed25519 signing for agent releases, with nothing but Node's crypto.
// The signatures it writes verify with the reference tool (`minisign -Vm SHA256SUMS -P <key>`)
// and with the verifier embedded in deploy/install.sh and deploy/install.ps1.
//
//   node scripts/release/minisign.mjs keygen                 JSON {publicKey, keyId, secretKeyPem} on stdout
//   node scripts/release/minisign.mjs sign FILE COMMENT      writes FILE.minisig; secret key PEM in
//                                                            the AGENT_RELEASE_SIGNING_KEY env var
//   node scripts/release/minisign.mjs pubkey                 public key of AGENT_RELEASE_SIGNING_KEY
//   node scripts/release/minisign.mjs verify FILE PUBKEY     exit 0 when FILE.minisig is valid
//
// Format (https://jedisct1.github.io/minisign/): the public key is base64("Ed" | keyId[8] | pk[32]);
// the signature file is
//   untrusted comment: <text>
//   base64("ED" | keyId[8] | Ed25519(BLAKE2b-512(file)))
//   trusted comment: <text>
//   base64(Ed25519(signature[64] | trusted comment))
// The trusted comment is signed too; releases put `tag:<tag>` in it so a signature cannot be
// replayed onto another release.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Raw 32-byte Ed25519 public key of a KeyObject. */
function rawPublicKey(key) {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32);
}

/** Minisign key id: the first 8 bytes of SHA-256(pk). Any 8 bytes are valid; this makes it stable. */
export function keyIdOf(pk) {
  return createHash("sha256").update(pk).digest().subarray(0, 8);
}

/** The id as `minisign` prints it (little-endian u64, upper-case hex). */
export function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

export function publicKeyString(secretKeyPem) {
  const pk = rawPublicKey(createPrivateKey(secretKeyPem));
  return Buffer.concat([Buffer.from("Ed"), keyIdOf(pk), pk]).toString("base64");
}

export function keygen() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const secretKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKey = publicKeyString(secretKeyPem);
  return { publicKey, keyId: keyIdHex(Buffer.from(publicKey, "base64").subarray(2, 10)), secretKeyPem };
}

/** The .minisig text for `data`, prehashed (algorithm "ED") as current minisign does by default. */
export function signMinisign(data, secretKeyPem, trustedComment) {
  if (/[\r\n]/.test(trustedComment)) throw new Error("trusted comment must be one line");
  const key = createPrivateKey(secretKeyPem);
  const keyId = keyIdOf(rawPublicKey(key));
  const sig = sign(null, createHash("blake2b512").update(data).digest(), key);
  const globalSig = sign(null, Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]), key);
  return [
    `untrusted comment: signature from EdgeCoder release key ${keyIdHex(keyId)}`,
    Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSig.toString("base64"),
    ""
  ].join("\n");
}

/** The trusted comment when `sigText` is a valid signature of `data` by `publicKey`; throws otherwise. */
export function verifyMinisign(data, sigText, publicKey) {
  const pk = Buffer.from(publicKey.trim(), "base64");
  if (pk.length !== 42 || pk.toString("latin1", 0, 2) !== "Ed") throw new Error("malformed public key");
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, pk.subarray(10)]), format: "der", type: "spki" });
  const lines = sigText.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) throw new Error("malformed signature file");
  const sig = Buffer.from(lines[1], "base64");
  if (sig.length !== 74 || sig.toString("latin1", 0, 2) !== "ED") throw new Error("unsupported signature algorithm");
  if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) throw new Error("signed by a different key");
  if (!verify(null, createHash("blake2b512").update(data).digest(), key, sig.subarray(10))) throw new Error("bad signature");
  const tc = lines[2].slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(tc, "utf8")]), key, Buffer.from(lines[3], "base64"))) {
    throw new Error("bad signature on the trusted comment");
  }
  return tc;
}

function secretFromEnv() {
  const pem = process.env.AGENT_RELEASE_SIGNING_KEY;
  if (!pem || !pem.includes("PRIVATE KEY")) {
    console.error("AGENT_RELEASE_SIGNING_KEY is not set (scripts/set-release-signing-key.sh sets it as a GitHub secret)");
    process.exit(1);
  }
  return pem;
}

function main(argv) {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case "keygen":
      process.stdout.write(JSON.stringify(keygen()) + "\n");
      return;
    case "pubkey":
      process.stdout.write(publicKeyString(secretFromEnv()) + "\n");
      return;
    case "sign": {
      if (!a || !b) throw new Error("usage: sign FILE TRUSTED_COMMENT");
      writeFileSync(`${a}.minisig`, signMinisign(readFileSync(a), secretFromEnv(), b));
      console.error(`signed ${a} -> ${a}.minisig (${b})`);
      return;
    }
    case "verify": {
      if (!a || !b) throw new Error("usage: verify FILE PUBKEY");
      const tc = verifyMinisign(readFileSync(a), readFileSync(`${a}.minisig`, "utf8"), b);
      console.log(`signature ok; trusted comment: ${tc}`);
      return;
    }
    default:
      throw new Error("usage: minisign.mjs keygen | pubkey | sign FILE COMMENT | verify FILE PUBKEY");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

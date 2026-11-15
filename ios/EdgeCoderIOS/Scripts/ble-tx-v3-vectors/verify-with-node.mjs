// #63: verify Swift-produced BLE tx v3 signatures with Node's crypto.verify, the primitive
// /credits/ble-sync uses (verifyBleTxV3 in src/credits/ble-tx-v3.ts). CryptoKit Ed25519 signatures
// are randomized, so they cannot equal the fixture bytes; this proves Node accepts them over the
// fixture's canonical bytes, and that the Swift canonical bytes equal the fixture's.
// Usage: node verify-with-node.mjs <fixture.json> <swift-signed.json>
import { verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [fixturePath, signedPath] = process.argv.slice(2);
if (!fixturePath || !signedPath) {
  console.error("usage: node verify-with-node.mjs <fixture.json> <swift-signed.json>");
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const signed = JSON.parse(readFileSync(signedPath, "utf8"));

let failed = false;
if (signed.length !== fixture.vectors.length) {
  console.log(`FAIL: ${signed.length} Swift signatures for ${fixture.vectors.length} vectors`);
  failed = true;
}
for (const vector of fixture.vectors) {
  const got = signed.find((entry) => entry.name === vector.name);
  const problems = [];
  if (!got) {
    problems.push("missing from Swift output");
  } else {
    if (got.canonicalHex !== vector.canonicalHex) problems.push("Swift canonical bytes differ from the fixture");
    const signature = Buffer.from(got.signatureBase64 ?? "", "base64");
    if (signature.length !== 64) problems.push(`signature is ${signature.length} bytes`);
    if (!verify(null, Buffer.from(vector.canonicalHex, "hex"), fixture.key.publicKeyPem, signature)) {
      problems.push("Node crypto.verify rejects the Swift signature");
    }
    // A one-milli change must not verify (last field is creditMillis).
    const text = Buffer.from(vector.canonicalHex, "hex").toString("utf8").split("\n");
    text[8] = String(Number(text[8]) + 1);
    if (verify(null, Buffer.from(text.join("\n"), "utf8"), fixture.key.publicKeyPem, signature)) {
      problems.push("Swift signature also verifies with creditMillis + 1");
    }
  }
  if (problems.length) {
    failed = true;
    console.log(`FAIL ${vector.name}: ${problems.join("; ")}`);
  } else {
    console.log(`ok   ${vector.name} (Node verifies the Swift signature)`);
  }
}
process.exit(failed ? 1 : 0);

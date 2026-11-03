// #64: verify Swift-produced request signatures with Node's crypto.verify, the same primitive the
// coordinator uses (verifySignedRequest in src/security/request-signing.ts). CryptoKit Ed25519
// signatures are randomized, so they cannot equal the fixture bytes; this proves Node accepts them.
// Usage: node verify-with-node.mjs <fixture.json> <swift-signed.json>
import { createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [fixturePath, signedPath] = process.argv.slice(2);
if (!fixturePath || !signedPath) {
  console.error("usage: node verify-with-node.mjs <fixture.json> <swift-signed.json>");
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const signed = JSON.parse(readFileSync(signedPath, "utf8"));
const h = fixture.headers;

let failed = false;
if (signed.length !== fixture.vectors.length) {
  console.log(`FAIL: ${signed.length} Swift header sets for ${fixture.vectors.length} vectors`);
  failed = true;
}
for (const vector of fixture.vectors) {
  const got = signed.find((entry) => entry.name === vector.name);
  const problems = [];
  if (!got) {
    problems.push("missing from Swift output");
  } else {
    const bodyHash = createHash("sha256").update(Buffer.from(vector.body, "utf8")).digest("hex");
    if (got[h.bodySha256] !== bodyHash) problems.push("x-body-sha256 does not match the body");
    if (got[h.agentId] !== vector.agentId) problems.push("x-agent-id differs");
    if (got[h.timestampMs] !== vector.timestampMs) problems.push("x-timestamp-ms differs");
    if (got[h.nonce] !== vector.nonce) problems.push("x-nonce differs");
    // Same canonical form as canonicalize() in src/security/request-signing.ts.
    const canonical = `${got[h.timestampMs]}\n${got[h.nonce]}\n${vector.method}\n${vector.path}\n${got[h.bodySha256]}`;
    if (canonical !== vector.expected.canonicalString) problems.push("canonical string differs");
    const signature = Buffer.from(got[h.signature] ?? "", "base64");
    if (signature.length !== 64) problems.push(`signature is ${signature.length} bytes`);
    if (!verify(null, Buffer.from(canonical, "utf8"), vector.publicKeyPem, signature)) {
      problems.push("Node crypto.verify rejects the Swift signature");
    }
  }
  if (problems.length) {
    failed = true;
    console.log(`FAIL ${vector.name}: ${problems.join("; ")}`);
  } else {
    console.log(`ok   ${vector.name} (Node verifies Swift signature)`);
  }
}
process.exit(failed ? 1 : 0);

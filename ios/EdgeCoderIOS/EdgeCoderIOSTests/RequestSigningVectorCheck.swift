import CryptoKit
import Foundation

/// Loads tests/security/fixtures/request-signing-vectors.json (shared with the vitest suite) and
/// checks that RequestSigner reproduces every vector: public key, PEM, body hash and canonical string
/// byte for byte, plus a signature that verifies under the vector's registered key (CryptoKit Ed25519
/// signatures are randomized, so their bytes cannot match Node's deterministic ones). No XCTest dependency so the same
/// check runs from RequestSigningVectorsTests (Xcode) and from Scripts/request-signing-vectors (CI,
/// plain swiftc on macOS).
struct RequestSigningVector: Decodable {
    struct Expected: Decodable {
        let canonicalString: String
        let bodySha256: String
        let signatureBase64: String
    }

    let name: String
    let privateKeySeedHex: String
    let publicKeyHex: String
    let publicKeyPem: String
    let agentId: String
    let method: String
    let path: String
    let timestampMs: String
    let nonce: String
    let body: String
    let expected: Expected
}

struct RequestSigningFixture: Decodable {
    let headers: [String: String]
    let vectors: [RequestSigningVector]
}

enum RequestSigningVectorCheck {
    /// Path of the shared fixture relative to this source file
    /// (repo root is four directories up from ios/EdgeCoderIOS/EdgeCoderIOSTests/<file>).
    static func defaultFixtureURL() -> URL {
        let thisFile = #filePath
        return URL(fileURLWithPath: thisFile)
            .deletingLastPathComponent() // EdgeCoderIOSTests
            .deletingLastPathComponent() // EdgeCoderIOS
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("tests/security/fixtures/request-signing-vectors.json")
    }

    static func loadFixture(at url: URL) throws -> RequestSigningFixture {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(RequestSigningFixture.self, from: data)
    }

    static func hexData(_ hex: String) -> Data? {
        let characters = Array(hex)
        guard characters.count % 2 == 0 else { return nil }
        var bytes = Data(capacity: characters.count / 2)
        var index = 0
        while index < characters.count {
            guard let byte = UInt8(String(characters[index...index + 1]), radix: 16) else { return nil }
            bytes.append(byte)
            index += 2
        }
        return bytes
    }

    /// Header names the coordinator reads; the fixture must agree with RequestSigner.
    static func headerFailures(_ headers: [String: String]) -> [String] {
        let expected = [
            "agentId": SignedRequestHeaders.agentIdField,
            "timestampMs": SignedRequestHeaders.timestampMsField,
            "nonce": SignedRequestHeaders.nonceField,
            "bodySha256": SignedRequestHeaders.bodySha256Field,
            "signature": SignedRequestHeaders.signatureField
        ]
        return expected.compactMap { key, value in
            headers[key] == value ? nil : "header \(key): fixture says \(headers[key] ?? "nil"), signer uses \(value)"
        }
    }

    /// Returns one message per mismatch; empty means the vector reproduces exactly.
    static func failures(for vector: RequestSigningVector) -> [String] {
        var failures: [String] = []

        guard let seed = hexData(vector.privateKeySeedHex), seed.count == 32 else {
            return ["privateKeySeedHex is not 32 bytes of hex"]
        }
        let privateKey: Curve25519.Signing.PrivateKey
        do {
            privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        } catch {
            return ["seed rejected by CryptoKit: \(error)"]
        }

        let publicHex = privateKey.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
        if publicHex != vector.publicKeyHex {
            failures.append("public key: got \(publicHex), expected \(vector.publicKeyHex)")
        }
        let pem = Ed25519PEM.publicKeyPEM(privateKey.publicKey)
        if pem != vector.publicKeyPem {
            failures.append("public key PEM differs from Node SPKI export")
        }

        let body = Data(vector.body.utf8)
        let bodySha256 = RequestSigner.sha256Hex(body)
        if bodySha256 != vector.expected.bodySha256 {
            failures.append("body sha256: got \(bodySha256), expected \(vector.expected.bodySha256)")
        }

        let canonical = RequestSigner.canonicalString(
            timestampMs: vector.timestampMs,
            nonce: vector.nonce,
            method: vector.method,
            path: vector.path,
            bodySha256: bodySha256
        )
        if canonical != vector.expected.canonicalString {
            failures.append("canonical string differs")
        }

        let headers: SignedRequestHeaders
        do {
            headers = try RequestSigner.sign(
                method: vector.method,
                path: vector.path,
                body: body,
                agentId: vector.agentId,
                privateKey: privateKey,
                timestampMs: vector.timestampMs,
                nonce: vector.nonce
            )
        } catch {
            return failures + ["signing threw: \(error)"]
        }
        // CryptoKit's Curve25519.Signing adds randomness to Ed25519 signatures (hedged signing), while
        // Node's are deterministic RFC 8032, so the signature bytes cannot equal the fixture. What the
        // coordinator checks is still enforced exactly: canonical padded base64 of 64 bytes that verifies,
        // under the vector's registered public key, over the exact expected canonical string and no other.
        failures += signatureFailures(headers.signature, vector: vector)
        if headers.bodySha256 != vector.expected.bodySha256 || headers.agentId != vector.agentId
            || headers.timestampMs != vector.timestampMs || headers.nonce != vector.nonce {
            failures.append("header values do not echo the inputs")
        }

        // The expected signature must verify under the registered public key, and a tampered body
        // must produce a different hash (so the coordinator's body-hash check rejects it).
        if let expectedSignature = Data(base64Encoded: vector.expected.signatureBase64) {
            if !privateKey.publicKey.isValidSignature(expectedSignature, for: Data(vector.expected.canonicalString.utf8)) {
                failures.append("expected signature does not verify with the derived public key")
            }
        } else {
            failures.append("expected signature is not valid base64")
        }
        let tampered = Data((vector.body + " ").utf8)
        if RequestSigner.sha256Hex(tampered) == bodySha256 {
            failures.append("tampered body produced the same hash")
        }

        return failures
    }

    /// Checks a Swift-produced signature the way the coordinator verifies it.
    static func signatureFailures(_ signatureBase64: String, vector: RequestSigningVector) -> [String] {
        guard let signature = Data(base64Encoded: signatureBase64) else {
            return ["signature is not valid base64: \(signatureBase64)"]
        }
        var failures: [String] = []
        if signature.count != 64 {
            failures.append("signature is \(signature.count) bytes, expected 64")
        }
        if signature.base64EncodedString() != signatureBase64 || signatureBase64.count != 88 {
            failures.append("signature is not canonical padded base64: \(signatureBase64)")
        }
        guard let publicRaw = hexData(vector.publicKeyHex),
              let registeredKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicRaw) else {
            return failures + ["publicKeyHex is not a valid Ed25519 public key"]
        }
        let canonical = Data(vector.expected.canonicalString.utf8)
        if !registeredKey.isValidSignature(signature, for: canonical) {
            failures.append("signature does not verify over the expected canonical string with the registered public key")
        }
        if registeredKey.isValidSignature(signature, for: Data((vector.expected.canonicalString + "x").utf8)) {
            failures.append("signature also verifies over a tampered canonical string")
        }
        return failures
    }
}

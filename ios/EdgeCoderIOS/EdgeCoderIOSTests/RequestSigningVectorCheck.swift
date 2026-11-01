import CryptoKit
import Foundation

/// Loads tests/security/fixtures/request-signing-vectors.json (shared with the vitest suite) and
/// checks that RequestSigner reproduces every vector byte for byte. No XCTest dependency so the same
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
        if headers.signature != vector.expected.signatureBase64 {
            failures.append("signature: got \(headers.signature), expected \(vector.expected.signatureBase64)")
        }
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
}

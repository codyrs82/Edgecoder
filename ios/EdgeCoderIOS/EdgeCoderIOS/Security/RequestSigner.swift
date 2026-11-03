import CryptoKit
import Foundation

/// Signed agent request headers understood by the coordinator (`verifyAgentRequest` in
/// src/swarm/coordinator.ts) for `/heartbeat`, `/pull`, `/result` and `/credits/ble-sync`.
///
/// This mirrors `signRequest` in src/security/request-signing.ts exactly:
///   canonical = "\(timestampMs)\n\(nonce)\n\(method)\n\(path)\n\(bodySha256Hex)"
///   signature = base64(Ed25519.sign(canonical as UTF-8))
/// `path` is the route path only (no host, no query string) and `bodySha256Hex` is the lowercase
/// hex SHA-256 of the exact bytes placed in `URLRequest.httpBody`.
/// Shared vectors: tests/security/fixtures/request-signing-vectors.json (#64).
struct SignedRequestHeaders: Equatable {
    static let agentIdField = "x-agent-id"
    static let timestampMsField = "x-timestamp-ms"
    static let nonceField = "x-nonce"
    static let bodySha256Field = "x-body-sha256"
    static let signatureField = "x-signature"

    let agentId: String
    let timestampMs: String
    let nonce: String
    let bodySha256: String
    let signature: String

    /// Header fields to copy onto the outgoing `URLRequest`.
    var headerFields: [String: String] {
        [
            Self.agentIdField: agentId,
            Self.timestampMsField: timestampMs,
            Self.nonceField: nonce,
            Self.bodySha256Field: bodySha256,
            Self.signatureField: signature
        ]
    }

    func apply(to request: inout URLRequest) {
        for (field, value) in headerFields {
            request.setValue(value, forHTTPHeaderField: field)
        }
    }
}

enum RequestSigner {
    /// Lowercase hex SHA-256 of `data`.
    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The exact string that is signed. Keep in sync with `canonicalize` in
    /// src/security/request-signing.ts.
    static func canonicalString(
        timestampMs: String,
        nonce: String,
        method: String,
        path: String,
        bodySha256: String
    ) -> String {
        "\(timestampMs)\n\(nonce)\n\(method)\n\(path)\n\(bodySha256)"
    }

    /// Sign a request. `body` must be the exact `Data` that is sent as the HTTP body.
    /// `timestampMs` / `nonce` are only overridden by tests; callers leave them nil.
    static func sign(
        method: String,
        path: String,
        body: Data,
        agentId: String,
        privateKey: Curve25519.Signing.PrivateKey,
        timestampMs: String? = nil,
        nonce: String? = nil
    ) throws -> SignedRequestHeaders {
        let resolvedTimestamp = timestampMs ?? String(Int64(Date().timeIntervalSince1970 * 1000))
        let resolvedNonce = nonce ?? UUID().uuidString.lowercased()
        let bodySha256 = sha256Hex(body)
        let canonical = canonicalString(
            timestampMs: resolvedTimestamp,
            nonce: resolvedNonce,
            method: method,
            path: path,
            bodySha256: bodySha256
        )
        let signature = try privateKey.signature(for: Data(canonical.utf8))
        return SignedRequestHeaders(
            agentId: agentId,
            timestampMs: resolvedTimestamp,
            nonce: resolvedNonce,
            bodySha256: bodySha256,
            signature: signature.base64EncodedString()
        )
    }
}

/// PEM encodings matching what Node's `KeyObject.export({ type: "spki", format: "pem" })` produces,
/// so the key sent in `/register` (`publicKeyPem`) verifies on the coordinator unchanged.
enum Ed25519PEM {
    /// SubjectPublicKeyInfo header for an Ed25519 key (RFC 8410): the 32 raw key bytes follow.
    private static let spkiPrefix: [UInt8] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
    ]

    static func publicKeyPEM(_ publicKey: Curve25519.Signing.PublicKey) -> String {
        var der = Data(spkiPrefix)
        der.append(publicKey.rawRepresentation)
        // 44 DER bytes -> 60 base64 characters, i.e. a single PEM line, exactly like Node.
        return "-----BEGIN PUBLIC KEY-----\n" + der.base64EncodedString() + "\n-----END PUBLIC KEY-----\n"
    }
}

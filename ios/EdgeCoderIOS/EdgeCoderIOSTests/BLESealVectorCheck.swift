import CryptoKit
import Foundation

/// Loads tests/security/fixtures/ble-seal-vectors.json (made by Node from src/mesh/ble/ble-seal.ts,
/// checked by vitest in tests/inference-api/bluetooth-failover.test.ts) and checks that `BLESeal`
/// in OfflineLedger.swift opens the Node-sealed request and seals the reply byte for byte. No XCTest
/// dependency, so it runs from Xcode (BLESealVectorsTests) and from Scripts/ble-seal-vectors (swiftc).
struct BLESealFixture: Decodable {
    let responderPrivateHex: String
    let responderPublicB64: String
    let senderPublicB64: String
    let requestId: String
    let requesterId: String
    let providerId: String
    let requestPlaintext: String
    let replyPlaintext: String
    let replyNonceB64: String
    let replyKeyHex: String
    let request: [String: AnyDecodable]
    let reply: [String: AnyDecodable]
}

/// Just enough of JSON for the fixture's message objects (strings and numbers).
struct AnyDecodable: Decodable {
    let value: Any
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s }
        else if let i = try? c.decode(Int.self) { value = NSNumber(value: i) }
        else if let d = try? c.decode(Double.self) { value = NSNumber(value: d) }
        else { value = NSNull() }
    }
}

enum BLESealVectorCheck {
    static func defaultFixtureURL(file: String = #filePath) -> URL {
        URL(fileURLWithPath: file)
            .deletingLastPathComponent() // EdgeCoderIOSTests
            .deletingLastPathComponent() // EdgeCoderIOS
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("tests/security/fixtures/ble-seal-vectors.json")
    }

    static func loadFixture(at url: URL) throws -> BLESealFixture {
        try JSONDecoder().decode(BLESealFixture.self, from: Data(contentsOf: url))
    }

    private static func hex(_ s: String) -> Data {
        var out = Data()
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    /// The failures (empty when every check passes).
    static func run(_ f: BLESealFixture) -> [String] {
        var failures: [String] = []
        guard let own = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(f.responderPrivateHex)) else { return ["responder key"] }
        if own.publicKey.rawRepresentation.base64EncodedString() != f.responderPublicB64 { failures.append("responder public key") }
        let request = f.request.mapValues { $0.value }
        let opened: BLESeal.OpenedRequest
        do {
            opened = try BLESeal.openRequest(request, own: own)
        } catch {
            return failures + ["open request: \(error)"]
        }
        if opened.plaintext != Data(f.requestPlaintext.utf8) { failures.append("request plaintext") }
        if opened.requestId != f.requestId || opened.requesterId != f.requesterId { failures.append("request ids") }
        if opened.senderKey.base64EncodedString() != f.senderPublicB64 { failures.append("sender key") }
        if opened.replyKey.withUnsafeBytes({ Data($0) }) != hex(f.replyKeyHex) { failures.append("reply key") }
        do {
            let sealed = try BLESeal.sealReply(replyKey: opened.replyKey, requestId: f.requestId, providerId: f.providerId, plaintext: Data(f.replyPlaintext.utf8), nonce: Data(base64Encoded: f.replyNonceB64))
            if sealed["ct"] as? String != f.reply["ct"]?.value as? String { failures.append("reply ciphertext") }
            if sealed["nonce"] as? String != f.reply["nonce"]?.value as? String { failures.append("reply nonce") }
        } catch {
            failures.append("seal reply: \(error)")
        }
        // A request sealed to another key is refused as a key mismatch; a tampered one as invalid.
        let other = Curve25519.KeyAgreement.PrivateKey()
        if (try? BLESeal.openRequest(request, own: other)) != nil { failures.append("opened with another key") }
        var tampered = request
        tampered["requesterId"] = "someone-else"
        do {
            _ = try BLESeal.openRequest(tampered, own: own)
            failures.append("opened a tampered request")
        } catch let e as BLESeal.SealError {
            if e != .invalid { failures.append("tampered request: \(e)") }
        } catch {
            failures.append("tampered request: \(error)")
        }
        return failures
    }
}

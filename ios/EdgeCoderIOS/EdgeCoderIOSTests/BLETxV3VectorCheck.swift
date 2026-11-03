import CryptoKit
import Foundation

/// #63: loads tests/security/fixtures/ble-tx-v3-vectors.json (shared with vitest,
/// tests/security/ble-tx-v3-vectors.test.ts) and checks that `BLETxV3` in OfflineLedger.swift
/// reproduces every vector: canonical bytes byte for byte, the fixture's (Node, deterministic)
/// signature verifies under the derived key, and a fresh CryptoKit signature verifies too (CryptoKit
/// Ed25519 is randomized, so its bytes cannot equal Node's; CI also verifies them with Node's
/// crypto.verify). No XCTest dependency, so the same check runs from BLETxV3VectorsTests (Xcode)
/// and from Scripts/ble-tx-v3-vectors (plain swiftc).
struct BLETxV3Fixture: Decodable {
    struct Key: Decodable {
        let privateKeySeedHex: String
        let publicKeyHex: String
        let publicKeyPem: String
    }

    struct Vector: Decodable {
        let name: String
        let fields: BLETxV3Fields
        let canonicalHex: String
        let signatureBase64: String
    }

    /// Invalid cases: decoded loosely, since some (fractional cpuMillis) are not valid Int64.
    struct Invalid: Decodable {
        let name: String
        let fields: [String: LooseValue]
    }

    struct CreditRow: Decodable {
        let cpuMillis: Int64
        let modelParamSize: Double
        let creditMillis: Int64
    }

    let domain: String
    let key: Key
    let vectors: [Vector]
    let invalid: [Invalid]
    let creditMillis: [CreditRow]
}

enum LooseValue: Decodable {
    case string(String)
    case number(Double)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .string(s) } else { self = .number(try c.decode(Double.self)) }
    }
}

struct SwiftSignedVector: Encodable {
    let name: String
    let canonicalHex: String
    let signatureBase64: String
}

enum BLETxV3VectorCheck {
    static func defaultFixtureURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // EdgeCoderIOSTests
            .deletingLastPathComponent() // EdgeCoderIOS
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("tests/security/fixtures/ble-tx-v3-vectors.json")
    }

    static func loadFixture(at url: URL) throws -> BLETxV3Fixture {
        try JSONDecoder().decode(BLETxV3Fixture.self, from: Data(contentsOf: url))
    }

    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    static func dataFromHex(_ hex: String) -> Data? {
        let chars = Array(hex)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data(capacity: chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let b = UInt8(String(chars[i...i + 1]), radix: 16) else { return nil }
            out.append(b)
            i += 2
        }
        return out
    }

    /// Runs every check; returns (failure messages, Swift signatures for Node to verify).
    static func run(_ fixture: BLETxV3Fixture) -> (failures: [String], signed: [SwiftSignedVector]) {
        var failures: [String] = []
        var signed: [SwiftSignedVector] = []
        if fixture.domain != BLETxV3.domain { failures.append("domain: fixture \(fixture.domain), Swift \(BLETxV3.domain)") }

        guard let seed = dataFromHex(fixture.key.privateKeySeedHex),
              let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else {
            return (failures + ["fixture seed is not a valid Ed25519 seed"], signed)
        }
        if hex(key.publicKey.rawRepresentation) != fixture.key.publicKeyHex {
            failures.append("public key derived from the seed differs from the fixture")
        }
        if fixture.vectors.count < 5 { failures.append("expected at least 5 vectors, got \(fixture.vectors.count)") }

        for v in fixture.vectors {
            let bytes: Data
            do {
                bytes = try BLETxV3.canonicalBytes(v.fields)
            } catch {
                failures.append("\(v.name): canonicalBytes threw \(error)")
                continue
            }
            if hex(bytes) != v.canonicalHex { failures.append("\(v.name): canonical bytes differ") }
            if let sig = Data(base64Encoded: v.signatureBase64) {
                if !key.publicKey.isValidSignature(sig, for: bytes) {
                    failures.append("\(v.name): fixture signature does not verify over the Swift bytes")
                }
            } else {
                failures.append("\(v.name): fixture signature is not base64")
            }
            if !BLETxV3.isValidSignature(v.signatureBase64, for: v.fields, publicKey: key.publicKey) {
                failures.append("\(v.name): isValidSignature rejects the fixture signature")
            }
            // A one-milli change in either amount must break the signature.
            let bumped = BLETxV3Fields(
                txId: v.fields.txId, requesterId: v.fields.requesterId, requesterAccountId: v.fields.requesterAccountId,
                providerId: v.fields.providerId, providerAccountId: v.fields.providerAccountId, taskHash: v.fields.taskHash,
                cpuMillis: v.fields.cpuMillis, creditMillis: v.fields.creditMillis + 1
            )
            if BLETxV3.isValidSignature(v.signatureBase64, for: bumped, publicKey: key.publicKey) {
                failures.append("\(v.name): signature still verifies with creditMillis + 1")
            }
            do {
                let mine = try BLETxV3.sign(v.fields, with: key)
                if !BLETxV3.isValidSignature(mine, for: v.fields, publicKey: key.publicKey) {
                    failures.append("\(v.name): Swift signature does not verify")
                }
                signed.append(SwiftSignedVector(name: v.name, canonicalHex: hex(bytes), signatureBase64: mine))
            } catch {
                failures.append("\(v.name): sign threw \(error)")
            }
        }

        for bad in fixture.invalid {
            func str(_ k: String) -> String? { if case .string(let s)? = bad.fields[k] { return s }; return nil }
            func num(_ k: String) -> Double? { if case .number(let d)? = bad.fields[k] { return d }; return nil }
            guard let cpu = num("cpuMillis"), let credit = num("creditMillis") else {
                failures.append("\(bad.name): malformed invalid case"); continue
            }
            // A fractional amount cannot even be represented as BLETxV3Fields (Int64): refused by type.
            guard cpu.rounded() == cpu, credit.rounded() == credit else { continue }
            let fields = BLETxV3Fields(
                txId: str("txId") ?? "", requesterId: str("requesterId") ?? "", requesterAccountId: str("requesterAccountId") ?? "",
                providerId: str("providerId") ?? "", providerAccountId: str("providerAccountId") ?? "", taskHash: str("taskHash") ?? "",
                cpuMillis: Int64(cpu), creditMillis: Int64(credit)
            )
            if (try? BLETxV3.canonicalBytes(fields)) != nil { failures.append("\(bad.name): accepted, expected an error") }
        }

        for row in fixture.creditMillis {
            let got = BLETxV3.creditMillis(cpuMillis: row.cpuMillis, modelParamSize: row.modelParamSize)
            if got != row.creditMillis {
                failures.append("creditMillis(\(row.cpuMillis), \(row.modelParamSize)): got \(got), expected \(row.creditMillis)")
            }
        }
        return (failures, signed)
    }
}

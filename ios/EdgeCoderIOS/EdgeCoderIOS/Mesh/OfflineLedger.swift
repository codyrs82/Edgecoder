// OfflineLedger.swift
// EdgeCoderIOS
//
// Persists BLE credit transactions to UserDefaults while the device is
// offline. Once connectivity is restored the pending batch can be exported
// and synced to the coordinator, after which entries are removed.
//
// #63: only transactions carrying BOTH the requester's and the provider's Ed25519
// signature over the canonical v3 bytes (`BLETxV3`) are recorded.

import CryptoKit
import Foundation

/// The fields both parties sign (#63). Mirrors `BleTxV3Fields` in src/credits/ble-tx-v3.ts.
struct BLETxV3Fields: Codable, Equatable {
    let txId: String
    let requesterId: String
    let requesterAccountId: String
    let providerId: String
    let providerAccountId: String
    let taskHash: String
    let cpuMillis: Int64
    let creditMillis: Int64
}

/// Canonical signed bytes for a BLE credit transaction, byte for byte the same as
/// `bleTxV3CanonicalBytes` in src/credits/ble-tx-v3.ts (pinned by
/// tests/security/fixtures/ble-tx-v3-vectors.json). No JSONEncoder, no float formatting:
///
///   UTF-8 of "edgecoder-ble-tx-v3" \n txId \n requesterId \n requesterAccountId \n providerId \n
///            providerAccountId \n taskHash \n cpuMillis \n creditMillis   (no trailing newline)
enum BLETxV3 {
    static let domain = "edgecoder-ble-tx-v3"

    enum FieldError: Error, Equatable {
        case containsNewline(String)
        case negative(String)
    }

    static func canonicalBytes(_ f: BLETxV3Fields) throws -> Data {
        let strings: [(String, String)] = [
            ("txId", f.txId),
            ("requesterId", f.requesterId),
            ("requesterAccountId", f.requesterAccountId),
            ("providerId", f.providerId),
            ("providerAccountId", f.providerAccountId),
            ("taskHash", f.taskHash)
        ]
        var parts = [domain]
        for (name, value) in strings {
            // Check the UTF-8 bytes, so a "\r\n" grapheme cannot slip a newline past a Character test.
            if value.utf8.contains(0x0A) { throw FieldError.containsNewline(name) }
            parts.append(value)
        }
        guard f.cpuMillis >= 0 else { throw FieldError.negative("cpuMillis") }
        guard f.creditMillis >= 0 else { throw FieldError.negative("creditMillis") }
        // String(Int64) of a non-negative value is plain base-10: no sign, no leading zeros, no exponent.
        parts.append(String(f.cpuMillis))
        parts.append(String(f.creditMillis))
        return Data(parts.joined(separator: "\n").utf8)
    }

    /// Base64 Ed25519 signature over the canonical bytes (the Keychain agent key signs this).
    static func sign(_ f: BLETxV3Fields, with key: Curve25519.Signing.PrivateKey) throws -> String {
        try key.signature(for: canonicalBytes(f)).base64EncodedString()
    }

    static func isValidSignature(_ signatureBase64: String, for f: BLETxV3Fields, publicKey: Curve25519.Signing.PublicKey) -> Bool {
        guard let signature = Data(base64Encoded: signatureBase64), let bytes = try? canonicalBytes(f) else { return false }
        return publicKey.isValidSignature(signature, for: bytes)
    }

    /// round(seconds * 1000), half away from zero (same as Math.round for non-negative values).
    static func millis(_ seconds: Double) -> Int64 {
        guard seconds.isFinite, seconds >= 0, seconds < 9_000_000_000_000 else { return -1 }
        return Int64((seconds * 1000).rounded())
    }

    /// Quality multiplier in tenths, mirroring modelQualityMultiplierTenths in TS.
    static func qualityMultiplierTenths(_ paramSize: Double) -> Int64 {
        if paramSize >= 7 { return 10 }
        if paramSize >= 3 { return 7 }
        if paramSize >= 1.5 { return 5 }
        return 3
    }

    /// cpuMillis x 1 credit/s x quality multiplier, integer arithmetic, rounded half up (bleCreditMillis in TS).
    static func creditMillis(cpuMillis: Int64, modelParamSize: Double) -> Int64 {
        (cpuMillis * qualityMultiplierTenths(modelParamSize) + 5) / 10
    }

    /// How far a requester's creditMillis may be from the provider's own calculation (bleCreditToleranceMillis).
    static func creditToleranceMillis(_ expected: Int64) -> Int64 {
        max(1, (expected + 99) / 100)
    }

    static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

struct BLECreditTransactionRecord: Codable {
    let txId: String
    let requesterId: String
    let providerId: String
    let requesterAccountId: String
    let providerAccountId: String
    let credits: Double
    let cpuSeconds: Double
    let taskHash: String
    let timestamp: Double
    let requesterSignature: String
    let providerSignature: String
}

extension BLECreditTransactionRecord {
    /// A fully co-signed transaction, in the wire shape /credits/ble-sync takes
    /// (credits = creditMillis / 1000, cpuSeconds = cpuMillis / 1000).
    init(fields f: BLETxV3Fields, requesterSignature: String, providerSignature: String, timestamp: Date = Date()) {
        self.init(
            txId: f.txId,
            requesterId: f.requesterId,
            providerId: f.providerId,
            requesterAccountId: f.requesterAccountId,
            providerAccountId: f.providerAccountId,
            credits: Double(f.creditMillis) / 1000,
            cpuSeconds: Double(f.cpuMillis) / 1000,
            taskHash: f.taskHash,
            timestamp: timestamp.timeIntervalSince1970 * 1000,
            requesterSignature: requesterSignature,
            providerSignature: providerSignature
        )
    }
}

final class OfflineLedger {
    static let shared = OfflineLedger()
    private static let storageKey = "edgecoder.offlineLedger"

    private var transactions: [String: BLECreditTransactionRecord] = [:]

    init() {
        load()
    }

    /// Record a co-signed transaction. Duplicate `txId` values and transactions missing either
    /// signature are ignored (#63); returns whether it was recorded.
    @discardableResult
    func record(_ tx: BLECreditTransactionRecord) -> Bool {
        guard !tx.requesterSignature.isEmpty, !tx.providerSignature.isEmpty else { return false }
        guard transactions[tx.txId] == nil else { return false }
        transactions[tx.txId] = tx
        save()
        return true
    }

    /// Returns all transactions that have not yet been synced.
    func pending() -> [BLECreditTransactionRecord] {
        Array(transactions.values)
    }

    /// Remove transactions that have been confirmed by the coordinator.
    func markSynced(_ txIds: [String]) {
        for id in txIds {
            transactions.removeValue(forKey: id)
        }
        save()
    }

    /// Which txIds to stop retrying after a /credits/ble-sync answer (settledBleTxIds in TS):
    /// applied and duplicate ones, plus those that can never settle (bad signature or field).
    /// Missing keys, insufficient balance and account mismatches stay pending.
    static func settledTxIds(fromSyncResponse response: [String: Any]) -> [String] {
        let applied = (response["applied"] as? [String]) ?? []
        let final: Set<String> = ["duplicate", "invalid_signature", "invalid_field"]
        let skipped = (response["skipped"] as? [[String: Any]]) ?? []
        let done = skipped.compactMap { entry -> String? in
            guard let id = entry["txId"] as? String, let reason = entry["reason"] as? String, final.contains(reason) else { return nil }
            return id
        }
        return applied + done
    }

    // MARK: - Persistence (UserDefaults)

    private func save() {
        if let data = try? JSONEncoder().encode(Array(transactions.values)) {
            UserDefaults.standard.set(data, forKey: Self.storageKey)
        }
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: Self.storageKey),
              let records = try? JSONDecoder().decode([BLECreditTransactionRecord].self, from: data) else { return }
        for record in records {
            transactions[record.txId] = record
        }
    }
}

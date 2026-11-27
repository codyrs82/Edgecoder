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

// MARK: - Sealed BLE requests (edgecoder-ble-seal/v1)

/// Sealed BLE requests: the responder side of src/mesh/ble/ble-seal.ts (same wire format, checked
/// against tests/security/fixtures/ble-seal-vectors.json by BLESealVectorCheck). A Mac seals a
/// prompt to this device's seal key, which the user pinned when allowing this device on the Mac, so
/// only this device can read it; the reply is sealed back so the Mac knows this device wrote it.
/// Kept in this file because it is built into both the app and the unit-test target.
///
///   ikm  = X25519(E, R) || X25519(S, R), salt = E.pub || S.pub || R.pub
///   kReq = HKDF-SHA256(ikm, salt, "edgecoder-ble-seal/v1 request", 32), kRep = "... reply"
///   AES-256-GCM, 12-byte nonce, ct = ciphertext || tag, aad "edgecoder-ble-seal/v1|<requestId>|<requesterId>"
///   and "edgecoder-ble-seal/v1 reply|<requestId>".
enum BLESeal {
    enum SealError: Error, Equatable {
        case malformed
        case keyMismatch
        case invalid
    }

    struct OpenedRequest {
        let requestId: String
        let requesterId: String
        /// The requester's static seal key (proven: the static-static term only opens with it).
        let senderKey: Data
        let plaintext: Data
        let task: String
        let issuedAtMs: Double
        let replyKey: SymmetricKey
    }

    /// This device's seal key, derived from its agent signing key so it stays the same across launches.
    static func sealKey(from signingKey: Curve25519.Signing.PrivateKey) -> Curve25519.KeyAgreement.PrivateKey {
        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: signingKey.rawRepresentation),
            salt: Data("edgecoder-ble-seal-key".utf8),
            info: Data("edgecoder-ble-seal-key/v1".utf8),
            outputByteCount: 32
        )
        let raw = derived.withUnsafeBytes { Data($0) }
        // 32 bytes is always a valid X25519 private key.
        return try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
    }

    private static func key(_ b64: Any?) -> Data? {
        guard let s = b64 as? String, let d = Data(base64Encoded: s), d.count == 32 else { return nil }
        return d
    }

    private static func keys(own: Curve25519.KeyAgreement.PrivateKey, epk: Data, spk: Data, rpk: Data) throws -> (req: SymmetricKey, rep: SymmetricKey) {
        let e = try own.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: epk))
        let s = try own.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: spk))
        var ikm = e.withUnsafeBytes { Data($0) }
        ikm.append(s.withUnsafeBytes { Data($0) })
        let salt = epk + spk + rpk
        let ikmKey = SymmetricKey(data: ikm)
        let req = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikmKey, salt: salt, info: Data("edgecoder-ble-seal/v1 request".utf8), outputByteCount: 32)
        let rep = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikmKey, salt: salt, info: Data("edgecoder-ble-seal/v1 reply".utf8), outputByteCount: 32)
        return (req, rep)
    }

    /// Open a `sealed_task` message with this device's seal key.
    static func openRequest(_ json: [String: Any], own: Curve25519.KeyAgreement.PrivateKey) throws -> OpenedRequest {
        guard json["type"] as? String == "sealed_task", (json["v"] as? NSNumber)?.intValue == 1,
              let requestId = json["requestId"] as? String, let requesterId = json["requesterId"] as? String,
              let epk = key(json["epk"]), let spk = key(json["spk"]), let rpk = key(json["rpk"]),
              let nonceB64 = json["nonce"] as? String, let nonce = Data(base64Encoded: nonceB64), nonce.count == 12,
              let ctB64 = json["ct"] as? String, let ct = Data(base64Encoded: ctB64), ct.count >= 16 else {
            throw SealError.malformed
        }
        guard rpk == own.publicKey.rawRepresentation else { throw SealError.keyMismatch }
        let plaintext: Data
        let k: (req: SymmetricKey, rep: SymmetricKey)
        do {
            k = try keys(own: own, epk: epk, spk: spk, rpk: rpk)
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.prefix(ct.count - 16), tag: ct.suffix(16))
            plaintext = try AES.GCM.open(box, using: k.req, authenticating: Data("edgecoder-ble-seal/v1|\(requestId)|\(requesterId)".utf8))
        } catch {
            throw SealError.invalid
        }
        guard let body = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              let task = body["task"] as? String, let issued = (body["issuedAtMs"] as? NSNumber)?.doubleValue, issued.isFinite else {
            throw SealError.malformed
        }
        return OpenedRequest(requestId: requestId, requesterId: requesterId, senderKey: spk, plaintext: plaintext, task: task, issuedAtMs: issued, replyKey: k.rep)
    }

    /// The sealed answer (`sealed_result`). `nonce` is for the shared test vectors only.
    static func sealReply(replyKey: SymmetricKey, requestId: String, providerId: String, plaintext: Data, nonce: Data? = nil) throws -> [String: Any] {
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: replyKey, nonce: n, authenticating: Data("edgecoder-ble-seal/v1 reply|\(requestId)".utf8))
        return [
            "type": "sealed_result",
            "v": 1,
            "requestId": requestId,
            "providerId": providerId,
            "nonce": n.withUnsafeBytes { Data($0) }.base64EncodedString(),
            "ct": (box.ciphertext + box.tag).base64EncodedString()
        ]
    }

    /// The reply body as JSON bytes (status, output, cpuSeconds).
    static func replyPlaintext(ok: Bool, output: String, cpuSeconds: Double) -> Data {
        let body: [String: Any] = ["status": ok ? "completed" : "failed", "output": output, "cpuSeconds": cpuSeconds]
        return (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{\"status\":\"failed\",\"output\":\"\",\"cpuSeconds\":0}".utf8)
    }
}

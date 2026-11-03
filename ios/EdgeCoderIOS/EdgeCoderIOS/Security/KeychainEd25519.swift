import CryptoKit
import Foundation
import Security

/// Persistent Ed25519 agent signing key, stored as its 32-byte seed in the Keychain.
///
/// The same key signs every coordinator request (RequestSigner) and is the key whose SPKI PEM the
/// app registers in `/register` (`publicKeyPem`), so the coordinator can verify the signatures.
/// `AfterFirstUnlockThisDeviceOnly` keeps it readable for background heartbeats and out of backups.
enum KeychainEd25519 {
    enum KeychainError: Error, LocalizedError {
        case unexpectedStatus(OSStatus)
        case corruptKey

        var errorDescription: String? {
            switch self {
            case .unexpectedStatus(let status):
                return "Keychain error \(status)."
            case .corruptKey:
                return "Stored signing key is not a valid Ed25519 seed."
            }
        }
    }

    private static let service = "io.edgecoder.ios.agent-signing-key"
    private static let account = "ed25519-seed"

    /// Returns the stored key, creating and persisting a new one on first use.
    static func loadOrCreate() throws -> Curve25519.Signing.PrivateKey {
        if let existing = try load() {
            return existing
        }
        let key = Curve25519.Signing.PrivateKey()
        try store(key)
        return key
    }

    static func load() throws -> Curve25519.Signing.PrivateKey? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
        guard let data = item as? Data else {
            throw KeychainError.corruptKey
        }
        do {
            return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
        } catch {
            throw KeychainError.corruptKey
        }
    }

    static func store(_ key: Curve25519.Signing.PrivateKey) throws {
        var attributes = baseQuery()
        attributes[kSecValueData as String] = key.rawRepresentation
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [kSecValueData as String: key.rawRepresentation]
            let updateStatus = SecItemUpdate(baseQuery() as CFDictionary, update as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(updateStatus)
            }
            return
        }
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    static func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}

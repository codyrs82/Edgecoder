// KeychainEd25519.swift
// EdgeCoderIOS
//
// Ed25519 key generation, Keychain storage, and PEM encoding
// compatible with Node.js crypto.verify() / crypto.sign().
// Uses CryptoKit Curve25519.Signing for native Ed25519 support.

import CryptoKit
import Foundation
import Security

enum KeychainEd25519Error: Error {
    case keychainWriteFailed(OSStatus)
    case keychainReadFailed
    case invalidKeyData
}

struct Ed25519KeyPair {
    let privateKey: Curve25519.Signing.PrivateKey
    let publicKey: Curve25519.Signing.PublicKey

    /// PEM-encoded PKCS8 private key (compatible with Node.js crypto).
    var privateKeyPem: String {
        // PKCS8 DER prefix for Ed25519 private keys:
        // SEQUENCE { SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING { 32 bytes } } }
        let pkcs8Prefix = Data([
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
            0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
        ])
        let der = pkcs8Prefix + privateKey.rawRepresentation
        return pemEncode(der: der, label: "PRIVATE KEY")
    }

    /// PEM-encoded SPKI public key (compatible with Node.js crypto).
    var publicKeyPem: String {
        // SPKI DER prefix for Ed25519 public keys:
        // SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING { 32 bytes } }
        let spkiPrefix = Data([
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
            0x70, 0x03, 0x21, 0x00
        ])
        let der = spkiPrefix + publicKey.rawRepresentation
        return pemEncode(der: der, label: "PUBLIC KEY")
    }

    /// Sign data and return base64-encoded signature.
    func sign(data: Data) throws -> String {
        let signature = try privateKey.signature(for: data)
        return signature.rawRepresentation.base64EncodedString()
    }

    /// Sign a string payload and return base64-encoded signature.
    func signPayload(_ payload: String) throws -> String {
        guard let data = payload.data(using: .utf8) else {
            throw KeychainEd25519Error.invalidKeyData
        }
        return try sign(data: data)
    }

    /// Verify a base64-encoded signature against data using a public key.
    static func verify(data: Data, signatureBase64: String, publicKey: Curve25519.Signing.PublicKey) -> Bool {
        guard let sigBytes = Data(base64Encoded: signatureBase64) else { return false }
        return publicKey.isValidSignature(sigBytes, for: data)
    }

    private func pemEncode(der: Data, label: String) -> String {
        let base64 = der.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
        return "-----BEGIN \(label)-----\n\(base64)\n-----END \(label)-----"
    }
}

enum KeychainEd25519 {
    private static let keychainService = "io.edgecoder.mesh.ed25519"

    /// Get or create an Ed25519 key pair for the given peer ID.
    /// Keys are persisted in the iOS Keychain across app launches.
    static func getOrCreateKeyPair(peerId: String) throws -> Ed25519KeyPair {
        // Try to load from Keychain first
        if let existing = try? loadFromKeychain(peerId: peerId) {
            return existing
        }
        // Generate new key pair
        let privateKey = Curve25519.Signing.PrivateKey()
        try saveToKeychain(peerId: peerId, privateKey: privateKey)
        return Ed25519KeyPair(privateKey: privateKey, publicKey: privateKey.publicKey)
    }

    /// Delete stored key pair for a peer ID.
    static func deleteKeyPair(peerId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: peerId,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Private

    private static func saveToKeychain(peerId: String, privateKey: Curve25519.Signing.PrivateKey) throws {
        let keyData = privateKey.rawRepresentation
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: peerId,
            kSecValueData as String: keyData,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        // Delete any existing entry
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainEd25519Error.keychainWriteFailed(status)
        }
    }

    private static func loadFromKeychain(peerId: String) throws -> Ed25519KeyPair {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: peerId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let keyData = item as? Data else {
            throw KeychainEd25519Error.keychainReadFailed
        }
        let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: keyData)
        return Ed25519KeyPair(privateKey: privateKey, publicKey: privateKey.publicKey)
    }
}

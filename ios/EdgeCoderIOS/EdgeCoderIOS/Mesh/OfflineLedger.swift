// OfflineLedger.swift
// EdgeCoderIOS
//
// Persists BLE credit transactions to UserDefaults while the device is
// offline. Once connectivity is restored the pending batch can be exported
// and synced to the coordinator, after which entries are removed.

import Foundation

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

final class OfflineLedger {
    static let shared = OfflineLedger()
    private static let storageKey = "edgecoder.offlineLedger"

    private var transactions: [String: BLECreditTransactionRecord] = [:]

    init() {
        load()
    }

    /// Record a new transaction. Duplicate `txId` values are silently ignored.
    func record(_ tx: BLECreditTransactionRecord) {
        guard transactions[tx.txId] == nil else { return }
        transactions[tx.txId] = tx
        save()
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

// BLEConstants.swift
// EdgeCoderIOS
//
// BLE mesh protocol constants matching the TypeScript implementation
// in src/mesh/ble/protocol.ts for cross-platform interoperability.

import CoreBluetooth

enum BLEMeshConstants {
    // MARK: - GATT Service & Characteristic UUIDs

    static let serviceUUID = CBUUID(string: "E0D6EC00-0001-4C3A-9B5E-00EDGEC0DE00")
    static let peerIdentityUUID = CBUUID(string: "E0D6EC00-0002-4C3A-9B5E-00EDGEC0DE00")
    static let capabilitiesUUID = CBUUID(string: "E0D6EC00-0003-4C3A-9B5E-00EDGEC0DE00")
    static let taskRequestUUID = CBUUID(string: "E0D6EC00-0004-4C3A-9B5E-00EDGEC0DE00")
    static let taskResponseUUID = CBUUID(string: "E0D6EC00-0005-4C3A-9B5E-00EDGEC0DE00")
    static let ledgerSyncUUID = CBUUID(string: "E0D6EC00-0006-4C3A-9B5E-00EDGEC0DE00")

    // MARK: - Transfer Parameters

    static let defaultMTU = 512
    static let chunkHeaderSize = 4
    static let evictionIntervalSeconds: TimeInterval = 60
    static let staleThresholdSeconds: TimeInterval = 30
    static let maxConnections = 5
    static let taskTimeoutSeconds: TimeInterval = 60
}

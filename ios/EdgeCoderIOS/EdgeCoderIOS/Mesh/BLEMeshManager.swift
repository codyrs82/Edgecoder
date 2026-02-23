// BLEMeshManager.swift
// EdgeCoderIOS
//
// CoreBluetooth-based mesh manager that handles scanning for nearby
// BLE peers, advertising this device's capabilities, and maintaining
// a live list of discovered peers with automatic stale-peer eviction.

import CoreBluetooth
import Foundation

struct BLEPeer {
    let agentId: String
    let model: String
    let modelParamSize: Double
    let memoryMB: Int
    let batteryPct: Int
    let currentLoad: Int
    let deviceType: String
    var rssi: Int
    var lastSeenAt: Date
}

@MainActor
final class BLEMeshManager: NSObject, ObservableObject {
    static let shared = BLEMeshManager()

    @Published var isScanning = false
    @Published var isAdvertising = false
    @Published var discoveredPeers: [BLEPeer] = []
    @Published var isOffline = false

    private var centralManager: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?

    override init() {
        super.init()
    }

    // MARK: - Lifecycle

    func start() {
        centralManager = CBCentralManager(delegate: nil, queue: nil)
        peripheralManager = CBPeripheralManager(delegate: nil, queue: nil)
    }

    func stop() {
        stopScanning()
        stopAdvertising()
        centralManager = nil
        peripheralManager = nil
    }

    // MARK: - Central (Scanning)

    func startScanning() {
        guard let central = centralManager, central.state == .poweredOn else { return }
        central.scanForPeripherals(withServices: [BLEMeshConstants.serviceUUID], options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: true
        ])
        isScanning = true
    }

    func stopScanning() {
        centralManager?.stopScan()
        isScanning = false
    }

    // MARK: - Peripheral (Advertising)

    func startAdvertising(agentId: String, model: String, modelParamSize: Double) {
        guard let peripheral = peripheralManager, peripheral.state == .poweredOn else { return }
        let service = CBMutableService(type: BLEMeshConstants.serviceUUID, primary: true)

        let identityData = try? JSONSerialization.data(withJSONObject: [
            "agentId": agentId,
            "model": model,
            "modelParamSize": modelParamSize
        ])

        let identityChar = CBMutableCharacteristic(
            type: BLEMeshConstants.peerIdentityUUID,
            properties: [.read],
            value: identityData,
            permissions: [.readable]
        )
        service.characteristics = [identityChar]
        peripheral.add(service)
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [BLEMeshConstants.serviceUUID],
            CBAdvertisementDataLocalNameKey: "EC-\(agentId.prefix(8))"
        ])
        isAdvertising = true
    }

    func stopAdvertising() {
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        isAdvertising = false
    }

    // MARK: - Peer Management

    func evictStalePeers() {
        let cutoff = Date().addingTimeInterval(-BLEMeshConstants.evictionIntervalSeconds)
        discoveredPeers.removeAll { $0.lastSeenAt < cutoff }
    }
}

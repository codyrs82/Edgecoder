// BLEMeshManager.swift
// EdgeCoderIOS
//
// CoreBluetooth-based mesh manager that handles scanning for nearby
// BLE peers, advertising this device's capabilities, and maintaining
// a live list of discovered peers with automatic stale-peer eviction.
// Supports bidirectional BLE task routing:
//   - Receives task requests via GATT writes, runs local inference, returns results via notify.
//   - Sends task requests to discovered peers (e.g. Mac) by writing to their GATT task char.

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

/// Closure type for handling incoming BLE task requests.
/// Takes a prompt string, returns (ok, output, durationMs).
typealias BLETaskHandler = @Sendable (String) async -> (ok: Bool, output: String, durationMs: Int)

@MainActor
final class BLEMeshManager: NSObject, ObservableObject {
    static let shared = BLEMeshManager()

    @Published var isScanning = false
    @Published var isAdvertising = false
    @Published var discoveredPeers: [BLEPeer] = []
    @Published var isOffline = false
    @Published var bleTasksReceived = 0
    @Published var bleTasksCompleted = 0
    @Published var bleTasksSent = 0
    @Published var lastBLETaskResult: String = ""

    private(set) var currentAgentId: String?
    private var currentModel: String = ""
    private var currentModelParamSize: Double = 0

    private var centralManager: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?
    private var connectedPeripherals: [CBPeripheral] = []

    /// Stored reference to the task response characteristic for sending notify updates
    private var taskResponseCharacteristic: CBMutableCharacteristic?

    /// Handler called when a remote peer writes a task request over BLE
    nonisolated(unsafe) var taskHandler: BLETaskHandler?

    // MARK: - Outbound Task Sending State

    /// Peripheral references keyed by agentId for reconnecting to send tasks
    private var peripheralsByAgentId: [String: CBPeripheral] = [:]

    /// Pending outbound task: continuation waiting for the response notify
    private var outboundTaskContinuation: CheckedContinuation<(ok: Bool, output: String), Never>?
    private var outboundTaskRequestId: String?

    /// Peripheral currently being used for an outbound task (to find its task chars)
    private var outboundPeripheral: CBPeripheral?

    override init() {
        super.init()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Lifecycle

    func start() {
        let bleQueue = DispatchQueue(label: "io.edgecoder.ble", qos: .utility)
        centralManager = CBCentralManager(delegate: self, queue: bleQueue)
        peripheralManager = CBPeripheralManager(delegate: self, queue: bleQueue)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleModelSwapStarted),
            name: .modelSwapStarted,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleModelDidChange(_:)),
            name: .modelDidChange,
            object: nil
        )
    }

    func stop() {
        stopScanning()
        stopAdvertising()
        for peripheral in connectedPeripherals {
            centralManager?.cancelPeripheralConnection(peripheral)
        }
        connectedPeripherals.removeAll()
        centralManager = nil
        peripheralManager = nil
    }

    // MARK: - Central (Scanning)

    func startScanning() {
        guard let central = centralManager, central.state == .poweredOn else {
            isScanning = true
            return
        }
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
        currentAgentId = agentId
        currentModel = model
        currentModelParamSize = modelParamSize
        guard let peripheral = peripheralManager, peripheral.state == .poweredOn else {
            isAdvertising = true
            return
        }
        setupAndAdvertise(peripheral: peripheral, agentId: agentId, model: model, modelParamSize: modelParamSize)
    }

    private func setupAndAdvertise(peripheral: CBPeripheralManager, agentId: String, model: String, modelParamSize: Double) {
        peripheral.removeAllServices()

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

        let capabilitiesChar = CBMutableCharacteristic(
            type: BLEMeshConstants.capabilitiesUUID,
            properties: [.read, .notify],
            value: nil,
            permissions: [.readable]
        )

        let taskRequestChar = CBMutableCharacteristic(
            type: BLEMeshConstants.taskRequestUUID,
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )

        let taskRespChar = CBMutableCharacteristic(
            type: BLEMeshConstants.taskResponseUUID,
            properties: [.notify],
            value: nil,
            permissions: [.readable]
        )
        taskResponseCharacteristic = taskRespChar

        service.characteristics = [identityChar, capabilitiesChar, taskRequestChar, taskRespChar]
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

    // MARK: - Model Change Handlers

    @objc private func handleModelSwapStarted() {
        stopAdvertising()
    }

    @objc private func handleModelDidChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let modelId = userInfo["modelId"] as? String,
              let paramSize = userInfo["paramSize"] as? Double else { return }
        stopAdvertising()
        if let agentId = currentAgentId {
            startAdvertising(agentId: agentId, model: modelId, modelParamSize: paramSize)
        }
    }

    // MARK: - Peer Management

    func evictStalePeers() {
        let cutoff = Date().addingTimeInterval(-BLEMeshConstants.evictionIntervalSeconds)
        discoveredPeers.removeAll { $0.lastSeenAt < cutoff }
    }

    private func parsePeerIdentity(data: Data, rssi: Int, peripheral: CBPeripheral?) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let agentId = json["agentId"] as? String else { return }

        let model = json["model"] as? String ?? ""
        let modelParamSize = json["modelParamSize"] as? Double ?? 0

        // Store peripheral reference for outbound task sending
        if let p = peripheral {
            peripheralsByAgentId[agentId] = p
        }

        if let idx = discoveredPeers.firstIndex(where: { $0.agentId == agentId }) {
            discoveredPeers[idx].rssi = rssi
            discoveredPeers[idx].lastSeenAt = Date()
        } else {
            discoveredPeers.append(BLEPeer(
                agentId: agentId,
                model: model,
                modelParamSize: modelParamSize,
                memoryMB: 0,
                batteryPct: 0,
                currentLoad: 0,
                deviceType: "laptop",
                rssi: rssi,
                lastSeenAt: Date()
            ))
            print("[BLE] discovered peer: \(agentId) (model: \(model), rssi: \(rssi))")
        }
    }

    // MARK: - Inbound BLE Task Handling (receive from Mac)

    private func handleIncomingTaskRequest(data: Data, central: CBCentral) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requestId = json["requestId"] as? String,
              let task = json["task"] as? String,
              let requesterId = json["requesterId"] as? String else {
            print("[BLE] malformed task request data")
            return
        }

        print("[BLE] received task request \(requestId) from \(requesterId): \(task.prefix(60))...")

        guard let handler = taskHandler else {
            print("[BLE] no task handler registered")
            return
        }

        bleTasksReceived += 1

        Task {
            let result = await handler(task)

            let response: [String: Any] = [
                "requestId": requestId,
                "providerId": currentAgentId ?? "unknown",
                "status": result.ok ? "completed" : "failed",
                "output": result.output,
                "cpuSeconds": Double(result.durationMs) / 1000.0,
                "providerSignature": ""
            ]

            guard let responseData = try? JSONSerialization.data(withJSONObject: response) else {
                print("[BLE] failed to serialize task response")
                return
            }

            guard let char = taskResponseCharacteristic, let pm = peripheralManager else {
                print("[BLE] no task response characteristic or peripheral manager")
                return
            }

            // Chunk the response: first notify = 4-byte big-endian length prefix + data,
            // subsequent notifies = continuation data. Receiver accumulates until full length.
            let totalLength = UInt32(responseData.count)
            let mtu = central.maximumUpdateValueLength
            let chunkDataSize = max(mtu - 4, 20) // leave room for 4-byte header in first chunk

            var header = Data(count: 4)
            header[0] = UInt8((totalLength >> 24) & 0xFF)
            header[1] = UInt8((totalLength >> 16) & 0xFF)
            header[2] = UInt8((totalLength >> 8) & 0xFF)
            header[3] = UInt8(totalLength & 0xFF)

            let firstEnd = min(chunkDataSize, responseData.count)
            var firstPacket = header
            firstPacket.append(responseData[0..<firstEnd])

            var sent = pm.updateValue(firstPacket, for: char, onSubscribedCentrals: [central])
            let totalChunks = max(1, (responseData.count + chunkDataSize - 1) / chunkDataSize)
            print("[BLE] task \(requestId) response chunk 1/\(totalChunks) (\(firstPacket.count) bytes, total: \(responseData.count), queued: \(sent))")

            var offset = firstEnd
            var chunkIdx = 2
            while offset < responseData.count {
                let end = min(offset + mtu, responseData.count)
                let chunk = responseData[offset..<end]
                sent = pm.updateValue(chunk, for: char, onSubscribedCentrals: [central])
                if !sent {
                    // Queue is full — wait briefly and retry
                    Thread.sleep(forTimeInterval: 0.05)
                    sent = pm.updateValue(chunk, for: char, onSubscribedCentrals: [central])
                }
                print("[BLE] task \(requestId) response chunk \(chunkIdx)/\(totalChunks) (\(chunk.count) bytes, queued: \(sent))")
                offset = end
                chunkIdx += 1
            }

            await MainActor.run {
                if result.ok { bleTasksCompleted += 1 }
            }
        }
    }

    // MARK: - Outbound BLE Task Sending (send to Mac)

    /// Stores the prompt for the current outbound task
    private var lastOutboundPrompt: String = ""

    /// Send a task to a discovered BLE peer. Connects, writes task request,
    /// subscribes to task response, waits for notify with result.
    func sendTask(toAgentId agentId: String, prompt: String, tag: String = "") async -> (ok: Bool, output: String) {
        lastOutboundPrompt = prompt
        guard let peripheral = peripheralsByAgentId[agentId] else {
            print("[BLE] sendTask: no peripheral for \(agentId)")
            return (false, "No peripheral found for \(agentId)")
        }
        guard let central = centralManager else {
            return (false, "No central manager")
        }

        let requestId = "ble-ios-\(tag)-\(Int(Date().timeIntervalSince1970 * 1000))"
        print("[BLE-TEST] sendTask: connecting to \(agentId) for task \(requestId)...")

        outboundPeripheral = peripheral
        outboundTaskRequestId = requestId
        bleTasksSent += 1

        peripheral.delegate = self
        central.connect(peripheral, options: nil)

        let result: (ok: Bool, output: String) = await withCheckedContinuation { continuation in
            outboundTaskContinuation = continuation

            Task {
                try? await Task.sleep(nanoseconds: 90_000_000_000)
                if let cont = await MainActor.run(body: { () -> CheckedContinuation<(ok: Bool, output: String), Never>? in
                    let c = self.outboundTaskContinuation
                    self.outboundTaskContinuation = nil
                    self.outboundTaskRequestId = nil
                    return c
                }) {
                    cont.resume(returning: (false, "BLE task timeout after 90s"))
                }
            }
        }

        lastBLETaskResult = result.output
        print("[BLE-TEST] task result from \(agentId): ok=\(result.ok), output=\(result.output.prefix(200))")
        return result
    }

    /// Called when task chars are discovered on the outbound peer: subscribe + write
    private func writeOutboundTask(peripheral: CBPeripheral, taskReqChar: CBCharacteristic, taskRespChar: CBCharacteristic) {
        // Subscribe to response notify first
        peripheral.setNotifyValue(true, for: taskRespChar)

        guard let requestId = outboundTaskRequestId else { return }
        let request: [String: Any] = [
            "requestId": requestId,
            "requesterId": currentAgentId ?? "unknown",
            "task": lastOutboundPrompt,
            "language": "python",
            "requesterSignature": ""
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: request) else {
            print("[BLE] failed to serialize outbound task request")
            return
        }

        print("[BLE] writing task to \(peripheral.name ?? "peer") (\(data.count) bytes)...")
        peripheral.writeValue(data, for: taskReqChar, type: .withResponse)
    }

    // MARK: - Outbound Response Reassembly (chunked BLE protocol)

    /// Expected total payload length from the 4-byte header
    private var outboundResponseExpectedLength: Int = -1
    /// Accumulated response data chunks
    private var outboundResponseChunks: [Data] = []
    /// Total bytes received so far
    private var outboundResponseReceivedBytes: Int = 0

    /// Handle task response notify from peer (outbound task completion).
    /// Supports chunked responses: first notify has 4-byte big-endian length prefix.
    private func handleOutboundTaskResponse(data: Data) {
        if outboundResponseExpectedLength < 0 {
            // First chunk: read 4-byte length header
            guard data.count >= 4 else {
                print("[BLE] outbound response too short for header (\(data.count) bytes)")
                return
            }
            let len = Int(data[0]) << 24 | Int(data[1]) << 16 | Int(data[2]) << 8 | Int(data[3])
            outboundResponseExpectedLength = len
            let payload = data.subdata(in: 4..<data.count)
            outboundResponseChunks.append(payload)
            outboundResponseReceivedBytes = payload.count
            print("[BLE] outbound response chunk 1: \(payload.count) bytes (expecting \(len) total)")
        } else {
            // Continuation chunk
            outboundResponseChunks.append(data)
            outboundResponseReceivedBytes += data.count
            print("[BLE] outbound response chunk +\(data.count) bytes (\(outboundResponseReceivedBytes)/\(outboundResponseExpectedLength))")
        }

        guard outboundResponseReceivedBytes >= outboundResponseExpectedLength else { return }

        // Full response received — reassemble and parse
        var fullData = Data()
        for chunk in outboundResponseChunks { fullData.append(chunk) }
        outboundResponseExpectedLength = -1
        outboundResponseChunks = []
        outboundResponseReceivedBytes = 0

        guard let json = try? JSONSerialization.jsonObject(with: fullData) as? [String: Any] else {
            print("[BLE] malformed task response (\(fullData.count) bytes)")
            return
        }

        let status = json["status"] as? String ?? "failed"
        let output = json["output"] as? String ?? ""
        let ok = status == "completed"

        print("[BLE] outbound task response: status=\(status), output=\(output.prefix(100))...")

        if let continuation = outboundTaskContinuation {
            outboundTaskContinuation = nil
            outboundTaskRequestId = nil
            continuation.resume(returning: (ok, output))
        }

        // Disconnect from the peer
        if let p = outboundPeripheral {
            centralManager?.cancelPeripheralConnection(p)
            outboundPeripheral = nil
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension BLEMeshManager: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor in
            switch central.state {
            case .poweredOn:
                if isScanning {
                    central.scanForPeripherals(withServices: [BLEMeshConstants.serviceUUID], options: [
                        CBCentralManagerScanOptionAllowDuplicatesKey: true
                    ])
                }
            case .poweredOff, .unauthorized, .unsupported:
                isScanning = false
                isAdvertising = false
            default:
                break
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager,
                                     didDiscover peripheral: CBPeripheral,
                                     advertisementData: [String: Any],
                                     rssi RSSI: NSNumber) {
        Task { @MainActor in
            guard !connectedPeripherals.contains(where: { $0.identifier == peripheral.identifier }) else { return }
            guard connectedPeripherals.count < BLEMeshConstants.maxConnections else { return }
            connectedPeripherals.append(peripheral)
            central.connect(peripheral, options: nil)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager,
                                     didConnect peripheral: CBPeripheral) {
        Task { @MainActor in
            peripheral.delegate = self

            // If this is an outbound task connection, discover all chars including task chars
            if peripheral.identifier == outboundPeripheral?.identifier {
                peripheral.discoverServices([BLEMeshConstants.serviceUUID])
            } else {
                peripheral.discoverServices([BLEMeshConstants.serviceUUID])
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager,
                                     didFailToConnect peripheral: CBPeripheral,
                                     error: Error?) {
        Task { @MainActor in
            connectedPeripherals.removeAll { $0.identifier == peripheral.identifier }
            if peripheral.identifier == outboundPeripheral?.identifier {
                if let cont = outboundTaskContinuation {
                    outboundTaskContinuation = nil
                    cont.resume(returning: (false, "BLE connect failed: \(error?.localizedDescription ?? "unknown")"))
                }
                outboundPeripheral = nil
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager,
                                     didDisconnectPeripheral peripheral: CBPeripheral,
                                     error: Error?) {
        Task { @MainActor in
            connectedPeripherals.removeAll { $0.identifier == peripheral.identifier }
        }
    }
}

// MARK: - CBPeripheralManagerDelegate

extension BLEMeshManager: CBPeripheralManagerDelegate {
    nonisolated func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        Task { @MainActor in
            if peripheral.state == .poweredOn {
                if isAdvertising, let agentId = currentAgentId {
                    setupAndAdvertise(
                        peripheral: peripheral,
                        agentId: agentId,
                        model: currentModel,
                        modelParamSize: currentModelParamSize
                    )
                }
            }
        }
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager,
                                        didAdd service: CBService,
                                        error: Error?) {
        if let error = error {
            print("[BLE] Failed to add service: \(error.localizedDescription)")
        }
    }

    nonisolated func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager,
                                                           error: Error?) {
        Task { @MainActor in
            if let error = error {
                print("[BLE] Advertising failed: \(error.localizedDescription)")
                isAdvertising = false
            }
        }
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager,
                                        didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            if request.characteristic.uuid == BLEMeshConstants.taskRequestUUID,
               let data = request.value {
                peripheral.respond(to: request, withResult: .success)
                let central = request.central
                Task { @MainActor in
                    handleIncomingTaskRequest(data: data, central: central)
                }
            } else {
                peripheral.respond(to: request, withResult: .requestNotSupported)
            }
        }
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager,
                                        central: CBCentral,
                                        didSubscribeTo characteristic: CBCharacteristic) {
        print("[BLE] central subscribed to \(characteristic.uuid)")
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager,
                                        central: CBCentral,
                                        didUnsubscribeFrom characteristic: CBCharacteristic) {
        print("[BLE] central unsubscribed from \(characteristic.uuid)")
    }
}

// MARK: - CBPeripheralDelegate

extension BLEMeshManager: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral,
                                 didDiscoverServices error: Error?) {
        guard let services = peripheral.services else { return }
        Task { @MainActor in
            let isOutbound = peripheral.identifier == outboundPeripheral?.identifier
            for service in services where service.uuid == BLEMeshConstants.serviceUUID {
                if isOutbound {
                    // Discover ALL characteristics including task request/response
                    peripheral.discoverCharacteristics(
                        [BLEMeshConstants.peerIdentityUUID,
                         BLEMeshConstants.capabilitiesUUID,
                         BLEMeshConstants.taskRequestUUID,
                         BLEMeshConstants.taskResponseUUID],
                        for: service
                    )
                } else {
                    // Normal discovery: identity + capabilities only
                    peripheral.discoverCharacteristics(
                        [BLEMeshConstants.peerIdentityUUID, BLEMeshConstants.capabilitiesUUID],
                        for: service
                    )
                }
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral,
                                 didDiscoverCharacteristicsFor service: CBService,
                                 error: Error?) {
        guard let characteristics = service.characteristics else { return }
        Task { @MainActor in
            let isOutbound = peripheral.identifier == outboundPeripheral?.identifier
            var taskReqChar: CBCharacteristic?
            var taskRespChar: CBCharacteristic?

            for char in characteristics {
                if char.uuid == BLEMeshConstants.peerIdentityUUID {
                    peripheral.readValue(for: char)
                }
                if char.uuid == BLEMeshConstants.capabilitiesUUID {
                    peripheral.setNotifyValue(true, for: char)
                }
                if char.uuid == BLEMeshConstants.taskRequestUUID {
                    taskReqChar = char
                }
                if char.uuid == BLEMeshConstants.taskResponseUUID {
                    taskRespChar = char
                }
            }

            // If this is an outbound task connection and we found both task chars, write the task
            if isOutbound, let reqChar = taskReqChar, let respChar = taskRespChar {
                print("[BLE] found task chars on peer — writing outbound task...")
                writeOutboundTask(peripheral: peripheral, taskReqChar: reqChar, taskRespChar: respChar)
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral,
                                 didUpdateValueFor characteristic: CBCharacteristic,
                                 error: Error?) {
        guard let data = characteristic.value else { return }
        Task { @MainActor in
            if characteristic.uuid == BLEMeshConstants.peerIdentityUUID {
                parsePeerIdentity(data: data, rssi: -60, peripheral: peripheral)
            } else if characteristic.uuid == BLEMeshConstants.taskResponseUUID {
                // This is the response to our outbound task
                handleOutboundTaskResponse(data: data)
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral,
                                 didWriteValueFor characteristic: CBCharacteristic,
                                 error: Error?) {
        if let error = error {
            print("[BLE] write to characteristic failed: \(error.localizedDescription)")
            Task { @MainActor in
                if let cont = outboundTaskContinuation {
                    outboundTaskContinuation = nil
                    cont.resume(returning: (false, "BLE write failed: \(error.localizedDescription)"))
                }
            }
        } else {
            print("[BLE] task request written successfully, waiting for response...")
        }
    }
}

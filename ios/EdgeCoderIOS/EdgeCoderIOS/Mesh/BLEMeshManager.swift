// BLEMeshManager.swift
// EdgeCoderIOS
//
// CoreBluetooth-based mesh manager that handles scanning for nearby
// BLE peers, advertising this device's capabilities, and maintaining
// a live list of discovered peers with automatic stale-peer eviction.
// Supports bidirectional BLE task routing:
//   - Receives task requests via GATT writes, runs local inference, returns results via notify.
//   - Sends task requests to discovered peers (e.g. Mac) by writing to their GATT task char.
//   - #63: after a completed task, the requester sends the final credit transaction back over the
//     same characteristics (`type: "cosign"`); the provider checks it and signs the canonical v3
//     bytes (BLETxV3), the requester adds its signature, and only then is it written to OfflineLedger.

import CoreBluetooth
import CryptoKit
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

/// A task this device served over BLE, kept so it can co-sign the requester's transaction (#63).
private struct ServedBLETask {
    let requesterId: String
    let taskHash: String
    let cpuMillis: Int64
    let servedAt: Date
    var signedTxId: String?
    var signedBytes: Data?
    var signature: String?
}

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
    /// Reward account the coordinator resolves for this agent (from /register); signed into BLE txs.
    var currentAccountId: String?
    /// The Keychain agent key (KeychainEd25519): signs this device's side of BLE credit transactions.
    var signingKey: Curve25519.Signing.PrivateKey?
    /// Tasks served recently, by requestId, for the co-sign step.
    private var servedTasks: [String: ServedBLETask] = [:]
    private static let servedTaskTTL: TimeInterval = 15 * 60
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

    /// Pending outbound exchange: continuation waiting for the reassembled response notify (nil on failure)
    private var outboundTaskContinuation: CheckedContinuation<Data?, Never>?
    private var outboundTaskRequestId: String?
    /// Distinguishes exchanges so a stale timeout cannot cancel a later one
    private var outboundExchangeId: UUID?
    /// JSON written to the peer's task-request characteristic for the current exchange
    private var outboundPayload: Data?
    /// Why the last exchange failed (connect/write errors, timeout)
    private var outboundError: String = ""

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
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            print("[BLE] malformed task request data")
            return
        }
        if json["type"] as? String == "cosign" {
            handleCosignRequest(json, central: central)
            return
        }
        guard let requestId = json["requestId"] as? String,
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
            let cpuMillis = Int64(max(0, result.durationMs))
            let providerId = currentAgentId ?? "unknown"

            if result.ok {
                // #63: remember what we served so we can co-sign the requester's final transaction.
                pruneServedTasks()
                servedTasks[requestId] = ServedBLETask(
                    requesterId: requesterId,
                    taskHash: BLETxV3.sha256Hex(task),
                    cpuMillis: cpuMillis,
                    servedAt: Date()
                )
            }

            let response: [String: Any] = [
                "requestId": requestId,
                "providerId": providerId,
                "providerAccountId": currentAccountId ?? providerId,
                "status": result.ok ? "completed" : "failed",
                "output": result.output,
                "cpuSeconds": Double(cpuMillis) / 1000.0,
                "providerSignature": ""
            ]

            guard let responseData = try? JSONSerialization.data(withJSONObject: response) else {
                print("[BLE] failed to serialize task response")
                return
            }
            sendNotify(responseData, to: central, label: "task \(requestId)")

            await MainActor.run {
                if result.ok { bleTasksCompleted += 1 }
            }
        }
    }

    /// Notify `data` to `central` on the task-response characteristic. Chunked: the first notify is a
    /// 4-byte big-endian length prefix + data, later notifies are continuation data.
    private func sendNotify(_ responseData: Data, to central: CBCentral, label: String) {
        guard let char = taskResponseCharacteristic, let pm = peripheralManager else {
            print("[BLE] no task response characteristic or peripheral manager")
            return
        }
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
        print("[BLE] \(label) response chunk 1/\(totalChunks) (\(firstPacket.count) bytes, total: \(responseData.count), queued: \(sent))")

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
            print("[BLE] \(label) response chunk \(chunkIdx)/\(totalChunks) (\(chunk.count) bytes, queued: \(sent))")
            offset = end
            chunkIdx += 1
        }
    }

    // MARK: - Co-sign (#63)

    private func pruneServedTasks() {
        let cutoff = Date().addingTimeInterval(-Self.servedTaskTTL)
        servedTasks = servedTasks.filter { $0.value.servedAt >= cutoff }
    }

    /// Exact non-negative integer from a JSON number (NSNumber), or nil.
    private static func jsonInt64(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber else { return nil }
        let d = number.doubleValue
        guard d.isFinite, d >= 0, d.rounded() == d, d <= 9_007_199_254_740_991 else { return nil }
        return number.int64Value
    }

    /// Provider side: check the requester's final transaction against the task we served, and sign it.
    private func handleCosignRequest(_ json: [String: Any], central: CBCentral) {
        let requestId = json["requestId"] as? String ?? ""
        let tx = json["tx"] as? [String: Any] ?? [:]
        let txId = tx["txId"] as? String ?? ""

        func reply(_ status: String, signature: String = "", reason: String? = nil) {
            var body: [String: Any] = [
                "type": "cosign_result",
                "requestId": requestId,
                "txId": txId,
                "status": status,
                "providerSignature": signature
            ]
            if let reason { body["reason"] = reason }
            print("[BLE] co-sign \(requestId): \(status)\(reason.map { " (\($0))" } ?? "")")
            if let data = try? JSONSerialization.data(withJSONObject: body) {
                sendNotify(data, to: central, label: "co-sign \(requestId)")
            }
        }

        pruneServedTasks()
        guard let key = signingKey, let agentId = currentAgentId else { return reply("rejected", reason: "no_signing_key") }
        guard var served = servedTasks[requestId] else { return reply("rejected", reason: "unknown_request") }
        guard let requesterId = tx["requesterId"] as? String,
              let requesterAccountId = tx["requesterAccountId"] as? String,
              let providerId = tx["providerId"] as? String,
              let providerAccountId = tx["providerAccountId"] as? String,
              let taskHash = tx["taskHash"] as? String,
              let cpuMillis = Self.jsonInt64(tx["cpuMillis"]),
              let creditMillis = Self.jsonInt64(tx["creditMillis"]) else {
            return reply("rejected", reason: "invalid_field")
        }
        guard providerId == agentId else { return reply("rejected", reason: "provider_mismatch") }
        guard providerAccountId == (currentAccountId ?? agentId) else { return reply("rejected", reason: "provider_account_mismatch") }
        guard requesterId == served.requesterId else { return reply("rejected", reason: "requester_mismatch") }
        guard taskHash == served.taskHash else { return reply("rejected", reason: "task_hash_mismatch") }
        guard cpuMillis == served.cpuMillis else { return reply("rejected", reason: "cpu_mismatch") }
        let expected = BLETxV3.creditMillis(cpuMillis: served.cpuMillis, modelParamSize: currentModelParamSize)
        guard abs(creditMillis - expected) <= BLETxV3.creditToleranceMillis(expected) else {
            return reply("rejected", reason: "credits_out_of_tolerance")
        }
        let fields = BLETxV3Fields(
            txId: txId, requesterId: requesterId, requesterAccountId: requesterAccountId,
            providerId: providerId, providerAccountId: providerAccountId, taskHash: taskHash,
            cpuMillis: cpuMillis, creditMillis: creditMillis
        )
        guard let bytes = try? BLETxV3.canonicalBytes(fields) else { return reply("rejected", reason: "invalid_field") }
        // One task is co-signed for one transaction only; asking again for the same one is idempotent.
        if let signedTxId = served.signedTxId {
            guard signedTxId == txId, served.signedBytes == bytes, let signature = served.signature else {
                return reply("rejected", reason: "already_cosigned")
            }
            return reply("signed", signature: signature)
        }
        guard let signature = try? BLETxV3.sign(fields, with: key) else { return reply("rejected", reason: "sign_failed") }
        served.signedTxId = txId
        served.signedBytes = bytes
        served.signature = signature
        servedTasks[requestId] = served
        reply("signed", signature: signature)
    }

    // MARK: - Outbound BLE Task Sending (send to Mac)

    /// Send a task to a discovered BLE peer. Connects, writes task request,
    /// subscribes to task response, waits for notify with result. A completed task is then settled
    /// with the co-sign step (#63).
    func sendTask(toAgentId agentId: String, prompt: String, tag: String = "") async -> (ok: Bool, output: String) {
        guard let peripheral = peripheralsByAgentId[agentId] else {
            print("[BLE] sendTask: no peripheral for \(agentId)")
            return (false, "No peripheral found for \(agentId)")
        }
        guard centralManager != nil else {
            return (false, "No central manager")
        }

        let requestId = "ble-ios-\(tag)-\(Int(Date().timeIntervalSince1970 * 1000))"
        print("[BLE-TEST] sendTask: connecting to \(agentId) for task \(requestId)...")
        bleTasksSent += 1

        let request: [String: Any] = [
            "requestId": requestId,
            "requesterId": currentAgentId ?? "unknown",
            "task": prompt,
            "language": "python",
            "requesterSignature": ""
        ]
        guard let payload = try? JSONSerialization.data(withJSONObject: request) else {
            return (false, "Failed to serialize task request")
        }

        let result: (ok: Bool, output: String)
        var responseJSON: [String: Any]?
        if let data = await exchange(with: peripheral, payload: payload, requestId: requestId, timeoutSeconds: 90) {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                responseJSON = json
                let status = json["status"] as? String ?? "failed"
                result = (status == "completed", json["output"] as? String ?? "")
                print("[BLE] outbound task response: status=\(status), output=\(result.output.prefix(100))...")
            } else {
                print("[BLE] malformed task response (\(data.count) bytes)")
                result = (false, "Malformed BLE task response")
            }
        } else {
            result = (false, outboundError.isEmpty ? "BLE task failed" : outboundError)
        }

        lastBLETaskResult = result.output
        print("[BLE-TEST] task result from \(agentId): ok=\(result.ok), output=\(result.output.prefix(200))")
        if result.ok, let json = responseJSON {
            await settleCredits(peerAgentId: agentId, peripheral: peripheral, requestId: requestId, prompt: prompt, response: json)
        }
        return result
    }

    /// Requester side of the co-sign step (#63): build the final transaction, have the provider sign
    /// it, add our signature, and record it in the offline ledger only when both signatures exist.
    private func settleCredits(peerAgentId: String, peripheral: CBPeripheral, requestId: String, prompt: String, response: [String: Any]) async {
        guard let key = signingKey, let me = currentAgentId else {
            print("[BLE] no signing key; not recording credits for \(requestId)")
            return
        }
        let cpuMillis = BLETxV3.millis((response["cpuSeconds"] as? NSNumber)?.doubleValue ?? -1)
        let paramSize = discoveredPeers.first(where: { $0.agentId == peerAgentId })?.modelParamSize ?? 0
        let creditMillis = BLETxV3.creditMillis(cpuMillis: cpuMillis, modelParamSize: paramSize)
        guard cpuMillis >= 0, creditMillis > 0 else { return }
        let providerId = response["providerId"] as? String ?? peerAgentId
        let providerAccountId = (response["providerAccountId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? providerId
        let fields = BLETxV3Fields(
            txId: UUID().uuidString.lowercased(),
            requesterId: me,
            requesterAccountId: currentAccountId ?? me,
            providerId: providerId,
            providerAccountId: providerAccountId,
            taskHash: BLETxV3.sha256Hex(prompt),
            cpuMillis: cpuMillis,
            creditMillis: creditMillis
        )
        let requesterSignature: String
        do {
            requesterSignature = try BLETxV3.sign(fields, with: key)
        } catch {
            print("[BLE] cannot sign credits for \(requestId): \(error)")
            return
        }
        let cosign: [String: Any] = [
            "type": "cosign",
            "requestId": requestId,
            "tx": [
                "txId": fields.txId,
                "requesterId": fields.requesterId,
                "requesterAccountId": fields.requesterAccountId,
                "providerId": fields.providerId,
                "providerAccountId": fields.providerAccountId,
                "taskHash": fields.taskHash,
                "cpuMillis": NSNumber(value: fields.cpuMillis),
                "creditMillis": NSNumber(value: fields.creditMillis)
            ] as [String: Any]
        ]
        guard let payload = try? JSONSerialization.data(withJSONObject: cosign),
              let data = await exchange(with: peripheral, payload: payload, requestId: requestId, timeoutSeconds: 30),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            print("[BLE] co-sign exchange with \(peerAgentId) failed: \(outboundError)")
            return
        }
        guard json["type"] as? String == "cosign_result",
              json["status"] as? String == "signed",
              json["txId"] as? String == fields.txId,
              let providerSignature = json["providerSignature"] as? String, !providerSignature.isEmpty else {
            print("[BLE] provider \(peerAgentId) did not co-sign \(requestId): \(json["reason"] as? String ?? "rejected")")
            return
        }
        let recorded = OfflineLedger.shared.record(
            BLECreditTransactionRecord(fields: fields, requesterSignature: requesterSignature, providerSignature: providerSignature)
        )
        print("[BLE] co-signed tx \(fields.txId) (\(fields.creditMillis) credit millis) recorded: \(recorded)")
    }

    /// One request/response round trip with a peer: connect, discover the task characteristics,
    /// subscribe, write `payload`, and wait for the reassembled notify reply (nil on failure/timeout).
    private func exchange(with peripheral: CBPeripheral, payload: Data, requestId: String, timeoutSeconds: UInt64) async -> Data? {
        guard let central = centralManager else {
            outboundError = "No central manager"
            return nil
        }
        // One exchange at a time: fail any exchange still waiting.
        if let previous = outboundTaskContinuation {
            outboundTaskContinuation = nil
            previous.resume(returning: nil)
        }
        let exchangeId = UUID()
        outboundExchangeId = exchangeId
        outboundError = ""
        outboundPayload = payload
        outboundPeripheral = peripheral
        outboundTaskRequestId = requestId
        outboundResponseExpectedLength = -1
        outboundResponseChunks = []
        outboundResponseReceivedBytes = 0

        peripheral.delegate = self
        central.connect(peripheral, options: nil)

        return await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
            outboundTaskContinuation = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: timeoutSeconds * 1_000_000_000)
                guard let self, self.outboundExchangeId == exchangeId, let cont = self.outboundTaskContinuation else { return }
                self.outboundTaskContinuation = nil
                self.outboundTaskRequestId = nil
                self.outboundError = "BLE exchange timeout after \(timeoutSeconds)s"
                if let p = self.outboundPeripheral {
                    self.centralManager?.cancelPeripheralConnection(p)
                    self.outboundPeripheral = nil
                }
                cont.resume(returning: nil)
            }
        }
    }

    /// Fail the pending exchange (connect or write error).
    private func failOutbound(_ message: String) {
        outboundError = message
        if let cont = outboundTaskContinuation {
            outboundTaskContinuation = nil
            outboundTaskRequestId = nil
            cont.resume(returning: nil)
        }
    }

    /// Called when task chars are discovered on the outbound peer: subscribe + write
    private func writeOutboundTask(peripheral: CBPeripheral, taskReqChar: CBCharacteristic, taskRespChar: CBCharacteristic) {
        // Subscribe to response notify first
        peripheral.setNotifyValue(true, for: taskRespChar)

        guard outboundTaskRequestId != nil, let data = outboundPayload else { return }
        print("[BLE] writing to \(peripheral.name ?? "peer") (\(data.count) bytes)...")
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

        if let continuation = outboundTaskContinuation {
            outboundTaskContinuation = nil
            outboundTaskRequestId = nil
            continuation.resume(returning: fullData)
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
                failOutbound("BLE connect failed: \(error?.localizedDescription ?? "unknown")")
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
                failOutbound("BLE write failed: \(error.localizedDescription)")
            }
        } else {
            print("[BLE] task request written successfully, waiting for response...")
        }
    }
}

import Foundation
import CoreBluetooth
import UIKit

// MARK: - IDE Task Model
// Represents one inference request received from a Mac IDE over BLE.

public struct IDETask: Identifiable {
    public let id: String           // UUID matching the BLE request id
    public let prompt: String
    public let startedAt: Date
    public var completedAt: Date?
    public var output: String?
    public var ok: Bool?
    public var durationMs: Int?

    public var status: IDETaskStatus {
        if completedAt != nil {
            return ok == true ? .success : .failed
        }
        return .running
    }
}

public enum IDETaskStatus {
    case running, success, failed
}

// MARK: - BLE service / characteristic UUIDs
// These must match the Mac node worker's Bluetooth implementation.

private let edgeCoderServiceUUID = CBUUID(string: "EC0D-0001-EC0D-EC0D-EC0D-EC0D0001EC0D")

/// Characteristic the Mac writes inference requests to (write without response).
private let requestCharUUID      = CBUUID(string: "EC0D-0002-EC0D-EC0D-EC0D-EC0D0002EC0D")
/// Characteristic the phone updates with inference results (notify).
private let responseCharUUID     = CBUUID(string: "EC0D-0003-EC0D-EC0D-EC0D-EC0D0003EC0D")
/// Characteristic for small status/metadata updates (notify).
private let statusCharUUID       = CBUUID(string: "EC0D-0004-EC0D-EC0D-EC0D-EC0D0004EC0D")

// MARK: - Bluetooth Local Transport
//
// The iPhone acts as a PERIPHERAL (BLE server) advertising EdgeCoder compute.
// A Mac running EdgeCoder IDE mode acts as CENTRAL (BLE client) and discovers
// the phone, then sends inference requests over the requestChar and reads
// results back via the responseChar notify subscription.
//
// Protocol (JSON over BLE, chunked at 512 bytes):
//   Request (Mac → Phone):
//     { "id": "<uuid>", "prompt": "<text>", "maxTokens": 512 }
//   Response (Phone → Mac, notify):
//     { "id": "<uuid>", "output": "<text>", "ok": true, "durationMs": 123 }
//   Status (Phone → Mac, notify):
//     { "modelState": "ready|loading|idle", "batteryPct": 87 }

@MainActor
final class BluetoothTransport: NSObject, ObservableObject {
    static let shared = BluetoothTransport()

    @Published var isAdvertising = false
    @Published var connectedCentralCount = 0
    @Published var btStatusText = "BT idle."
    @Published var btEvents: [String] = []

    /// IDE tasks received over BLE — shown in the IDE tab.
    /// Capped at 50 most recent. Most-recent first.
    @Published var ideTasks: [IDETask] = []

    private var peripheralManager: CBPeripheralManager?
    private var requestCharacteristic: CBMutableCharacteristic?
    private var responseCharacteristic: CBMutableCharacteristic?
    private var statusCharacteristic: CBMutableCharacteristic?
    private var modelManager: LocalModelManager?

    // Fragmented write buffer (BLE MTU is typically 185-512 bytes; we reassemble here)
    private var writeBuffer = Data()
    // Active inference tasks keyed by request id
    private var inFlightTasks: [String: Task<Void, Never>] = [:]

    // MARK: - Start / Stop

    func startPeripheral(agentId: String, modelManager: LocalModelManager) async {
        self.modelManager = modelManager
        if peripheralManager == nil {
            peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
        }
        appendBtEvent("BT peripheral manager created.")
    }

    func stop() async {
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        inFlightTasks.values.forEach { $0.cancel() }
        inFlightTasks.removeAll()
        isAdvertising = false
        btStatusText = "BT stopped."
        appendBtEvent(btStatusText)
    }

    // MARK: - Private helpers

    private func setupAndStartAdvertising(agentId: String) {
        guard let pm = peripheralManager, pm.state == .poweredOn else { return }

        // Build characteristics
        requestCharacteristic = CBMutableCharacteristic(
            type: requestCharUUID,
            properties: [.writeWithoutResponse, .write],
            value: nil,
            permissions: [.writeable]
        )

        responseCharacteristic = CBMutableCharacteristic(
            type: responseCharUUID,
            properties: [.notify, .read],
            value: nil,
            permissions: [.readable]
        )

        statusCharacteristic = CBMutableCharacteristic(
            type: statusCharUUID,
            properties: [.notify, .read],
            value: nil,
            permissions: [.readable]
        )

        let service = CBMutableService(type: edgeCoderServiceUUID, primary: true)
        service.characteristics = [requestCharacteristic!, responseCharacteristic!, statusCharacteristic!]
        pm.add(service)

        // Advertise with a local name including the agent ID (truncated to BLE name limit)
        let shortId = String(agentId.prefix(16))
        pm.startAdvertising([
            CBAdvertisementDataLocalNameKey:    "EdgeCoder-\(shortId)",
            CBAdvertisementDataServiceUUIDsKey: [edgeCoderServiceUUID]
        ])

        isAdvertising = true
        btStatusText = "BT advertising as EdgeCoder-\(shortId)."
        appendBtEvent(btStatusText)

        // Broadcast initial status
        pushStatus()
    }

    private func pushStatus() {
        guard let pm = peripheralManager,
              let statusChar = statusCharacteristic,
              let mm = modelManager else { return }
        let statusDict: [String: Any] = [
            "modelState":  mm.state.rawValue,
            "batteryPct":  UIDevice.current.isBatteryMonitoringEnabled ? Int(max(0, UIDevice.current.batteryLevel) * 100) : -1
        ]
        if let data = try? JSONSerialization.data(withJSONObject: statusDict) {
            pm.updateValue(data, for: statusChar, onSubscribedCentrals: nil)
        }
    }

    private func handleIncomingRequest(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requestId = json["id"] as? String,
              let prompt    = json["prompt"] as? String else {
            appendBtEvent("BT: malformed request received.")
            return
        }
        let maxTokens = json["maxTokens"] as? Int ?? 512
        appendBtEvent("BT: inference request \(requestId.prefix(8))…")

        // Track the incoming task so the IDE view can show it immediately
        let ideTask = IDETask(id: requestId, prompt: prompt, startedAt: Date())
        addIDETask(ideTask)

        let task = Task { [weak self] in
            guard let self, let mm = self.modelManager else { return }
            let startMs = Int(Date().timeIntervalSince1970 * 1000)
            guard mm.state == .ready else {
                let errResponse: [String: Any] = ["id": requestId, "output": "[no model loaded]", "ok": false, "durationMs": 0]
                if let data = try? JSONSerialization.data(withJSONObject: errResponse) {
                    await self.sendResponse(requestId: requestId, data: data)
                }
                await self.completeIDETask(id: requestId, output: "[no model loaded]", ok: false, durationMs: 0)
                return
            }
            await mm.runInference(prompt: prompt)
            let output = mm.lastInferenceOutput
            let durationMs = Int(Date().timeIntervalSince1970 * 1000) - startMs
            let ok = !output.isEmpty && output != "[empty response]"

            let response: [String: Any] = [
                "id":         requestId,
                "output":     output,
                "ok":         ok,
                "durationMs": durationMs
            ]
            if let responseData = try? JSONSerialization.data(withJSONObject: response) {
                await self.sendResponse(requestId: requestId, data: responseData)
            }
            await self.completeIDETask(
                id: requestId,
                output: output,
                ok: ok,
                durationMs: durationMs
            )
            await self.inFlightTasks.removeValue(forKey: requestId)
            await self.appendBtEvent("BT: request \(requestId.prefix(8))… complete (\(durationMs)ms).")
        }
        inFlightTasks[requestId] = task
    }

    // MARK: - IDE Task tracking helpers

    private func addIDETask(_ task: IDETask) {
        ideTasks.insert(task, at: 0)
        if ideTasks.count > 50 { ideTasks = Array(ideTasks.prefix(50)) }
    }

    private func completeIDETask(id: String, output: String, ok: Bool, durationMs: Int) {
        if let idx = ideTasks.firstIndex(where: { $0.id == id }) {
            ideTasks[idx].completedAt = Date()
            ideTasks[idx].output = output
            ideTasks[idx].ok = ok
            ideTasks[idx].durationMs = durationMs
        }
    }

    private func sendResponse(requestId: String, data: Data) async {
        guard let pm = peripheralManager,
              let responseChar = responseCharacteristic else { return }
        // BLE has MTU limits; chunk data in 512-byte pieces if needed.
        let chunkSize = 512
        if data.count <= chunkSize {
            pm.updateValue(data, for: responseChar, onSubscribedCentrals: nil)
        } else {
            var offset = 0
            while offset < data.count {
                let end = min(offset + chunkSize, data.count)
                let chunk = data[offset..<end]
                pm.updateValue(chunk, for: responseChar, onSubscribedCentrals: nil)
                offset = end
                // Small yield between chunks
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }
    }

    private func appendBtEvent(_ message: String) {
        let line = "\(Date().formatted(date: .omitted, time: .standard)) | \(message)"
        btEvents.insert(line, at: 0)
        if btEvents.count > 20 { btEvents = Array(btEvents.prefix(20)) }
    }
}

// MARK: - CBPeripheralManagerDelegate

extension BluetoothTransport: CBPeripheralManagerDelegate {
    nonisolated func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        Task { @MainActor in
            switch peripheral.state {
            case .poweredOn:
                self.appendBtEvent("BT powered on — starting advertising.")
                // We need the agentId from SwarmRuntimeController
                let agentId = SwarmRuntimeController.shared.agentId
                self.setupAndStartAdvertising(agentId: agentId)
            case .poweredOff:
                self.isAdvertising = false
                self.btStatusText = "Bluetooth is off."
                self.appendBtEvent(self.btStatusText)
            case .unauthorized:
                self.btStatusText = "Bluetooth unauthorized — check Settings."
                self.appendBtEvent(self.btStatusText)
            case .unsupported:
                self.btStatusText = "Bluetooth not supported on this device."
                self.appendBtEvent(self.btStatusText)
            default:
                break
            }
        }
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        Task { @MainActor in
            if let error {
                self.appendBtEvent("BT add service failed: \(error.localizedDescription)")
            } else {
                self.appendBtEvent("BT service added.")
            }
        }
    }

    nonisolated func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        Task { @MainActor in
            if let error {
                self.isAdvertising = false
                self.appendBtEvent("BT advertising failed: \(error.localizedDescription)")
            } else {
                self.appendBtEvent("BT advertising started.")
            }
        }
    }

    nonisolated func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didSubscribeTo characteristic: CBCharacteristic
    ) {
        Task { @MainActor in
            self.connectedCentralCount += 1
            self.appendBtEvent("BT central subscribed (\(self.connectedCentralCount) connected).")
            self.pushStatus()
        }
    }

    nonisolated func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didUnsubscribeFrom characteristic: CBCharacteristic
    ) {
        Task { @MainActor in
            self.connectedCentralCount = max(0, self.connectedCentralCount - 1)
            self.appendBtEvent("BT central unsubscribed (\(self.connectedCentralCount) connected).")
        }
    }

    nonisolated func peripheralManager(
        _ peripheral: CBPeripheralManager,
        didReceiveWrite requests: [CBATTRequest]
    ) {
        Task { @MainActor in
            for req in requests {
                guard req.characteristic.uuid == requestCharUUID,
                      let value = req.value else { continue }
                self.writeBuffer.append(value)
                // Try to parse; if it succeeds we have a complete request.
                if let _ = try? JSONSerialization.jsonObject(with: self.writeBuffer) as? [String: Any] {
                    self.handleIncomingRequest(self.writeBuffer)
                    self.writeBuffer = Data()
                }
                // Respond for write-with-response requests
                if req.characteristic.properties.contains(.write) {
                    peripheral.respond(to: req, withResult: .success)
                }
            }
        }
    }
}
